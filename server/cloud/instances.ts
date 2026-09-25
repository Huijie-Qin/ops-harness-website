import type { CloudDatabase, InstanceRecord } from './database.js'
import type { InstanceStatus } from './types.js'
import { describeFailure } from './errors.js'
import type { InstanceEnvironment, Orchestrator, OrchestratorState } from './orchestrator.js'

export type InstanceManagerOptions = {
  /** Website origin the executor reports to (from inside a container this may differ from the public one). */
  instanceWebsiteUrl: string
  /** Name of the website process environment variable holding the organisation model key. */
  modelApiKeyEnv: string
  modelBaseUrl?: string
  modelName?: string
  now?: () => number
  log?: ((line: string) => void) | undefined
  /** Do not retry a failed launch more often than this. */
  errorBackoffMs?: number
  /** Unexpected exits after readiness that, in a row, put the instance into the same backoff. */
  maxConsecutiveFailures?: number
}
const DEFAULT_BACKOFF_MS = 5 * 60_000
const DEFAULT_MAX_FAILURES = 3
const firstLine = (text: string) => text.split('\n')[0] ?? text

/**
 * Bridges the database view of a user's instance with the orchestrator backend: issues the per-launch executor
 * token, builds the instance environment and records backend state / last_error. Never lets an orchestrator
 * failure escape to the scheduler loop.
 *
 * Failure policy: an instance that never becomes ready (crash during startup, startup timeout, exited container)
 * is recorded as `error` and not relaunched for `errorBackoffMs`; one that dies after it was ready is recorded as
 * `stopped` with the reason and relaunched on the next pass, but `maxConsecutiveFailures` such deaths in a row
 * enter the same backoff. The consecutive counter lives in memory and resets when the instance is seen running.
 */
export class InstanceManager {
  private inflight = new Map<string, Promise<InstanceStatus>>()
  private failures = new Map<string, number>()
  private now: () => number
  constructor(private db: CloudDatabase, readonly orchestrator: Orchestrator, private options: InstanceManagerOptions) { this.now = options.now ?? Date.now }
  environment(employeeId: string, executorToken: string): InstanceEnvironment {
    const modelKey = process.env[this.options.modelApiKeyEnv]
    return {
      DSH_OPS_CLOUD_EXECUTOR: '1',
      DSH_OPS_CLOUD_WEBSITE_URL: this.options.instanceWebsiteUrl,
      DSH_OPS_CLOUD_EXECUTOR_TOKEN: executorToken,
      DSH_OPS_CLOUD_INSTANCE_ID: employeeId,
      ...(modelKey ? { DSH_OPS_DEFAULT_MODEL_API_KEY: modelKey } : {}),
      ...(this.options.modelBaseUrl ? { DSH_OPS_CLOUD_MODEL_BASE_URL: this.options.modelBaseUrl } : {}),
      ...(this.options.modelName ? { DSH_OPS_CLOUD_MODEL_NAME: this.options.modelName } : {}),
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_DISABLED: '1',
    }
  }
  private inBackoff(record: InstanceRecord | undefined) {
    return record?.state === 'error' && this.now() - Date.parse(record.updatedAt) < (this.options.errorBackoffMs ?? DEFAULT_BACKOFF_MS)
  }
  ensureRunning(employeeId: string): Promise<InstanceStatus> {
    const pending = this.inflight.get(employeeId)
    if (pending) return pending
    return this.track(employeeId, this.ensure(employeeId))
  }
  private track(employeeId: string, operation: Promise<InstanceStatus>) {
    const work = operation.finally(() => { if (this.inflight.get(employeeId) === work) this.inflight.delete(employeeId) })
    this.inflight.set(employeeId, work)
    return work
  }
  private async ensure(employeeId: string): Promise<InstanceStatus> {
    const record = this.db.instance(employeeId)
    if (this.inBackoff(record)) return this.db.instanceStatus(employeeId)
    try {
      const live = await this.orchestrator.inspect(employeeId)
      if (this.reconcile(employeeId, record, live) !== 'launch') return this.db.instanceStatus(employeeId)
      this.db.revokeExecutorTokens(employeeId)
      const issued = this.db.issueToken({ employeeId, kind: 'executor', label: `instance ${this.orchestrator.backend}` })
      this.db.updateInstance(employeeId, { state: 'starting', backend: this.orchestrator.backend, executorTokenHash: issued.hash, lastError: null, lastHeartbeatAt: null, launchUrl: null, touchActivity: true })
      const launched = await this.orchestrator.ensureRunning(employeeId, this.environment(employeeId, issued.token))
      if (launched.state === 'error') this.fail(employeeId, launched.error ?? 'instance failed to start')
      else {
        this.db.updateInstance(employeeId, { state: launched.state, backendRef: launched.backendRef ?? null, port: launched.port ?? null, launchUrl: launched.launchUrl ?? null, lastError: launched.error ?? null })
        this.options.log?.(`instance ${employeeId} ${launched.state} via ${this.orchestrator.backend}`)
      }
    } catch (error) { this.fail(employeeId, describeFailure(error)) }
    return this.db.instanceStatus(employeeId)
  }
  /** Bring the record in line with the backend; 'launch' means a (re)launch is allowed right now. */
  private reconcile(employeeId: string, record: InstanceRecord | undefined, live: OrchestratorState): 'alive' | 'wait' | 'launch' {
    if (live.state === 'running' || live.state === 'starting') {
      if (live.state === 'running') this.failures.delete(employeeId)
      // Backend already alive: keep the executor token it was launched with.
      if (!record || record.state !== live.state || record.backendRef !== (live.backendRef ?? null)) this.db.updateInstance(employeeId, { state: live.state, backend: this.orchestrator.backend, backendRef: live.backendRef ?? null, port: live.port ?? null, launchUrl: live.launchUrl ?? null })
      return 'alive'
    }
    if (live.state === 'stopping') return 'wait'
    // A recorded error whose backoff has elapsed (the caller checked) may try again.
    if (record?.state === 'error') return 'launch'
    if (live.state === 'error') { this.fail(employeeId, live.error ?? 'instance exited before it became ready'); return 'wait' }
    if (record && (record.state === 'running' || record.state === 'starting')) {
      // We believed it alive and the backend says it is gone.
      this.db.revokeExecutorTokens(employeeId)
      if (!live.error) { this.db.updateInstance(employeeId, { state: 'stopped', backendRef: null, launchUrl: null, lastHeartbeatAt: null }); return 'launch' }
      const count = (this.failures.get(employeeId) ?? 0) + 1
      this.failures.set(employeeId, count)
      const backoff = count >= (this.options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES)
      this.db.updateInstance(employeeId, { state: backoff ? 'error' : 'stopped', backendRef: null, launchUrl: null, lastHeartbeatAt: null, lastError: live.error })
      this.options.log?.(`instance ${employeeId} ${firstLine(live.error)} (${count} in a row${backoff ? ', backing off' : ', relaunch on next pass'})`)
      return 'wait'
    }
    return 'launch'
  }
  private fail(employeeId: string, message: string) {
    const count = (this.failures.get(employeeId) ?? 0) + 1
    this.failures.set(employeeId, count)
    this.db.revokeExecutorTokens(employeeId)
    this.db.updateInstance(employeeId, { state: 'error', lastHeartbeatAt: null, lastError: message })
    this.options.log?.(`instance ${employeeId} failed (${count} in a row, backing off): ${firstLine(message)}`)
  }
  stop(employeeId: string): Promise<InstanceStatus> {
    // A launch may still be creating the container. Stop it only after that launch settles,
    // and keep subsequent wakeups deduplicated until the stop has revoked its token.
    const pending = this.inflight.get(employeeId)
    return this.track(employeeId, (pending ?? Promise.resolve()).then(() => this.stopInstance(employeeId)))
  }
  private async stopInstance(employeeId: string): Promise<InstanceStatus> {
    this.db.updateInstance(employeeId, { state: 'stopping' })
    this.failures.delete(employeeId)
    try {
      await this.orchestrator.stop(employeeId)
      this.db.updateInstance(employeeId, { state: 'stopped', backendRef: null, launchUrl: null, lastHeartbeatAt: null, lastError: null })
      this.options.log?.(`instance ${employeeId} stopped`)
    } catch (error) {
      this.db.updateInstance(employeeId, { state: 'error', lastError: describeFailure(error) })
    } finally { this.db.revokeExecutorTokens(employeeId) }
    return this.db.instanceStatus(employeeId)
  }
  /** Re-read the backend state without launching: crashes are recorded even when no run is waiting. */
  async refresh(employeeId: string): Promise<InstanceStatus> {
    const pending = this.inflight.get(employeeId)
    if (pending) return pending
    const record = this.db.instance(employeeId)
    if (!record || record.state === 'stopped' || record.state === 'error') return this.db.instanceStatus(employeeId)
    try { this.reconcile(employeeId, record, await this.orchestrator.inspect(employeeId)) }
    catch (error) { this.options.log?.(`instance ${employeeId} inspect failed: ${describeFailure(error)}`) }
    return this.db.instanceStatus(employeeId)
  }
  /** Requests can initiate a wakeup outside the scheduler; let those finish before closing the database. */
  async settle() { await Promise.allSettled(this.inflight.values()) }
}
