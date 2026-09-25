import test from 'node:test'
import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CLAIM_LEASE_MS, MAX_QUEUED_RUNS_PER_USER, RESULT_RETENTION_DAYS } from '@dsh-ops/cloud-task-contract'
import { CloudError } from '../server/cloud/errors.js'
import { START, cloudFixture, definition } from './cloud-fixture.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const employee = 'w00000001'

test('due tasks become queued runs, nextRunAt advances and the instance is woken', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t)
  const task = db.createTask(employee, definition({ schedule: { kind: 'once', at: new Date(START + 5 * MINUTE).toISOString() } }))
  assert.equal(task.nextRunAt, new Date(START + 5 * MINUTE).toISOString())
  let tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.enqueued, [])
  assert.deepEqual(orchestrator.calls, [])
  clock.advance(5 * MINUTE)
  tick = await runtime.scheduler.tick()
  assert.equal(tick.enqueued.length, 1)
  assert.deepEqual(tick.ensured, [employee])
  assert.deepEqual(orchestrator.calls, [`ensure:${employee}`])
  const env = orchestrator.environments.get(employee)!
  assert.equal(env.DSH_OPS_CLOUD_EXECUTOR, '1')
  assert.equal(env.DSH_OPS_CLOUD_INSTANCE_ID, employee)
  assert.equal(env.DSH_OPS_CLOUD_WEBSITE_URL, 'http://127.0.0.1:4173')
  assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write')
  assert.ok(db.authenticate(env.DSH_OPS_CLOUD_EXECUTOR_TOKEN!, 'executor'), 'launch env carries a valid executor token')
  assert.equal(db.authenticate(env.DSH_OPS_CLOUD_EXECUTOR_TOKEN!, 'user'), undefined, 'executor tokens cannot act as users')
  const after = db.task(employee, task.id)
  assert.equal(after.nextRunAt, null, 'a once schedule does not fire again')
  assert.equal(after.lastRun?.status, 'queued')
  assert.equal(after.lastRun?.trigger, 'schedule')
  assert.equal(after.lastRun?.scheduledAt, new Date(START + 5 * MINUTE).toISOString())
  assert.equal(db.instanceStatus(employee).state, 'running')
  // A second pass neither duplicates the run nor relaunches the running instance.
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.enqueued, [])
  assert.deepEqual(orchestrator.calls, [`ensure:${employee}`])
})

test('interval tasks catch up with one run after downtime and keep the next slot in the future', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const task = db.createTask(employee, definition({ schedule: { kind: 'interval', everyMinutes: 30, anchorAt: new Date(START).toISOString() } }))
  assert.equal(task.nextRunAt, new Date(START + 30 * MINUTE).toISOString())
  clock.advance(3 * HOUR + 5 * MINUTE)
  const tick = await runtime.scheduler.tick()
  assert.equal(tick.enqueued.length, 1)
  assert.equal(db.task(employee, task.id).nextRunAt, new Date(START + 3 * HOUR + 30 * MINUTE).toISOString())
})

test('the per-user queue cap blocks manual runs and leaves due tasks pending', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const task = db.createTask(employee, definition({ schedule: { kind: 'interval', everyMinutes: 1, anchorAt: new Date(START).toISOString() } }))
  for (let index = 0; index < MAX_QUEUED_RUNS_PER_USER; index += 1) db.enqueueRun(employee, task.id, 'manual')
  assert.throws(() => db.enqueueRun(employee, task.id, 'manual'), (error: unknown) => error instanceof CloudError && error.code === 'QUEUE_FULL')
  clock.advance(MINUTE)
  const tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.enqueued, [])
  const due = db.task(employee, task.id)
  assert.equal(due.nextRunAt, new Date(START + MINUTE).toISOString(), 'the slot stays due until the queue drains')
  assert.equal(db.listRuns('other', { limit: 10, offset: 0 }).total, 0)
})

test('expired leases requeue twice and then fail with lease-expired', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  const run = db.enqueueRun(employee, task.id, 'manual')
  for (const attempt of [1, 2]) {
    const claimed = db.claimRun(employee, employee)
    assert.equal(claimed?.run.id, run.id)
    assert.equal(claimed?.leaseMs, CLAIM_LEASE_MS)
    clock.advance(CLAIM_LEASE_MS + 1)
    const tick = await runtime.scheduler.tick()
    assert.deepEqual(tick.requeued, [run.id], `attempt ${attempt} returns to the queue`)
    assert.equal(db.run(employee, run.id).status, 'queued')
    assert.equal(db.run(employee, run.id).claimedAt, undefined)
  }
  const claimed = db.claimRun(employee, employee)
  db.progressRun(employee, run.id, { status: 'running', startedAt: new Date(clock.now()).toISOString() })
  assert.equal(claimed?.run.id, run.id)
  clock.advance(CLAIM_LEASE_MS + 1)
  const tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.failed, [run.id])
  const failed = db.run(employee, run.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.errorCode, 'lease-expired')
  assert.ok(failed.finishedAt)
})

test('heartbeats extend leases of runs the executor still reports', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  const run = db.enqueueRun(employee, task.id, 'manual')
  db.claimRun(employee, employee)
  clock.advance(CLAIM_LEASE_MS - 1000)
  db.heartbeat(employee, { contractVersion: 1, instanceId: employee, bundleVersion: '1.0.0', dshVersion: '0.1.5', catalog: { generatedAt: new Date(clock.now()).toISOString(), defaultExpertId: 'product-default', experts: [] }, runningRunIds: [run.id] })
  clock.advance(CLAIM_LEASE_MS - 1000)
  assert.deepEqual((await runtime.scheduler.tick()).requeued, [])
  assert.equal(db.run(employee, run.id).status, 'claimed')
})

test('queued runs nobody claimed within 24 hours expire', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  const run = db.enqueueRun(employee, task.id, 'manual')
  clock.advance(24 * HOUR + 1)
  const tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.expired, [run.id])
  assert.equal(db.run(employee, run.id).status, 'expired')
})

test('idle instances stop after idleStopMinutes and their executor token is revoked', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t, { idleStopMinutes: 10 })
  const task = db.createTask(employee, definition())
  const run = db.enqueueRun(employee, task.id, 'manual')
  await runtime.scheduler.tick()
  const token = orchestrator.environments.get(employee)!.DSH_OPS_CLOUD_EXECUTOR_TOKEN!
  db.claimRun(employee, employee)
  db.completeRun(employee, run.id, { status: 'succeeded', finishedAt: new Date(clock.now()).toISOString(), summary: '完成', errorCode: '' })
  clock.advance(9 * MINUTE)
  assert.deepEqual((await runtime.scheduler.tick()).stopped, [])
  clock.advance(2 * MINUTE)
  assert.deepEqual((await runtime.scheduler.tick()).stopped, [employee])
  assert.equal(db.instanceStatus(employee).state, 'stopped')
  assert.equal(db.authenticate(token, 'executor'), undefined)
  assert.ok(orchestrator.calls.includes(`stop:${employee}`))
  // New work relaunches with a fresh token.
  db.enqueueRun(employee, task.id, 'manual')
  await runtime.scheduler.tick()
  assert.notEqual(orchestrator.environments.get(employee)!.DSH_OPS_CLOUD_EXECUTOR_TOKEN, token)
  assert.equal(db.instanceStatus(employee).state, 'running')
})

test('an orchestrator failure is recorded on the instance and retried only after the backoff', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  db.enqueueRun(employee, task.id, 'manual')
  orchestrator.failNext = new Error('docker: image dsh-ops-cloud:test not found')
  await runtime.scheduler.tick()
  const failed = db.instance(employee)!
  assert.equal(failed.state, 'error')
  assert.match(failed.lastError ?? '', /image dsh-ops-cloud:test not found/)
  assert.equal(orchestrator.calls.filter(call => call.startsWith('ensure:')).length, 1)
  clock.advance(MINUTE)
  await runtime.scheduler.tick()
  assert.equal(orchestrator.calls.filter(call => call.startsWith('ensure:')).length, 1, 'no retry inside the backoff window')
  clock.advance(5 * MINUTE)
  await runtime.scheduler.tick()
  assert.equal(orchestrator.calls.filter(call => call.startsWith('ensure:')).length, 2)
  assert.equal(db.instanceStatus(employee).state, 'running')
})

test('a launch that dies before readiness enters backoff instead of being respawned every pass', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t)
  const ensures = () => orchestrator.calls.filter(call => call.startsWith('ensure:')).length
  orchestrator.launchState = { state: 'starting', backendRef: '4711', port: 3400 }
  const task = db.createTask(employee, definition())
  db.enqueueRun(employee, task.id, 'manual')
  await runtime.scheduler.tick()
  assert.equal(ensures(), 1)
  assert.equal(db.instanceStatus(employee).state, 'starting')
  const firstToken = orchestrator.environments.get(employee)!.DSH_OPS_CLOUD_EXECUTOR_TOKEN!
  // The process exits during startup: the backend reports error with the log tail.
  orchestrator.states.set(employee, { state: 'error', backendRef: '4711', port: 3400, error: 'exited during startup (exit code 1)\nError: plugin dependency closure broken' })
  clock.advance(30_000)
  await runtime.scheduler.tick()
  assert.equal(ensures(), 1, 'the failure is recorded, not retried immediately')
  const failed = db.instance(employee)!
  assert.equal(failed.state, 'error')
  assert.match(failed.lastError ?? '', /exited during startup \(exit code 1\)/)
  assert.match(failed.lastError ?? '', /plugin dependency closure broken/)
  assert.equal(db.authenticate(firstToken, 'executor'), undefined, 'the executor token of the dead launch is revoked')
  for (let index = 0; index < 8; index += 1) { clock.advance(30_000); await runtime.scheduler.tick() }
  assert.equal(ensures(), 1, 'no respawn during the 5 minute backoff')
  assert.equal(db.instanceStatus(employee).state, 'error')
  clock.advance(60_000)
  await runtime.scheduler.tick()
  assert.equal(ensures(), 2, 'one relaunch after the backoff')
  assert.equal(db.instanceStatus(employee).state, 'starting')
  assert.equal(db.instance(employee)!.lastError, null)
  assert.notEqual(orchestrator.environments.get(employee)!.DSH_OPS_CLOUD_EXECUTOR_TOKEN, firstToken)
})

test('an instance that dies after readiness is relaunched next pass, but three deaths in a row back off', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t)
  const ensures = () => orchestrator.calls.filter(call => call.startsWith('ensure:')).length
  const task = db.createTask(employee, definition())
  db.enqueueRun(employee, task.id, 'manual')
  await runtime.scheduler.tick()
  assert.equal(db.instanceStatus(employee).state, 'running')
  const die = () => orchestrator.states.set(employee, { state: 'stopped', error: 'exited unexpectedly (exit code 2)\nfatal: RangeError' })
  for (const attempt of [1, 2]) {
    die(); clock.advance(30_000)
    await runtime.scheduler.tick()
    assert.equal(ensures(), attempt, `death ${attempt} is recorded first`)
    assert.equal(db.instance(employee)!.state, 'stopped')
    assert.match(db.instance(employee)!.lastError ?? '', /exited unexpectedly \(exit code 2\)/)
    clock.advance(30_000)
    await runtime.scheduler.tick()
    assert.equal(ensures(), attempt + 1, `death ${attempt} is followed by a relaunch on the next pass`)
    assert.equal(db.instanceStatus(employee).state, 'running')
  }
  die(); clock.advance(30_000)
  await runtime.scheduler.tick()
  assert.equal(db.instance(employee)!.state, 'error', 'the third consecutive death enters backoff')
  clock.advance(30_000)
  await runtime.scheduler.tick()
  assert.equal(ensures(), 3, 'no relaunch inside the backoff')
  clock.advance(5 * 60_000)
  await runtime.scheduler.tick()
  assert.equal(ensures(), 4)
  assert.equal(db.instanceStatus(employee).state, 'running')
  // Once a pass has seen the relaunched instance running the streak resets: one more death is again just "stopped".
  clock.advance(30_000)
  await runtime.scheduler.tick()
  die(); clock.advance(30_000)
  await runtime.scheduler.tick()
  assert.equal(db.instance(employee)!.state, 'stopped')
})

test('a crash is detected even when no run is waiting, without clearing the reason', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  const run = db.enqueueRun(employee, task.id, 'manual')
  await runtime.scheduler.tick()
  db.claimRun(employee, employee)
  db.completeRun(employee, run.id, { status: 'succeeded', finishedAt: new Date(clock.now()).toISOString(), summary: '', errorCode: '' })
  orchestrator.states.set(employee, { state: 'error', backendRef: 'fake', error: 'container exited with exit code 137' })
  clock.advance(30_000)
  await runtime.scheduler.tick()
  const record = db.instance(employee)!
  assert.equal(record.state, 'error')
  assert.equal(record.lastError, 'container exited with exit code 137')
  assert.equal(db.instanceStatus(employee).state, 'error', 'the user API sees the state only')
  assert.ok(!orchestrator.calls.includes(`stop:${employee}`), 'a dead instance is not idle-stopped over its failure record')
})

test('maintenance drops finished runs older than the retention window together with their artifacts', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  const old = db.enqueueRun(employee, task.id, 'manual')
  db.claimRun(employee, employee)
  const artifact = path.join(runtime.artifacts.directory, `${old.id}.zip`)
  await writeFile(artifact, 'zip')
  db.attachArtifact(employee, old.id, { size: 3, sha256: 'a'.repeat(64), fileCount: 1 })
  db.completeRun(employee, old.id, { status: 'succeeded', finishedAt: new Date(clock.now()).toISOString(), summary: '', errorCode: '' })
  clock.advance((RESULT_RETENTION_DAYS + 1) * 24 * HOUR)
  const recent = db.enqueueRun(employee, task.id, 'manual')
  await runtime.maintain()
  assert.throws(() => db.run(employee, old.id), (error: unknown) => error instanceof CloudError && error.code === 'NOT_FOUND')
  await assert.rejects(access(artifact))
  assert.equal(db.run(employee, recent.id).status, 'queued')
})

test('task deletion cancels queued runs but refuses while a run is executing', async t => {
  const { db, clock } = await cloudFixture(t)
  const task = db.createTask(employee, definition())
  const queued = db.enqueueRun(employee, task.id, 'manual')
  clock.advance(1)
  const running = db.enqueueRun(employee, task.id, 'manual')
  // Claims are FIFO by queue time, so the older run is the one handed out.
  assert.equal(db.claimRun(employee, employee)?.run.id, queued.id)
  assert.throws(() => db.deleteTask(employee, task.id), (error: unknown) => error instanceof CloudError && error.code === 'TASK_RUNNING')
  db.completeRun(employee, queued.id, { status: 'cancelled', finishedAt: new Date(START).toISOString(), summary: '', errorCode: '' })
  db.deleteTask(employee, task.id)
  assert.equal(db.run(employee, running.id).status, 'cancelled')
  assert.throws(() => db.task(employee, task.id), (error: unknown) => error instanceof CloudError && error.code === 'NOT_FOUND')
  assert.throws(() => db.task('someone-else', task.id), (error: unknown) => error instanceof CloudError && error.code === 'NOT_FOUND')
})
