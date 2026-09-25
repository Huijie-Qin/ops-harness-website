import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstanceState } from './types.js'
import { describeFailure } from './errors.js'

export type InstanceEnvironment = Record<string, string>
/**
 * Backend view of one user's instance. `error` carries a short diagnostic when the backend itself knows why the
 * instance is not alive: `state: 'error'` = it never became ready (crashed during startup, startup timeout, exited
 * container); `state: 'stopped'` + `error` = it was ready once and then died outside our control.
 */
export type OrchestratorState = { state: InstanceState; backendRef?: string; port?: number; launchUrl?: string; error?: string }
export interface Orchestrator {
  readonly backend: 'docker' | 'process'
  /** Make sure the user's instance is alive; a fresh launch receives `env` (executor token included). */
  ensureRunning(employeeId: string, env: InstanceEnvironment, signal?: AbortSignal): Promise<OrchestratorState>
  stop(employeeId: string): Promise<void>
  inspect(employeeId: string): Promise<OrchestratorState>
  /** Website shutdown hook. */
  close(): Promise<void>
}
export const containerName = (employeeId: string) => `dsh-ops-cloud-${employeeId}`
export const instanceHome = (directory: string, employeeId: string) => path.join(directory, 'instances', employeeId, 'home')

/** Strip credentials from instance output before it reaches `last_error` or the instance log. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let result = text
  for (const secret of secrets) if (secret.length >= 8) result = result.split(secret).join('[redacted]')
  return result
    .replace(/(Bearer\s+)[A-Za-z0-9_-]{16,}/g, '$1[redacted]')
    .replace(/([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=)\S+/g, '$1[redacted]')
}

// ── Docker Engine API over a unix socket / Windows named pipe ─────────────
export type DockerOptions = { socketPath: string; image: string; memoryMb: number; cpus: number; network: string; instancePort: number; directory: string; requestTimeoutMs?: number }
export class DockerError extends Error { constructor(public status: number, message: string) { super(message) } }
type DockerResponse = { status: number; body: unknown }

export class DockerOrchestrator implements Orchestrator {
  readonly backend = 'docker' as const
  constructor(private options: DockerOptions) {}
  private request(method: string, pathname: string, body?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 15_000, signal?: AbortSignal): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest({
        socketPath: this.options.socketPath, method, path: pathname, timeout: timeoutMs, signal,
        headers: { Host: 'docker', ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
      }, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) { req.destroy(new DockerError(502, 'docker response too large')); return } chunks.push(chunk) })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = undefined
          if (text) { try { parsed = JSON.parse(text) } catch { parsed = text } }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new DockerError(504, 'docker request timed out')))
      req.on('error', error => reject(error instanceof DockerError ? error : new DockerError(502, describeFailure(error))))
      req.end(payload)
    })
  }
  private static message(response: DockerResponse) {
    const body = response.body as { message?: unknown } | string | undefined
    return typeof body === 'object' && body && typeof body.message === 'string' ? body.message : typeof body === 'string' ? body : `docker status ${response.status}`
  }
  private async container(employeeId: string, signal?: AbortSignal) {
    const response = await this.request('GET', `/containers/${encodeURIComponent(containerName(employeeId))}/json`, undefined, undefined, signal)
    if (response.status === 404) return undefined
    if (response.status !== 200) throw new DockerError(response.status, DockerOrchestrator.message(response))
    const info = response.body as { Id: string; State?: { Status?: string; Running?: boolean; ExitCode?: number } }
    return { id: info.Id, status: String(info.State?.Status ?? ''), running: Boolean(info.State?.Running), exitCode: Number(info.State?.ExitCode ?? 0) }
  }
  private static state(status: string, running: boolean): InstanceState {
    if (running || status === 'running') return 'running'
    if (status === 'restarting' || status === 'created') return 'starting'
    if (status === 'removing') return 'stopping'
    // We remove the containers we stop ourselves, so one that is still around but not running died on its own.
    if (status === 'exited' || status === 'dead') return 'error'
    return 'stopped'
  }
  async inspect(employeeId: string): Promise<OrchestratorState> {
    const container = await this.container(employeeId)
    if (!container) return { state: 'stopped' }
    const state = DockerOrchestrator.state(container.status, container.running)
    return { state, backendRef: container.id, ...(state === 'error' ? { error: `container ${container.status} with exit code ${container.exitCode}` } : {}) }
  }
  async ensureRunning(employeeId: string, env: InstanceEnvironment, signal?: AbortSignal): Promise<OrchestratorState> {
    const existing = await this.container(employeeId, signal)
    if (existing?.running) return { state: 'running', backendRef: existing.id }
    // A stopped container still carries the previous executor token in its env: recreate instead of restarting.
    if (existing) {
      const removed = await this.request('DELETE', `/containers/${existing.id}?force=true`, undefined, undefined, signal)
      if (removed.status !== 204 && removed.status !== 404) throw new DockerError(removed.status, DockerOrchestrator.message(removed))
    }
    const home = instanceHome(this.options.directory, employeeId)
    await mkdir(home, { recursive: true })
    const created = await this.request('POST', `/containers/create?name=${encodeURIComponent(containerName(employeeId))}`, {
      Image: this.options.image,
      Env: Object.entries({ ...env, DSH_HOME: '/data/home', DSH_OPS_CLOUD_INSTANCE_PORT: String(this.options.instancePort) }).map(([key, value]) => `${key}=${value}`),
      Labels: { 'dsh-ops.cloud.employee': employeeId, 'dsh-ops.cloud.role': 'instance' },
      HostConfig: {
        Binds: [`${home}:/data/home`], Memory: this.options.memoryMb * 1024 * 1024, NanoCpus: Math.round(this.options.cpus * 1e9),
        NetworkMode: this.options.network, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
    }, undefined, signal)
    if (created.status === 404) throw new DockerError(404, `image ${this.options.image} not found`)
    if (created.status !== 201) throw new DockerError(created.status, DockerOrchestrator.message(created))
    const id = String((created.body as { Id: string }).Id)
    const started = await this.request('POST', `/containers/${id}/start`, undefined, undefined, signal)
    if (started.status !== 204 && started.status !== 304) throw new DockerError(started.status, DockerOrchestrator.message(started))
    return { state: 'running', backendRef: id }
  }
  /** Graceful stop, kill on failure, then remove: a deliberately stopped instance reads back as absent, not as a crash. */
  async stop(employeeId: string): Promise<void> {
    const name = encodeURIComponent(containerName(employeeId))
    let stopped: DockerResponse | undefined
    try { stopped = await this.request('POST', `/containers/${name}/stop?t=10`, undefined, 25_000) } catch { stopped = undefined }
    if (stopped?.status === 404) return
    if (!stopped || ![204, 304].includes(stopped.status)) {
      const killed = await this.request('POST', `/containers/${name}/kill`)
      if (![204, 304, 404, 409].includes(killed.status)) throw new DockerError(killed.status, DockerOrchestrator.message(killed))
    }
    const removed = await this.request('DELETE', `/containers/${name}?force=true`)
    if (![204, 404].includes(removed.status)) throw new DockerError(removed.status, DockerOrchestrator.message(removed))
  }
  async close() { /* containers outlive the website process */ }
}

// ── Local child processes (development / integration) ─────────────────────
export type ProcessOptions = {
  directory: string; productRepo: string; dshEntry: string; overlays: string[]; nodeExecutable: string; portRangeStart: number
  /** Run sync-content + plugin install before the first launch of a home (default true). */
  bootstrap?: boolean
  bootstrapTimeoutMs?: number
  /** Kill the instance when no `dsh web:` readiness line appears within this time (default 3 minutes). */
  startupTimeoutMs?: number
  log?: ((line: string) => void) | undefined
}
type ProcessInstance = { child: ChildProcess; port: number; state: InstanceState; launchUrl?: string | undefined; error?: string | undefined; exited: Promise<void>; ready: Promise<void> }
const READY_PATTERN = /dsh web:\s*(\S+)/u
const LOG_TAIL_LINES = 20
const MAX_ERROR_CHARS = 2000
const SECRET_ENV = /TOKEN|KEY|SECRET|PASSWORD/i

function lineReader(onLine: (line: string) => void) {
  let partial = ''
  return {
    push(chunk: Buffer) { partial += chunk.toString('utf8'); const lines = partial.split(/\r?\n/); partial = lines.pop() ?? ''; for (const line of lines) onLine(line) },
    flush() { if (partial) { onLine(partial); partial = '' } },
  }
}

export class ProcessOrchestrator implements Orchestrator {
  readonly backend = 'process' as const
  private instances = new Map<string, ProcessInstance>()
  private launching = new Map<string, Promise<OrchestratorState>>()
  constructor(private options: ProcessOptions) {
    if (!options.productRepo) throw new Error('cloud.process.productRepo is required for the process orchestrator')
  }
  private get node() { return this.options.nodeExecutable || process.execPath }
  private async entry(): Promise<string> {
    if (this.options.dshEntry) return this.options.dshEntry
    const manifest = createRequire(path.join(this.options.productRepo, 'apps/desktop/package.json')).resolve('@deepseek-ai/dsh/package.json')
    const metadata = JSON.parse(await readFile(manifest, 'utf8')) as { bin?: { dsh?: string } }
    if (typeof metadata.bin?.dsh !== 'string') throw new Error('@deepseek-ai/dsh has no dsh bin')
    return path.resolve(path.dirname(manifest), metadata.bin.dsh)
  }
  private exec(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    return new Promise<void>((resolve, reject) => {
      execFile(file, args, { cwd, env, windowsHide: true, timeout: this.options.bootstrapTimeoutMs ?? 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`${path.basename(args[0] ?? file)} failed: ${String(stderr).trim().slice(-400) || describeFailure(error)}`))
        else resolve()
      })
    })
  }
  /** First launch of a home: seed experts/content, then install the product web profile plugins (same steps as pnpm local:bootstrap). */
  private async bootstrap(home: string, dshEntry: string) {
    if (existsSync(path.join(home, 'profiles', 'web', 'package.json'))) return
    const repo = this.options.productRepo
    const base = { ...process.env, DSH_HOME: home, DSH_OPS_LOG_DIR: path.join(home, 'logs'), DSH_TELEMETRY_DISABLED: '1' }
    this.options.log?.(`bootstrap ${home}`)
    await this.exec(this.node, [path.join(repo, 'scripts', 'sync-content.mjs')], { ...base, DSH_OPS_HOME: home, DSH_OPS_ALLOW_EXTERNAL_HOME: '1' }, repo)
    const shared = await import(pathToFileURL(path.join(repo, 'scripts', '_shared.mjs')).href) as { webProfilePluginSources: readonly string[] }
    if (!Array.isArray(shared.webProfilePluginSources) || shared.webProfilePluginSources.length === 0) throw new Error('scripts/_shared.mjs exports no webProfilePluginSources')
    await this.exec(this.node, [dshEntry, 'plugin', '--profile', 'web', 'add', '--allow-build=node-pty', ...shared.webProfilePluginSources], base, repo)
  }
  private async allocatePort(): Promise<number> {
    const used = new Set([...this.instances.values()].map(instance => instance.port))
    for (let port = this.options.portRangeStart; port < this.options.portRangeStart + 200; port += 1) {
      if (used.has(port)) continue
      const free = await new Promise<boolean>(resolve => {
        const probe = createServer()
        probe.once('error', () => resolve(false))
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
      })
      if (free) return port
    }
    throw new Error('no free port in cloud.process port range')
  }
  private static alive(instance: ProcessInstance) {
    return instance.child.exitCode === null && instance.child.signalCode === null && (instance.state === 'starting' || instance.state === 'running')
  }
  async ensureRunning(employeeId: string, env: InstanceEnvironment): Promise<OrchestratorState> {
    const current = this.instances.get(employeeId)
    if (current && ProcessOrchestrator.alive(current)) return this.snapshot(current)
    const pending = this.launching.get(employeeId)
    if (pending) return pending
    const launch = this.launch(employeeId, env).finally(() => this.launching.delete(employeeId))
    this.launching.set(employeeId, launch)
    return launch
  }
  private async launch(employeeId: string, env: InstanceEnvironment): Promise<OrchestratorState> {
    const home = instanceHome(this.options.directory, employeeId)
    await mkdir(home, { recursive: true })
    const dshEntry = await this.entry()
    if (this.options.bootstrap !== false) await this.bootstrap(home, dshEntry)
    const port = await this.allocatePort()
    const log = createWriteStream(path.join(path.dirname(home), 'instance.log'), { flags: 'a', mode: 0o600 })
    const secrets = Object.entries(env).filter(([key]) => SECRET_ENV.test(key)).map(([, value]) => value)
    const args = [dshEntry, '--profile', 'web', ...this.options.overlays.flatMap(overlay => ['--patch', overlay]), '--no-open', '--port', String(port)]
    const child = spawn(this.node, args, {
      cwd: this.options.productRepo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, DSH_HOME: home, DSH_OPS_LOG_DIR: path.join(home, 'logs') },
    })
    let resolveReady!: () => void, rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    ready.catch(() => {})
    const instance: ProcessInstance = { child, port, state: 'starting', ready, exited: Promise.resolve() }
    this.instances.set(employeeId, instance)
    // Last lines of output (credentials stripped) travel with the failure reason into last_error.
    const tail: string[] = []
    let summary: string | undefined
    const finalize = () => { if (summary !== undefined) instance.error = [summary, ...tail].join('\n').slice(0, MAX_ERROR_CHARS) }
    const onLine = (raw: string) => {
      if (instance.state === 'starting') {
        const match = READY_PATTERN.exec(raw)
        if (match) { instance.state = 'running'; instance.launchUrl = match[1]; clearTimeout(startupTimer); resolveReady() }
      }
      const line = redactSecrets(raw, secrets).slice(0, 500)
      log.write(`${line}\n`)
      tail.push(line)
      if (tail.length > LOG_TAIL_LINES) tail.shift()
    }
    const stdout = lineReader(onLine), stderr = lineReader(onLine)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    const startupTimer = setTimeout(() => {
      if (instance.state !== 'starting') return
      instance.state = 'error'
      summary = `did not print the "dsh web:" readiness line within ${this.options.startupTimeoutMs ?? 180_000} ms; killed`
      finalize(); rejectReady(new Error(instance.error))
      this.options.log?.(`instance ${employeeId} pid ${child.pid} startup timed out`)
      void this.terminate(instance)
    }, this.options.startupTimeoutMs ?? 180_000)
    startupTimer.unref()
    instance.exited = new Promise<void>(resolve => child.once('exit', (code, signal) => {
      clearTimeout(startupTimer)
      const detail = `exit code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}`
      if (instance.state === 'starting') { instance.state = 'error'; summary = `exited during startup (${detail})`; finalize(); rejectReady(new Error(instance.error)) }
      else if (instance.state === 'running') { instance.state = 'stopped'; summary = `exited unexpectedly (${detail})`; finalize() }
      else if (instance.state === 'stopping') { instance.state = 'stopped'; summary = undefined; instance.error = undefined }
      // 'error' from the startup timeout keeps its reason.
      const closeLog = setTimeout(() => log.end(), 10_000)
      closeLog.unref()
      child.once('close', () => { clearTimeout(closeLog); stdout.flush(); stderr.flush(); finalize(); log.end() })
      resolve()
    }))
    try { await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }) }
    catch (error) {
      clearTimeout(startupTimer)
      instance.state = 'error'; instance.error = describeFailure(error); log.end(); rejectReady(error as Error)
      this.instances.delete(employeeId)
      throw error
    }
    this.options.log?.(`instance ${employeeId} pid ${child.pid} port ${port}`)
    return this.snapshot(instance)
  }
  private snapshot(instance: ProcessInstance): OrchestratorState {
    return {
      state: instance.state, port: instance.port, ...(instance.child.pid === undefined ? {} : { backendRef: String(instance.child.pid) }),
      ...(instance.launchUrl === undefined ? {} : { launchUrl: instance.launchUrl }), ...(instance.error === undefined ? {} : { error: instance.error }),
    }
  }
  /** Wait for the `dsh web:` readiness line; rejects when the runtime exits or times out first. */
  async waitUntilReady(employeeId: string, timeoutMs = 180_000): Promise<OrchestratorState> {
    const instance = this.instances.get(employeeId)
    if (!instance) throw new Error('instance not launched')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([instance.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('instance did not become ready in time')), timeoutMs) })])
    } finally { clearTimeout(timer) }
    return this.snapshot(instance)
  }
  async inspect(employeeId: string): Promise<OrchestratorState> {
    const instance = this.instances.get(employeeId)
    if (!instance) return { state: 'stopped' }
    return this.snapshot(instance)
  }
  /** Kill the whole tree: DSH spawns helper processes that would otherwise outlive it. */
  private async terminate(instance: ProcessInstance) {
    const { child } = instance
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 15_000 }, () => resolve()))
    } else {
      child.kill('SIGTERM')
      const grace = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 10_000)
      grace.unref()
    }
    await Promise.race([instance.exited, new Promise(resolve => setTimeout(resolve, 15_000).unref())])
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch { /* already gone */ } await once(child, 'exit').catch(() => {}) }
  }
  async stop(employeeId: string): Promise<void> {
    const instance = this.instances.get(employeeId)
    if (!instance) return
    this.instances.delete(employeeId)
    if (!ProcessOrchestrator.alive(instance)) return
    instance.state = 'stopping'
    await this.terminate(instance)
  }
  async close() { await Promise.all([...this.instances.keys()].map(employeeId => this.stop(employeeId).catch(() => {}))) }
}
