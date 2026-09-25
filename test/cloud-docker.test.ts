import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DockerOrchestrator, containerName } from '../server/cloud/orchestrator.js'

type Container = { Id: string; Name: string; Config: { Image: string; Env: string[]; Labels: Record<string, string> }; HostConfig: Record<string, unknown>; State: { Status: string; Running: boolean; ExitCode?: number } }
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : undefined }

/** Minimal Docker Engine API impostor on a unix socket / Windows named pipe. */
async function fakeDocker(t: TestContext) {
  const containers = new Map<string, Container>()
  const calls: string[] = []
  const behaviour = { stopStatus: 204, missingImage: false }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://docker')
    calls.push(`${req.method} ${url.pathname}${url.search}`)
    const reply = (status: number, value?: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    const byRef = (ref: string) => [...containers.values()].find(c => c.Id === ref || c.Name === `/${ref}`)
    const match = /^\/containers\/([^/]+)(?:\/(json|start|stop|kill))?$/.exec(url.pathname)
    if (req.method === 'POST' && url.pathname === '/containers/create') {
      const payload = await body(req) as { Image: string; Env: string[]; Labels: Record<string, string>; HostConfig: Record<string, unknown> }
      if (behaviour.missingImage) return reply(404, { message: `No such image: ${payload.Image}` })
      const name = url.searchParams.get('name')!
      if (byRef(name)) return reply(409, { message: `Conflict. The container name "/${name}" is already in use` })
      const container: Container = { Id: randomUUID().replaceAll('-', ''), Name: `/${name}`, Config: { Image: payload.Image, Env: payload.Env, Labels: payload.Labels }, HostConfig: payload.HostConfig, State: { Status: 'created', Running: false } }
      containers.set(container.Id, container)
      return reply(201, { Id: container.Id, Warnings: [] })
    }
    if (!match) return reply(404, { message: 'page not found' })
    const container = byRef(decodeURIComponent(match[1]!))
    if (!container) return reply(404, { message: 'No such container' })
    if (req.method === 'GET' && match[2] === 'json') return reply(200, container)
    if (req.method === 'DELETE' && !match[2]) { containers.delete(container.Id); return reply(204) }
    if (req.method === 'POST' && match[2] === 'start') { if (container.State.Running) return reply(304); container.State = { Status: 'running', Running: true }; return reply(204) }
    if (req.method === 'POST' && match[2] === 'stop') { if (behaviour.stopStatus !== 204) return reply(behaviour.stopStatus, { message: 'cannot stop' }); container.State = { Status: 'exited', Running: false, ExitCode: 0 }; return reply(204) }
    if (req.method === 'POST' && match[2] === 'kill') { container.State = { Status: 'exited', Running: false, ExitCode: 137 }; return reply(204) }
    return reply(405, { message: 'method not allowed' })
  })
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-ops-fake-docker-${randomUUID()}` : path.join(await mkdtemp(path.join(tmpdir(), 'fake-docker-')), 'docker.sock')
  server.listen(socketPath); await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); if (process.platform !== 'win32') await rm(path.dirname(socketPath), { recursive: true, force: true }) })
  return { socketPath, containers, calls, behaviour }
}

test('docker orchestrator creates, starts, reuses, recreates and stops per-user containers over the engine socket', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const orchestrator = new DockerOrchestrator({ socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 1024, cpus: 1.5, network: 'bridge', instancePort: 3080, directory })
  assert.deepEqual(await orchestrator.inspect('w1'), { state: 'stopped' })
  const first = await orchestrator.ensureRunning('w1', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'token-one', DSH_OPS_CLOUD_INSTANCE_ID: 'w1' })
  assert.equal(first.state, 'running')
  const created = [...docker.containers.values()][0]!
  assert.equal(first.backendRef, created.Id)
  assert.equal(created.Name, `/${containerName('w1')}`)
  assert.equal(created.Config.Image, 'dsh-ops-cloud:test')
  assert.ok(created.Config.Env.includes('DSH_OPS_CLOUD_EXECUTOR_TOKEN=token-one'))
  assert.ok(created.Config.Env.includes('DSH_HOME=/data/home'))
  assert.ok(created.Config.Env.includes('DSH_OPS_CLOUD_INSTANCE_PORT=3080'))
  assert.deepEqual(created.Config.Labels, { 'dsh-ops.cloud.employee': 'w1', 'dsh-ops.cloud.role': 'instance' })
  assert.deepEqual(created.HostConfig.Binds, [`${path.join(directory, 'instances', 'w1', 'home')}:/data/home`])
  assert.equal(created.HostConfig.Memory, 1024 * 1024 * 1024)
  assert.equal(created.HostConfig.NanoCpus, 1_500_000_000)
  assert.equal(created.HostConfig.NetworkMode, 'bridge')
  assert.deepEqual(await orchestrator.inspect('w1'), { state: 'running', backendRef: created.Id })
  const callsBefore = docker.calls.length
  const again = await orchestrator.ensureRunning('w1', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'token-two' })
  assert.equal(again.backendRef, created.Id, 'a running container is reused, not recreated')
  assert.equal(docker.calls.length, callsBefore + 1)
  await orchestrator.stop('w1')
  assert.ok(docker.calls.includes(`DELETE /containers/${containerName('w1')}?force=true`), 'a deliberate stop removes the container')
  assert.deepEqual(await orchestrator.inspect('w1'), { state: 'stopped' })
  const relaunched = await orchestrator.ensureRunning('w1', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'token-three' })
  assert.notEqual(relaunched.backendRef, created.Id, 'a stopped container is recreated so the new token reaches the executor')
  assert.equal(docker.containers.size, 1)
  const second = [...docker.containers.values()][0]!
  assert.ok(second.Config.Env.includes('DSH_OPS_CLOUD_EXECUTOR_TOKEN=token-three'))
  // A container that died on its own (not removed by us) is a failure, and the next launch recreates it.
  second.State = { Status: 'exited', Running: false, ExitCode: 1 }
  assert.deepEqual(await orchestrator.inspect('w1'), { state: 'error', backendRef: second.Id, error: 'container exited with exit code 1' })
  const third = await orchestrator.ensureRunning('w1', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'token-four' })
  assert.notEqual(third.backendRef, second.Id)
  assert.ok(docker.calls.includes(`DELETE /containers/${second.Id}?force=true`))
  assert.equal(docker.containers.size, 1)
  await orchestrator.stop('missing')
  assert.ok(docker.calls.at(-1)!.startsWith('POST /containers/dsh-ops-cloud-missing/stop'), 'stopping an unknown user is a no-op 404')
})

test('docker orchestrator escalates to kill when stop fails and reports a missing image clearly', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const orchestrator = new DockerOrchestrator({ socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 512, cpus: 1, network: 'none', instancePort: 3080, directory })
  await orchestrator.ensureRunning('w2', {})
  docker.behaviour.stopStatus = 500
  await orchestrator.stop('w2')
  assert.ok(docker.calls.includes(`POST /containers/${containerName('w2')}/kill`))
  assert.equal((await orchestrator.inspect('w2')).state, 'stopped')
  docker.behaviour.missingImage = true
  await assert.rejects(orchestrator.ensureRunning('w3', {}), /image dsh-ops-cloud:test not found/)
  const unreachable = new DockerOrchestrator({ socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\dsh-ops-no-such-docker' : path.join(directory, 'missing.sock'), image: 'x', memoryMb: 512, cpus: 1, network: 'bridge', instancePort: 3080, directory, requestTimeoutMs: 2000 })
  await assert.rejects(unreachable.inspect('w4'), (error: Error) => !/token/.test(error.message))
})
