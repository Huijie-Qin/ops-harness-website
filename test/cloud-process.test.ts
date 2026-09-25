import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProcessOrchestrator } from '../server/cloud/orchestrator.js'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A stand-in product repository: sync-content + _shared.mjs + a fake dsh CLI that behaves like the real entry points. */
async function fakeProductRepo(root: string) {
  const repo = path.join(root, 'product repo')
  await mkdir(path.join(repo, 'scripts'), { recursive: true })
  await writeFile(path.join(repo, 'scripts', 'sync-content.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
if (process.env.DSH_OPS_ALLOW_EXTERNAL_HOME !== '1') { console.error('external home refused'); process.exit(2) }
mkdirSync(process.env.DSH_OPS_HOME, { recursive: true })
writeFileSync(path.join(process.env.DSH_OPS_HOME, 'sync-content.json'), JSON.stringify({ cwd: process.cwd() }))
`)
  await writeFile(path.join(repo, 'scripts', '_shared.mjs'), `export const webProfilePluginSources = Object.freeze(['${path.join(repo, 'packages', 'a').replaceAll('\\', '\\\\')}', 'dsh-better-sidebar@0.19.1'])\n`)
  const entry = path.join(repo, 'fake-dsh.mjs')
  await writeFile(entry, `
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const home = process.env.DSH_HOME
if (process.argv[2] === 'plugin') {
  mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{}')
  writeFileSync(path.join(home, 'plugin-add.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
  process.exit(0)
}
const port = process.argv[process.argv.indexOf('--port') + 1]
writeFileSync(path.join(home, 'launch.json'), JSON.stringify({ args: process.argv.slice(2), env: { DSH_HOME: home, token: process.env.DSH_OPS_CLOUD_EXECUTOR_TOKEN, executor: process.env.DSH_OPS_CLOUD_EXECUTOR, website: process.env.DSH_OPS_CLOUD_WEBSITE_URL } }))
const mode = process.env.FAKE_DSH_MODE ?? 'normal'
console.log('starting fake runtime')
if (mode === 'crash-at-start') {
  // A real crash would echo its environment; the orchestrator must not leak it.
  console.error('Error: plugin dependency closure broken while loading overlay; env DSH_OPS_CLOUD_EXECUTOR_TOKEN=' + process.env.DSH_OPS_CLOUD_EXECUTOR_TOKEN + ' Bearer ' + process.env.DSH_OPS_CLOUD_EXECUTOR_TOKEN)
  process.exit(1)
}
if (mode !== 'hang') setTimeout(() => {
  console.log('dsh web: http://127.0.0.1:' + port + '/?launch=fake-token')
  if (mode === 'crash-after-ready') setTimeout(() => { console.error('fatal: RangeError in scheduled task loop'); process.exit(2) }, 200)
}, 100)
setInterval(() => {}, 1000)
`)
  return { repo, entry }
}
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) { if (Date.now() > deadline) throw new Error('condition not met in time'); await new Promise(resolve => setTimeout(resolve, 50)) }
}
async function fakeOrchestrator(t: Parameters<Parameters<typeof test>[1]>[0], prefix: string, options: { startupTimeoutMs?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const { repo, entry } = await fakeProductRepo(root)
  const directory = path.join(root, 'cloud')
  const orchestrator = new ProcessOrchestrator({ directory, productRepo: repo, dshEntry: entry, overlays: [], nodeExecutable: '', portRangeStart: 3960, bootstrap: false, ...options })
  // Stop the runtimes (their cwd is inside root) before the directory goes away, or Windows reports EBUSY.
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }) })
  return { orchestrator, directory }
}

test('process orchestrator bootstraps a home once, launches DSH with the instance environment and kills the tree on stop', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud process '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { repo, entry } = await fakeProductRepo(root)
  const directory = path.join(root, 'cloud')
  const overlay = path.join(repo, 'cloud overlay.patch.yml')
  const orchestrator = new ProcessOrchestrator({ directory, productRepo: repo, dshEntry: entry, overlays: [overlay], nodeExecutable: '', portRangeStart: 3900 })
  t.after(() => orchestrator.close())
  const home = path.join(directory, 'instances', 'w7', 'home')
  const launched = await orchestrator.ensureRunning('w7', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'secret-token', DSH_OPS_CLOUD_EXECUTOR: '1', DSH_OPS_CLOUD_WEBSITE_URL: 'http://127.0.0.1:4173' })
  assert.equal(launched.state, 'starting')
  assert.ok(launched.port! >= 3900)
  const pid = Number(launched.backendRef)
  assert.ok(alive(pid))
  const synced = JSON.parse(await readFile(path.join(home, 'sync-content.json'), 'utf8')) as { cwd: string }
  assert.equal(synced.cwd, await realpath(repo))
  const added = JSON.parse(await readFile(path.join(home, 'plugin-add.json'), 'utf8')) as { args: string[]; cwd: string }
  assert.deepEqual(added.args, ['plugin', '--profile', 'web', 'add', '--allow-build=node-pty', path.join(repo, 'packages', 'a'), 'dsh-better-sidebar@0.19.1'])
  assert.equal(added.cwd, await realpath(repo))
  const ready = await orchestrator.waitUntilReady('w7', 20_000)
  assert.equal(ready.state, 'running')
  assert.equal(ready.launchUrl, `http://127.0.0.1:${launched.port}/?launch=fake-token`)
  const launch = JSON.parse(await readFile(path.join(home, 'launch.json'), 'utf8')) as { args: string[]; env: Record<string, string> }
  assert.deepEqual(launch.args, ['--profile', 'web', '--patch', overlay, '--no-open', '--port', String(launched.port)])
  assert.deepEqual(launch.env, { DSH_HOME: home, token: 'secret-token', executor: '1', website: 'http://127.0.0.1:4173' })
  const log = await readFile(path.join(directory, 'instances', 'w7', 'instance.log'), 'utf8')
  assert.match(log, /starting fake runtime/)
  assert.ok(!log.includes('secret-token'), 'the executor token never reaches the instance log')
  assert.equal((await orchestrator.ensureRunning('w7', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'other' })).backendRef, String(pid), 'a live instance is reused')
  await orchestrator.stop('w7')
  assert.equal(alive(pid), false)
  assert.deepEqual(await orchestrator.inspect('w7'), { state: 'stopped' })
  // Second launch skips bootstrap because the profile already exists.
  await rm(path.join(home, 'plugin-add.json'))
  const relaunched = await orchestrator.ensureRunning('w7', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'second' })
  assert.notEqual(relaunched.backendRef, String(pid))
  await assert.rejects(access(path.join(home, 'plugin-add.json')))
  await orchestrator.waitUntilReady('w7', 20_000)
  await orchestrator.close()
  assert.equal(alive(Number(relaunched.backendRef)), false)
})

test('a runtime that exits before readiness is a startup failure with a redacted log tail', async t => {
  const { orchestrator, directory } = await fakeOrchestrator(t, 'cloud-process-crash-')
  const launched = await orchestrator.ensureRunning('w9', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'secret-token-value-1234', FAKE_DSH_MODE: 'crash-at-start' })
  assert.equal(launched.state, 'starting')
  await assert.rejects(orchestrator.waitUntilReady('w9', 20_000), /exited during startup \(exit code 1\)/)
  await until(async () => (await orchestrator.inspect('w9')).error?.includes('plugin dependency closure') ?? false)
  const failed = await orchestrator.inspect('w9')
  assert.equal(failed.state, 'error')
  assert.match(failed.error!, /^exited during startup \(exit code 1\)\n/)
  assert.match(failed.error!, /starting fake runtime/)
  assert.match(failed.error!, /plugin dependency closure broken/)
  assert.ok(!failed.error!.includes('secret-token-value-1234'), 'the executor token never reaches last_error')
  assert.match(failed.error!, /DSH_OPS_CLOUD_EXECUTOR_TOKEN=\[redacted\] Bearer \[redacted\]/)
  await until(async () => (await readFile(path.join(directory, 'instances', 'w9', 'instance.log'), 'utf8')).includes('closure broken'))
  const log = await readFile(path.join(directory, 'instances', 'w9', 'instance.log'), 'utf8')
  assert.ok(!log.includes('secret-token-value-1234'), 'the executor token never reaches the instance log')
  assert.equal(alive(Number(launched.backendRef)), false)
  // The failure does not block a later, deliberate relaunch.
  const relaunched = await orchestrator.ensureRunning('w9', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'second-token-value-1234' })
  assert.equal(relaunched.state, 'starting')
  assert.notEqual(relaunched.backendRef, launched.backendRef)
  assert.equal((await orchestrator.waitUntilReady('w9', 20_000)).state, 'running')
})

test('a runtime that dies after readiness reads as stopped with the exit reason', async t => {
  const { orchestrator } = await fakeOrchestrator(t, 'cloud-process-died-')
  const launched = await orchestrator.ensureRunning('w10', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'secret-token-value-1234', FAKE_DSH_MODE: 'crash-after-ready' })
  assert.equal((await orchestrator.waitUntilReady('w10', 20_000)).state, 'running')
  await until(async () => (await orchestrator.inspect('w10')).state !== 'running')
  await until(async () => (await orchestrator.inspect('w10')).error?.includes('RangeError') ?? false)
  const dead = await orchestrator.inspect('w10')
  assert.equal(dead.state, 'stopped')
  assert.match(dead.error!, /^exited unexpectedly \(exit code 2\)\n/)
  assert.match(dead.error!, /fatal: RangeError in scheduled task loop/)
  assert.equal(alive(Number(launched.backendRef)), false)
  assert.notEqual((await orchestrator.ensureRunning('w10', { FAKE_DSH_MODE: 'normal' })).backendRef, launched.backendRef, 'a dead instance is relaunched, not reused')
})

test('a runtime that never prints readiness is killed after startupTimeoutMs', async t => {
  const { orchestrator } = await fakeOrchestrator(t, 'cloud-process-hang-', { startupTimeoutMs: 700 })
  const launched = await orchestrator.ensureRunning('w11', { FAKE_DSH_MODE: 'hang' })
  await assert.rejects(orchestrator.waitUntilReady('w11', 10_000), /did not print the "dsh web:" readiness line within 700 ms/)
  await until(() => !alive(Number(launched.backendRef)))
  const timedOut = await orchestrator.inspect('w11')
  assert.equal(timedOut.state, 'error')
  assert.match(timedOut.error!, /readiness line within 700 ms; killed/)
  assert.match(timedOut.error!, /starting fake runtime/)
  // A deliberate stop after the timeout is a no-op and leaves no process behind.
  await orchestrator.stop('w11')
  assert.deepEqual(await orchestrator.inspect('w11'), { state: 'stopped' })
})

test('process orchestrator surfaces a broken entry point instead of hanging', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-process-broken-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { repo } = await fakeProductRepo(root)
  const orchestrator = new ProcessOrchestrator({ directory: path.join(root, 'cloud'), productRepo: repo, dshEntry: path.join(repo, 'missing-entry.mjs'), overlays: [], nodeExecutable: '', portRangeStart: 3950 })
  t.after(() => orchestrator.close())
  await assert.rejects(orchestrator.ensureRunning('w8', {}), /fake-dsh|missing-entry|failed/)
  assert.throws(() => new ProcessOrchestrator({ directory: root, productRepo: '', dshEntry: '', overlays: [], nodeExecutable: '', portRangeStart: 3400 }), /productRepo/)
})
