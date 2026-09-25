import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DockerOrchestrator, containerName, instanceHome } from '../server/cloud/orchestrator.js'

type Container = { Id: string; Name: string; Config: { Image: string; User?: string; Env: string[]; Labels: Record<string, string> }; HostConfig: Record<string, unknown>; State: { Status: string; Running: boolean; ExitCode?: number } }
type Network = { Id: string; Name: string; Driver: string; Labels: Record<string, string>; Options: Record<string, string>; Containers: Record<string, { Name: string }> }
test('instance paths reject dot identities before touching the filesystem or Docker', () => {
  for (const employeeId of ['.', '..', '../other', 'user/child', 'user\\child']) {
    assert.throws(() => instanceHome('/srv/cloud', employeeId))
    assert.throws(() => containerName(employeeId))
  }
  assert.equal(instanceHome('/srv/cloud', 'w.123'), path.join('/srv/cloud', 'instances', 'w.123', 'home'))
})
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : undefined }

/** Minimal Docker Engine API impostor on a unix socket / Windows named pipe. */
async function fakeDocker(t: TestContext) {
  const containers = new Map<string, Container>()
  const networks = new Map<string, Network>()
  const calls: string[] = []
  const behaviour = { stopStatus: 204, startStatus: 204, missingImage: false }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://docker')
    calls.push(`${req.method} ${url.pathname}${url.search}`)
    const reply = (status: number, value?: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    const byRef = (ref: string) => [...containers.values()].find(c => c.Id === ref || c.Name === `/${ref}`)
    const networkByRef = (ref: string) => [...networks.values()].find(network => network.Id === ref || network.Name === ref)
    if (req.method === 'POST' && url.pathname === '/networks/create') {
      const payload = await body(req) as { Name: string; Driver: string; Labels: Record<string, string>; Options: Record<string, string> }
      if (networkByRef(payload.Name)) return reply(409, { message: 'network already exists' })
      const network: Network = { ...payload, Id: randomUUID().replaceAll('-', ''), Containers: {} }
      networks.set(network.Id, network)
      return reply(201, { Id: network.Id, Warning: '' })
    }
    const networkMatch = /^\/networks\/([^/]+)$/.exec(url.pathname)
    if (networkMatch) {
      const network = networkByRef(decodeURIComponent(networkMatch[1]!))
      if (!network) return reply(404, { message: 'network not found' })
      if (req.method === 'GET') return reply(200, network)
      if (req.method === 'DELETE') {
        if (Object.keys(network.Containers).length) return reply(409, { message: 'network has active endpoints' })
        networks.delete(network.Id); return reply(204)
      }
    }
    const match = /^\/containers\/([^/]+)(?:\/(json|start|stop|kill))?$/.exec(url.pathname)
    if (req.method === 'POST' && url.pathname === '/containers/create') {
      const payload = await body(req) as { Image: string; User?: string; Env: string[]; Labels: Record<string, string>; HostConfig: Record<string, unknown> }
      if (behaviour.missingImage) return reply(404, { message: `No such image: ${payload.Image}` })
      const name = url.searchParams.get('name')!
      if (byRef(name)) return reply(409, { message: `Conflict. The container name "/${name}" is already in use` })
      const container: Container = { Id: randomUUID().replaceAll('-', ''), Name: `/${name}`, Config: { Image: payload.Image, ...(payload.User ? { User: payload.User } : {}), Env: payload.Env, Labels: payload.Labels }, HostConfig: payload.HostConfig, State: { Status: 'created', Running: false } }
      containers.set(container.Id, container)
      return reply(201, { Id: container.Id, Warnings: [] })
    }
    if (!match) return reply(404, { message: 'page not found' })
    const container = byRef(decodeURIComponent(match[1]!))
    if (!container) return reply(404, { message: 'No such container' })
    if (req.method === 'GET' && match[2] === 'json') return reply(200, container)
    if (req.method === 'DELETE' && !match[2]) { containers.delete(container.Id); for (const network of networks.values()) delete network.Containers[container.Id]; return reply(204) }
    if (req.method === 'POST' && match[2] === 'start') { if (behaviour.startStatus !== 204) return reply(behaviour.startStatus, { message: 'failed to start' }); if (container.State.Running) return reply(304); container.State = { Status: 'running', Running: true }; const network = networkByRef(String(container.HostConfig.NetworkMode)); if (network) network.Containers[container.Id] = { Name: container.Name }; return reply(204) }
    if (req.method === 'POST' && match[2] === 'stop') { if (behaviour.stopStatus !== 204) return reply(behaviour.stopStatus, { message: 'cannot stop' }); container.State = { Status: 'exited', Running: false, ExitCode: 0 }; return reply(204) }
    if (req.method === 'POST' && match[2] === 'kill') { container.State = { Status: 'exited', Running: false, ExitCode: 137 }; return reply(204) }
    return reply(405, { message: 'method not allowed' })
  })
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-ops-fake-docker-${randomUUID()}` : path.join(await mkdtemp(path.join(tmpdir(), 'fake-docker-')), 'docker.sock')
  server.listen(socketPath); await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); if (process.platform !== 'win32') await rm(path.dirname(socketPath), { recursive: true, force: true }) })
  return { socketPath, containers, networks, calls, behaviour }
}

test('docker orchestrator creates, starts, reuses, recreates and stops per-user containers over the engine socket', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const extraHosts = ['host.docker.internal:host-gateway']
  const orchestrator = new DockerOrchestrator({ socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 1024, cpus: 1.5, network: 'bridge', instancePort: 3080, directory, extraHosts })
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
  assert.match(String(created.HostConfig.NetworkMode), /^dsh-ops-cloud-net-[0-9a-f]{12}-w1$/)
  assert.equal(docker.networks.size, 1)
  assert.equal([...docker.networks.values()][0]!.Options['com.docker.network.bridge.enable_icc'], 'false')
  assert.deepEqual(created.HostConfig.ExtraHosts, extraHosts)
  assert.equal(created.HostConfig.SecurityOpt, undefined, 'native mode retains Docker defaults')
  assert.deepEqual(await orchestrator.inspect('w1'), { state: 'running', backendRef: created.Id })
  const callsBefore = docker.calls.length
  const again = await orchestrator.ensureRunning('w1', { DSH_OPS_CLOUD_EXECUTOR_TOKEN: 'token-two' })
  assert.equal(again.backendRef, created.Id, 'a running container is reused, not recreated')
  assert.equal(docker.calls.length, callsBefore + 1)
  await orchestrator.stop('w1')
  assert.equal(docker.networks.size, 0, 'stopping an instance also removes its empty managed network')
  assert.ok(docker.calls.includes(`DELETE /containers/${containerName('w1')}?force=true&v=true`), 'a deliberate stop removes the container and anonymous volumes, preserving its bind home')
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
  assert.ok(docker.calls.includes(`DELETE /containers/${second.Id}?force=true&v=true`))
  assert.equal(docker.containers.size, 1)
  await orchestrator.stop('missing')
  assert.ok(docker.calls.at(-1)!.startsWith('GET /networks/'), 'stopping an unknown user only inspects its empty network')
})

test('bubblewrap uses the reviewed seccomp extension with no capabilities and a read-only root', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const orchestrator = new DockerOrchestrator({ socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 512, cpus: 1, network: 'bridge', instancePort: 3080, directory, sandbox: 'bubblewrap' })
  await orchestrator.ensureRunning('w8', {})
  const { HostConfig: config } = [...docker.containers.values()][0]!
  assert.equal([...docker.containers.values()][0]!.Config.User, '1000:1000', 'bubblewrap remains non-root even if another image has a root default')
  assert.deepEqual(config.CapDrop, ['ALL'])
  assert.equal(config.Privileged, false)
  assert.equal(config.ReadonlyRootfs, true)
  assert.deepEqual(config.MaskedPaths, ['/sys/firmware'])
  assert.deepEqual(config.ReadonlyPaths, [])
  assert.deepEqual(config.Tmpfs, { '/tmp': 'rw,exec,nosuid,nodev,size=128m,mode=1777' })
  const options = config.SecurityOpt as string[]
  assert.equal(options.length, 2)
  assert.equal(options[0], 'no-new-privileges=true')
  assert.ok(options[1]!.startsWith('seccomp={'))
  const seccomp = JSON.parse(options[1]!.slice('seccomp='.length)) as { defaultAction: string; syscalls: { names: string[]; action: string }[] }
  assert.equal(createHash('sha256').update(JSON.stringify(seccomp)).digest('hex'), '5ebaddc3fd4104283573c2aa3b14e6c650c0c10735d1cc2c3a44b63d26200c7e', 'the entire profile must match the reviewed Docker probe')
  assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO')
  assert.deepEqual(seccomp.syscalls.at(-1), { names: ['clone', 'unshare', 'mount', 'umount2', 'pivot_root'], action: 'SCMP_ACT_ALLOW' })
  assert.ok(!options.includes('seccomp=unconfined'))
})

test('default bridge instances use separate owned networks, while configured networks remain externally managed', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = { socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 512, cpus: 1, network: 'bridge', instancePort: 3080, directory }
  const orchestrator = new DockerOrchestrator(options)
  await orchestrator.ensureRunning('tenant-a', {})
  await orchestrator.ensureRunning('tenant-b', {})
  assert.equal(docker.networks.size, 2)
  assert.equal(new Set([...docker.containers.values()].map(container => container.HostConfig.NetworkMode)).size, 2)
  for (const network of docker.networks.values()) assert.equal(Object.keys(network.Containers).length, 1)
  const first = [...docker.networks.values()].find(network => network.Labels['dsh-ops.cloud.employee'] === 'tenant-a')!
  await orchestrator.stop('tenant-a')
  first.Containers = {}; first.Labels['dsh-ops.cloud.employee'] = 'someone-else'; docker.networks.set(first.Id, first)
  await assert.rejects(orchestrator.ensureRunning('tenant-a', {}), /network .*belongs to another/)
  await assert.rejects(orchestrator.stop('tenant-a'), /network .*belongs to another/)
  assert.equal(docker.networks.size, 2, 'a foreign network must not be deleted')
  const external = new DockerOrchestrator({ ...options, network: 'operator-managed' })
  await external.ensureRunning('tenant-c', {})
  assert.equal([...docker.containers.values()].find(container => container.Name.endsWith('tenant-c'))!.HostConfig.NetworkMode, 'operator-managed')
  await external.stop('tenant-c')
  assert.equal(docker.networks.size, 2, 'external networks are never created or deleted by the website')
})

test('a Docker start failure is visible as an error and can be recreated on retry', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const orchestrator = new DockerOrchestrator({ socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 512, cpus: 1, network: 'bridge', instancePort: 3080, directory })
  docker.behaviour.startStatus = 500
  await assert.rejects(orchestrator.ensureRunning('w5', {}), /failed to start/)
  assert.equal((await orchestrator.inspect('w5')).state, 'error', 'a never-started container must not remain starting forever')
  docker.behaviour.startStatus = 204
  assert.equal((await orchestrator.ensureRunning('w5', {})).state, 'running')
})

test('another website data directory cannot adopt or delete this website instance', async t => {
  const docker = await fakeDocker(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'cloud-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = { socketPath: docker.socketPath, image: 'dsh-ops-cloud:test', memoryMb: 512, cpus: 1, network: 'bridge', instancePort: 3080, directory }
  const owner = new DockerOrchestrator(options)
  await owner.ensureRunning('w6', {})
  const other = new DockerOrchestrator({ ...options, directory: path.join(directory, 'other-website') })
  await assert.rejects(other.ensureRunning('w6', {}), /belongs to another/)
  await assert.rejects(other.stop('w6'), /belongs to another/)
  assert.equal((await owner.inspect('w6')).state, 'running')
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
