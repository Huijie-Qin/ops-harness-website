import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import { CLAIM_LEASE_MS, CONTRACT_VERSION, cloudRoutes, type CloudRun, type CloudTask } from '@dsh-ops/cloud-task-contract'
import { createCloudHandlers } from '../server/cloud/http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { GuideStore } from '../server/guide-store.js'
import { START, cloudFixture, definition } from './cloud-fixture.js'

const employee = 'w00000042'
type Fixture = Awaited<ReturnType<typeof httpFixture>>
async function httpFixture(t: TestContext, enabled = true) {
  const cloud = enabled ? await cloudFixture(t) : undefined
  const handlers = createCloudHandlers(cloud?.runtime, { executorPollMs: 2500, now: cloud?.clock.now })
  let origin = ''
  let guide: Awaited<ReturnType<typeof createGuideHandler>>
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin)
    if (await handlers.api(req, res, url) || await guide(req, res, url)) return
    res.writeHead(404); res.end()
  })
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  guide = await createGuideHandler(new GuideStore(path.resolve('content/guide'), path.join(cloud?.root ?? path.resolve('.runtime'), `content-${(server.address() as { port: number }).port}`)), { origin, password: 'test-admin-password-only', admin: handlers.admin })
  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'test-admin-password-only' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const csrf = (await login.json() as { csrf: string }).csrf
  const admin = (pathname: string, init: { method?: string; data?: unknown } = {}) => fetch(origin + pathname, {
    method: init.method ?? 'GET', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: origin, ...(init.data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: init.data === undefined ? undefined : JSON.stringify(init.data),
  })
  const api = (pathname: string, token: string | undefined, init: { method?: string; data?: unknown; headers?: Record<string, string>; body?: BodyInit } = {}) => fetch(origin + pathname, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
    body: init.data === undefined ? init.body : JSON.stringify(init.data),
  })
  const issue = async (id = employee) => {
    const response = await admin('/api/admin/cloud/tokens', { method: 'POST', data: { employeeId: id, label: 'laptop' } })
    assert.equal(response.status, 201)
    return await response.json() as { token: string; record: { hashPrefix: string; kind: string; employeeId: string } }
  }
  return { origin, cloud, admin, api, issue }
}
const error = async (response: Response) => (await response.json() as { error: string }).error

test('the first catalog request wakes an empty instance, while a cached catalog preserves idle sleep', async t => {
  const f = await httpFixture(t)
  const { token } = await f.issue()
  const { db, runtime, orchestrator, clock } = f.cloud!
  assert.deepEqual(await (await f.api(cloudRoutes.catalog, token)).json(), { catalog: null, stale: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(orchestrator.calls, [`ensure:${employee}`], 'a new user can discover experts before creating their first task')
  const catalog = { generatedAt: new Date(clock.now()).toISOString(), defaultExpertId: 'product-default', experts: [] }
  db.heartbeat(employee, { contractVersion: CONTRACT_VERSION, instanceId: employee, bundleVersion: '1.0.0', dshVersion: '0.1.5', catalog, runningRunIds: [] })
  await runtime.instances.stop(employee)
  const count = orchestrator.calls.length
  assert.deepEqual(await (await f.api(cloudRoutes.catalog, token)).json(), { catalog, stale: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(orchestrator.calls.length, count, 'polling cached experts must not wake a sleeping instance')
})

test('everything under /api/cloud returns CLOUD_NOT_ENABLED when the feature is off, admin endpoints too', async t => {
  const f = await httpFixture(t, false)
  const me = await f.api(cloudRoutes.me, 'a'.repeat(40))
  assert.equal(me.status, 503); assert.equal(await error(me), 'CLOUD_NOT_ENABLED')
  const tokens = await f.admin('/api/admin/cloud/tokens')
  assert.equal(tokens.status, 503); assert.equal(await error(tokens), 'CLOUD_NOT_ENABLED')
})

test('user tokens are issued once in plaintext, authenticate Host requests, and can be revoked', async t => {
  const f = await httpFixture(t)
  assert.equal((await f.api(cloudRoutes.me, undefined)).status, 401)
  assert.equal((await f.api(cloudRoutes.me, 'b'.repeat(40))).status, 401)
  assert.equal((await f.admin('/api/admin/cloud/tokens', { method: 'POST', data: { employeeId: 'Not Valid!', label: 'x' } })).status, 400)
  for (const employeeId of ['.', '..']) assert.equal((await f.admin('/api/admin/cloud/tokens', { method: 'POST', data: { employeeId, label: 'invalid path' } })).status, 400)
  const issued = await f.issue()
  assert.match(issued.token, /^[A-Za-z0-9_-]{32,128}$/)
  assert.equal(issued.record.kind, 'user'); assert.equal(issued.record.employeeId, employee)
  assert.equal(issued.record.hashPrefix, createHash('sha256').update(issued.token).digest('hex').slice(0, 12))
  const list = await (await f.admin('/api/admin/cloud/tokens')).json() as { tokens: Record<string, unknown>[] }
  assert.equal(list.tokens.length, 1)
  assert.ok(!JSON.stringify(list).includes(issued.token), 'the plaintext token is never listed')
  const me = await f.api(cloudRoutes.me, issued.token)
  assert.equal(me.status, 200)
  assert.deepEqual(await me.json(), { contractVersion: CONTRACT_VERSION, employeeId: employee, displayName: '', instance: { state: 'stopped', updatedAt: new Date(START).toISOString() } })
  assert.equal((await f.api(cloudRoutes.me, issued.token, { headers: { Origin: f.origin } })).status, 403)
  assert.equal((await f.api(cloudRoutes.me, issued.token, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403)
  assert.equal((await f.api(cloudRoutes.me, issued.token, { method: 'POST', data: {} })).status, 405)
  assert.equal((await f.api(`${cloudRoutes.tasks}/not-a-task`, issued.token)).status, 404)
  assert.equal((await f.api(cloudRoutes.executorClaim, issued.token, { method: 'POST', data: { instanceId: employee } })).status, 401, 'user tokens cannot call executor routes')
  const revoked = await f.admin(`/api/admin/cloud/tokens/${issued.record.hashPrefix}`, { method: 'DELETE', data: {} })
  assert.equal(revoked.status, 200)
  assert.equal((await f.api(cloudRoutes.me, issued.token)).status, 401)
  assert.equal((await f.admin('/api/admin/cloud/tokens/000000000000', { method: 'DELETE', data: {} })).status, 404)
})

test('task CRUD enforces the contract, revisions and ownership', async t => {
  const f = await httpFixture(t)
  const { token } = await f.issue()
  const other = await f.issue('w00000043')
  const invalid = await f.api(cloudRoutes.tasks, token, { method: 'POST', data: { ...definition(), extra: true } })
  assert.equal(invalid.status, 400); assert.equal(await error(invalid), 'INVALID_REQUEST')
  const past = await f.api(cloudRoutes.tasks, token, { method: 'POST', data: definition({ schedule: { kind: 'once', at: '2020-01-01T00:00:00.000Z' } }) })
  assert.equal(past.status, 400)
  const created = await f.api(cloudRoutes.tasks, token, { method: 'POST', data: definition() })
  assert.equal(created.status, 201)
  const { task } = await created.json() as { task: CloudTask }
  assert.match(task.id, /^ct_[0-9a-f]{32}$/)
  assert.equal(task.revision, 1); assert.equal(task.state, 'scheduled'); assert.equal(task.employeeId, employee)
  assert.equal(task.nextRunAt, new Date(START + 3_600_000).toISOString())
  assert.deepEqual(((await (await f.api(cloudRoutes.tasks, token)).json()) as { tasks: CloudTask[] }).tasks.map(item => item.id), [task.id])
  assert.deepEqual(((await (await f.api(cloudRoutes.tasks, other.token)).json()) as { tasks: CloudTask[] }).tasks, [], 'tasks are scoped to the token owner')
  assert.equal((await f.api(cloudRoutes.task(task.id), other.token)).status, 404)
  const conflict = await f.api(cloudRoutes.task(task.id), token, { method: 'PUT', data: { expectedRevision: 7, definition: definition({ name: '改名' }) } })
  assert.equal(conflict.status, 409); assert.equal(await error(conflict), 'REVISION_CONFLICT')
  const updated = await f.api(cloudRoutes.task(task.id), token, { method: 'PUT', data: { expectedRevision: 1, definition: definition({ name: '改名' }) } })
  assert.equal(updated.status, 200)
  const renamed = (await updated.json() as { task: CloudTask }).task
  assert.equal(renamed.name, '改名'); assert.equal(renamed.revision, 2)
  const paused = (await (await f.api(cloudRoutes.taskState(task.id), token, { method: 'POST', data: { expectedRevision: 2, state: 'paused' } })).json() as { task: CloudTask }).task
  assert.equal(paused.state, 'paused'); assert.equal(paused.nextRunAt, null); assert.equal(paused.revision, 3)
  const resumed = (await (await f.api(cloudRoutes.taskState(task.id), token, { method: 'POST', data: { expectedRevision: 3, state: 'scheduled' } })).json() as { task: CloudTask }).task
  assert.equal(resumed.state, 'scheduled'); assert.equal(resumed.nextRunAt, new Date(START + 3_600_000).toISOString())
  const manual = await f.api(cloudRoutes.taskRun(task.id), token, { method: 'POST' })
  assert.equal(manual.status, 201)
  const { run } = await manual.json() as { run: CloudRun }
  assert.equal(run.status, 'queued'); assert.equal(run.trigger, 'manual'); assert.equal(run.taskName, '改名')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(f.cloud!.orchestrator.calls, [`ensure:${employee}`], 'a manual run wakes the instance immediately')
  const list = await (await f.api(`${cloudRoutes.runs}?taskId=${task.id}&limit=5`, token)).json() as { runs: CloudRun[]; total: number }
  assert.equal(list.total, 1); assert.equal(list.runs[0]?.id, run.id)
  assert.equal((await f.api(`${cloudRoutes.runs}?bogus=1`, token)).status, 400)
  assert.equal((await f.api(cloudRoutes.run(run.id), other.token)).status, 404)
  const cancelled = (await (await f.api(cloudRoutes.runCancel(run.id), token, { method: 'POST' })).json() as { run: CloudRun }).run
  assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.finishedAt)
  assert.equal((await f.api(cloudRoutes.runArtifact(run.id), token)).status, 404)
  assert.equal((await f.api(cloudRoutes.task(task.id), token, { method: 'DELETE' })).status, 204)
  assert.equal((await f.api(cloudRoutes.task(task.id), token)).status, 404)
  assert.equal((await f.api(cloudRoutes.run(run.id), token)).status, 200, 'run history outlives the task')
})

test('executor lifecycle: heartbeat, claim, progress, artifact round trip and completion', async t => {
  const f = await httpFixture(t)
  const { clock, db, orchestrator } = f.cloud!
  const { token } = await f.issue()
  const task = (await (await f.api(cloudRoutes.tasks, token, { method: 'POST', data: definition() })).json() as { task: CloudTask }).task
  const queued = (await (await f.api(cloudRoutes.taskRun(task.id), token, { method: 'POST' })).json() as { run: CloudRun }).run
  await f.cloud!.runtime.scheduler.tick()
  const executor = orchestrator.environments.get(employee)!.DSH_OPS_CLOUD_EXECUTOR_TOKEN!
  assert.equal((await f.api(cloudRoutes.me, executor)).status, 401, 'executor tokens cannot call user routes')
  const catalog = { generatedAt: new Date(clock.now()).toISOString(), defaultExpertId: 'product-default', experts: [{ id: 'product-default', presetId: 'product-default', name: '默认专家', summary: '', available: true, skills: [{ name: 'daily-brief', description: '晨报' }] }] }
  const heartbeat = (runningRunIds: string[] = []) => ({ contractVersion: CONTRACT_VERSION, instanceId: employee, bundleVersion: '1.2.3', dshVersion: '0.1.5-rc.3', catalog, runningRunIds })
  const mismatch = await f.api(cloudRoutes.executorHeartbeat, executor, { method: 'POST', data: { ...heartbeat(), contractVersion: 2 } })
  assert.equal(mismatch.status, 409); assert.equal(await error(mismatch), 'CONTRACT_VERSION_MISMATCH')
  assert.equal((await f.api(cloudRoutes.executorHeartbeat, executor, { method: 'POST', data: { ...heartbeat(), instanceId: 'w00000099' } })).status, 403)
  const beat = await f.api(cloudRoutes.executorHeartbeat, executor, { method: 'POST', data: heartbeat() })
  assert.equal(beat.status, 200)
  assert.deepEqual(await beat.json(), { cancelRunIds: [], pollIntervalMs: 2500, drain: false })
  const me = await (await f.api(cloudRoutes.me, token)).json() as { instance: { state: string; bundleVersion?: string; dshVersion?: string; lastHeartbeatAt?: string } }
  assert.equal(me.instance.state, 'running'); assert.equal(me.instance.bundleVersion, '1.2.3'); assert.equal(me.instance.dshVersion, '0.1.5-rc.3'); assert.ok(me.instance.lastHeartbeatAt)
  assert.deepEqual(await (await f.api(cloudRoutes.catalog, token)).json(), { catalog, stale: false })
  const claim = await f.api(cloudRoutes.executorClaim, executor, { method: 'POST', data: { instanceId: employee } })
  assert.equal(claim.status, 200)
  const claimed = await claim.json() as { run: CloudRun; definition: Record<string, unknown>; leaseMs: number }
  assert.equal(claimed.run.id, queued.id); assert.equal(claimed.run.status, 'claimed'); assert.equal(claimed.leaseMs, CLAIM_LEASE_MS)
  assert.equal(claimed.definition.prompt, definition().prompt)
  assert.equal((await f.api(cloudRoutes.executorClaim, executor, { method: 'POST', data: { instanceId: employee } })).status, 204)
  const progress = await f.api(cloudRoutes.executorProgress(queued.id), executor, { method: 'POST', data: { status: 'running', startedAt: new Date(clock.now()).toISOString(), sessionId: 'session-1' } })
  assert.equal(progress.status, 200)
  assert.equal((await progress.json() as { run: CloudRun }).run.status, 'running')
  // Cancellation of a running run is delivered through the heartbeat.
  const cancel = (await (await f.api(cloudRoutes.runCancel(queued.id), token, { method: 'POST' })).json() as { run: CloudRun }).run
  assert.equal(cancel.status, 'running'); assert.equal(cancel.cancelRequested, true)
  assert.deepEqual((await (await f.api(cloudRoutes.executorHeartbeat, executor, { method: 'POST', data: heartbeat([queued.id]) })).json() as { cancelRunIds: string[] }).cancelRunIds, [queued.id])
  const bytes = Buffer.from('PK\u0003\u0004 fake zip payload for the artifact round trip', 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const upload = (body: Buffer, sha: string) => f.api(cloudRoutes.executorArtifact(queued.id), executor, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Artifact-Sha256': sha, 'X-Artifact-File-Count': '2' }, body })
  const wrong = await upload(bytes, 'f'.repeat(64))
  assert.equal(wrong.status, 400); assert.equal(await error(wrong), 'ARTIFACT_MISMATCH')
  assert.equal((await (await f.api(cloudRoutes.run(queued.id), token)).json() as { run: CloudRun }).run.artifact, undefined)
  assert.equal((await f.api(cloudRoutes.executorArtifact(queued.id), executor, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Artifact-Sha256': 'zzz' }, body: bytes })).status, 400)
  const stored = await upload(bytes, sha256)
  assert.equal(stored.status, 200)
  assert.deepEqual((await stored.json() as { run: CloudRun }).run.artifact, { size: bytes.length, sha256, fileCount: 2 })
  const inconsistent = await f.api(cloudRoutes.executorComplete(queued.id), executor, { method: 'POST', data: { status: 'succeeded', finishedAt: new Date(clock.now()).toISOString(), summary: '', errorCode: '', artifact: { size: 1, sha256, fileCount: 2 } } })
  assert.equal(inconsistent.status, 409); assert.equal(await error(inconsistent), 'ARTIFACT_MISMATCH')
  const wrongCount = await f.api(cloudRoutes.executorComplete(queued.id), executor, { method: 'POST', data: { status: 'succeeded', finishedAt: new Date(clock.now()).toISOString(), summary: '', errorCode: '', artifact: { size: bytes.length, sha256, fileCount: 3 } } })
  assert.equal(wrongCount.status, 409, 'completion cannot rewrite uploaded file-count metadata')
  const completion = await f.api(cloudRoutes.executorComplete(queued.id), executor, { method: 'POST', data: { status: 'succeeded', finishedAt: new Date(clock.now()).toISOString(), summary: '晨报已生成', errorCode: '', autoDecisions: 3, artifact: { size: bytes.length, sha256, fileCount: 2 } } })
  assert.equal(completion.status, 200)
  const finished = (await completion.json() as { run: CloudRun }).run
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.summary, '晨报已生成'); assert.equal(finished.autoDecisions, 3); assert.equal(finished.sessionId, 'session-1')
  assert.equal((await f.api(cloudRoutes.executorComplete(queued.id), executor, { method: 'POST', data: { status: 'failed', finishedAt: new Date(clock.now()).toISOString() } })).status, 409, 'terminal runs cannot be completed twice')
  assert.equal(db.task(employee, task.id).lastRun?.status, 'succeeded')
  const download = await f.api(cloudRoutes.runArtifact(queued.id), token)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('x-artifact-sha256'), sha256)
  assert.equal(download.headers.get('x-artifact-file-count'), '2')
  assert.equal(download.headers.get('etag'), `"${sha256}"`)
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''cr_[0-9a-f]{32}\.zip$/)
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(bytes))
  assert.equal((await f.api(cloudRoutes.runArtifact(queued.id), token, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 304)
  // Admin views: instances hide the executor token hash, runs list the user's history.
  const instances = await (await f.admin('/api/admin/cloud/instances')).json() as { instances: Record<string, unknown>[] }
  assert.equal(instances.instances[0]?.employeeId, employee); assert.equal(instances.instances[0]?.state, 'running')
  assert.equal('executorTokenHash' in instances.instances[0]!, false)
  const runs = await (await f.admin(`/api/admin/cloud/runs?employeeId=${employee}&limit=10`)).json() as { runs: CloudRun[] }
  assert.deepEqual(runs.runs.map(run => run.id), [queued.id])
  const stopped = await f.admin(`/api/admin/cloud/instances/${employee}/stop`, { method: 'POST', data: {} })
  assert.equal(stopped.status, 200)
  assert.equal((await stopped.json() as { instance: { state: string } }).instance.state, 'stopped')
  assert.equal((await f.api(cloudRoutes.executorHeartbeat, executor, { method: 'POST', data: heartbeat() })).status, 401, 'stopping revokes the executor token')
  assert.deepEqual(await (await f.api(cloudRoutes.catalog, token)).json(), { catalog, stale: true })
})
