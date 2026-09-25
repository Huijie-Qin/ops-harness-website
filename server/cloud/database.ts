import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  ArtifactInfoSchema, CLAIM_LEASE_MS, CloudRunSchema, CloudTaskDefinitionSchema, CloudTaskSchema, ExecutorCatalogSchema, HEARTBEAT_INTERVAL_MS,
  InstanceStatusSchema, MAX_QUEUED_RUNS_PER_USER, RESULT_RETENTION_DAYS, isTerminalRunStatus,
  type ArtifactInfo, type ClaimedRun, type CloudRun, type CloudTask, type CloudTaskDefinition, type ExecutorCatalog, type ExecutorHeartbeat,
  type RunCompletion, type RunProgress, type RunStatus, type TaskState,
} from '@dsh-ops/cloud-task-contract'
import { CloudError } from './errors.js'
import { nextRunAt } from './schedule.js'
import type { InstanceStatus } from './types.js'
import { CloudEmployeeIdSchema } from './identity.js'

export type TokenKind = 'user' | 'executor'
export type TokenRecord = { hashPrefix: string; employeeId: string; kind: TokenKind; label: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null }
export type Principal = { employeeId: string; hash: string; kind: TokenKind }
export type InstanceRecord = {
  employeeId: string; state: InstanceStatus['state']; backend: string; backendRef: string | null; port: number | null; launchUrl: string | null
  executorTokenHash: string | null; lastHeartbeatAt: string | null; bundleVersion: string | null; dshVersion: string | null
  updatedAt: string; lastActivityAt: string; lastError: string | null; hasCatalog: boolean
}
export type InstancePatch = Partial<Omit<InstanceRecord, 'employeeId' | 'updatedAt' | 'hasCatalog' | 'lastActivityAt'>> & { touchActivity?: boolean }
export type TickResult = { enqueued: string[]; requeued: string[]; failed: string[]; expired: string[] }
export type RunListQuery = { taskId?: string | undefined; limit: number; offset: number }

const DAY = 86_400_000
/** Queued runs nobody claimed within a day are dropped instead of running long after their slot. */
const QUEUED_EXPIRY_MS = 24 * 3_600_000
/** Two lease expiries send the same run back to the queue; the third fails it. */
const MAX_LEASE_EXPIRATIONS = 2
const CATALOG_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS
const TOKEN_GRACE_DAYS = 30
const MAX_TASKS_PER_USER = 500
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
type Row = Record<string, SQLInputValue>

/**
 * Website-owned state for cloud scheduled tasks: tokens (hash only), per-user instances, task definitions with
 * their next trigger, and run records. Synchronous node:sqlite on the main thread: every statement is a point
 * lookup or a tiny scan, and the scheduler tick is the only writer besides request handlers.
 */
export class CloudDatabase {
  private db: DatabaseSync
  constructor(directory: string, private now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, 'cloud.sqlite')
    if (lstatSync(directory).isSymbolicLink() || (existsSync(file) && lstatSync(file).isSymbolicLink())) throw new Error('UNSAFE_CLOUD_PATH')
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS cloud_tokens(hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT);
      CREATE INDEX IF NOT EXISTS tokens_employee ON cloud_tokens(employee_id, kind);
      CREATE TABLE IF NOT EXISTS cloud_instances(employee_id TEXT PRIMARY KEY, state TEXT NOT NULL, backend TEXT NOT NULL DEFAULT '', backend_ref TEXT, port INTEGER, launch_url TEXT, executor_token_hash TEXT, last_heartbeat_at TEXT, catalog_json TEXT, bundle_version TEXT, dsh_version TEXT, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, last_error TEXT);
      CREATE TABLE IF NOT EXISTS cloud_tasks(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, definition_json TEXT NOT NULL, state TEXT NOT NULL, next_run_at TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_employee ON cloud_tasks(employee_id, created_at);
      CREATE INDEX IF NOT EXISTS tasks_due ON cloud_tasks(state, next_run_at);
      CREATE TABLE IF NOT EXISTS cloud_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, employee_id TEXT NOT NULL, task_name TEXT NOT NULL, definition_json TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_at TEXT NOT NULL, queued_at TEXT NOT NULL, claimed_at TEXT, lease_until TEXT, lease_expirations INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, summary TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', session_id TEXT, auto_decisions INTEGER, artifact_json TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, executor_instance TEXT);
      CREATE INDEX IF NOT EXISTS runs_employee ON cloud_runs(employee_id, queued_at);
      CREATE INDEX IF NOT EXISTS runs_task ON cloud_runs(task_id, queued_at);
      CREATE INDEX IF NOT EXISTS runs_status ON cloud_runs(status, employee_id);
    `)
    const version = Number(this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version)
    if (version !== 1) throw new Error('UNSUPPORTED_CLOUD_SCHEMA')
  }

  private iso(epoch = this.now()) { return new Date(epoch).toISOString() }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = action(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  // ── Tokens ─────────────────────────────────────────────────────────────
  issueToken(input: { employeeId: string; kind: TokenKind; label: string; expiresAt?: number | undefined }): { token: string; hash: string; record: TokenRecord } {
    if (!CloudEmployeeIdSchema.safeParse(input.employeeId).success) throw new CloudError('INVALID_REQUEST', 400, 'invalid employeeId')
    const token = randomBytes(32).toString('base64url')
    const hash = sha256(token)
    const expiresAt = input.expiresAt === undefined ? null : this.iso(input.expiresAt)
    if (expiresAt !== null && input.expiresAt! <= this.now()) throw new CloudError('INVALID_REQUEST', 400, 'expiresAt must be in the future')
    this.db.prepare('INSERT INTO cloud_tokens(hash,employee_id,kind,label,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(hash, input.employeeId, input.kind, input.label.slice(0, 80), this.iso(), expiresAt)
    return { token, hash, record: this.tokenRecord(this.db.prepare('SELECT * FROM cloud_tokens WHERE hash=?').get(hash)!) }
  }
  /** Resolve a bearer token of the given kind; undefined when unknown, revoked, expired or of another kind. */
  authenticate(token: string, kind: TokenKind): Principal | undefined {
    const hash = sha256(token)
    const row = this.db.prepare('SELECT employee_id, kind, expires_at, revoked_at FROM cloud_tokens WHERE hash=?').get(hash)
    if (!row || row.kind !== kind || row.revoked_at !== null) return undefined
    if (!CloudEmployeeIdSchema.safeParse(row.employee_id).success) return undefined
    if (row.expires_at !== null && Date.parse(String(row.expires_at)) <= this.now()) return undefined
    this.db.prepare('UPDATE cloud_tokens SET last_used_at=? WHERE hash=?').run(this.iso(), hash)
    return { employeeId: String(row.employee_id), hash, kind }
  }
  listTokens(): TokenRecord[] {
    return this.db.prepare('SELECT * FROM cloud_tokens ORDER BY created_at DESC LIMIT 1000').all().map(row => this.tokenRecord(row))
  }
  revokeToken(hashPrefix: string): TokenRecord {
    if (!/^[0-9a-f]{12,64}$/.test(hashPrefix)) throw new CloudError('INVALID_REQUEST', 400, 'hash prefix must be 12 to 64 hex characters')
    const rows = this.db.prepare("SELECT * FROM cloud_tokens WHERE substr(hash,1,?)=? LIMIT 2").all(hashPrefix.length, hashPrefix)
    if (rows.length === 0) throw new CloudError('NOT_FOUND', 404)
    if (rows.length > 1) throw new CloudError('INVALID_REQUEST', 400, 'hash prefix is ambiguous')
    const row = rows[0]!
    if (row.revoked_at === null) this.db.prepare('UPDATE cloud_tokens SET revoked_at=? WHERE hash=?').run(this.iso(), row.hash!)
    return this.tokenRecord(this.db.prepare('SELECT * FROM cloud_tokens WHERE hash=?').get(String(row.hash))!)
  }
  revokeExecutorTokens(employeeId: string) {
    this.db.prepare("UPDATE cloud_tokens SET revoked_at=? WHERE employee_id=? AND kind='executor' AND revoked_at IS NULL").run(this.iso(), employeeId)
  }
  private tokenRecord(row: Row): TokenRecord {
    return { hashPrefix: String(row.hash).slice(0, 12), employeeId: String(row.employee_id), kind: row.kind as TokenKind, label: String(row.label), createdAt: String(row.created_at), expiresAt: row.expires_at === null ? null : String(row.expires_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at), lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at) }
  }

  // ── Instances ──────────────────────────────────────────────────────────
  instance(employeeId: string): InstanceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM cloud_instances WHERE employee_id=?').get(employeeId)
    return row ? this.instanceRecord(row) : undefined
  }
  listInstances(): InstanceRecord[] {
    return this.db.prepare('SELECT * FROM cloud_instances ORDER BY updated_at DESC LIMIT 1000').all().map(row => this.instanceRecord(row))
  }
  instanceStatus(employeeId: string): InstanceStatus {
    const record = this.instance(employeeId)
    return InstanceStatusSchema.parse({
      state: record?.state ?? 'stopped', updatedAt: record?.updatedAt ?? this.iso(),
      ...(record?.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
      ...(record?.bundleVersion ? { bundleVersion: record.bundleVersion } : {}),
      ...(record?.dshVersion ? { dshVersion: record.dshVersion } : {}),
    })
  }
  updateInstance(employeeId: string, patch: InstancePatch): InstanceRecord {
    return this.transaction(() => {
      const now = this.iso()
      const current = this.db.prepare('SELECT * FROM cloud_instances WHERE employee_id=?').get(employeeId)
      const next = {
        state: patch.state ?? (current?.state as string | undefined) ?? 'stopped',
        backend: patch.backend ?? String(current?.backend ?? ''),
        backend_ref: patch.backendRef === undefined ? current?.backend_ref ?? null : patch.backendRef,
        port: patch.port === undefined ? current?.port ?? null : patch.port,
        launch_url: patch.launchUrl === undefined ? current?.launch_url ?? null : patch.launchUrl,
        executor_token_hash: patch.executorTokenHash === undefined ? current?.executor_token_hash ?? null : patch.executorTokenHash,
        last_heartbeat_at: patch.lastHeartbeatAt === undefined ? current?.last_heartbeat_at ?? null : patch.lastHeartbeatAt,
        bundle_version: patch.bundleVersion === undefined ? current?.bundle_version ?? null : patch.bundleVersion,
        dsh_version: patch.dshVersion === undefined ? current?.dsh_version ?? null : patch.dshVersion,
        last_error: patch.lastError === undefined ? current?.last_error ?? null : patch.lastError,
        last_activity_at: patch.touchActivity || !current ? now : String(current.last_activity_at),
      }
      this.db.prepare(`INSERT INTO cloud_instances(employee_id,state,backend,backend_ref,port,launch_url,executor_token_hash,last_heartbeat_at,catalog_json,bundle_version,dsh_version,updated_at,last_activity_at,last_error)
        VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET state=excluded.state,backend=excluded.backend,backend_ref=excluded.backend_ref,port=excluded.port,launch_url=excluded.launch_url,executor_token_hash=excluded.executor_token_hash,last_heartbeat_at=excluded.last_heartbeat_at,bundle_version=excluded.bundle_version,dsh_version=excluded.dsh_version,updated_at=excluded.updated_at,last_activity_at=excluded.last_activity_at,last_error=excluded.last_error`)
        .run(employeeId, next.state, next.backend, next.backend_ref, next.port, next.launch_url, next.executor_token_hash, next.last_heartbeat_at, next.bundle_version, next.dsh_version, now, next.last_activity_at, next.last_error)
      return this.instanceRecord(this.db.prepare('SELECT * FROM cloud_instances WHERE employee_id=?').get(employeeId)!)
    })
  }
  /** Executor heartbeat: refresh liveness, catalog and versions; extend leases of runs it still reports; answer cancellations. */
  heartbeat(employeeId: string, heartbeat: ExecutorHeartbeat): { cancelRunIds: string[]; drain: boolean } {
    return this.transaction(() => {
      const now = this.iso()
      const current = this.db.prepare('SELECT state FROM cloud_instances WHERE employee_id=?').get(employeeId)
      const drain = current?.state === 'stopping'
      const state = drain ? 'stopping' : 'running'
      this.db.prepare(`INSERT INTO cloud_instances(employee_id,state,backend,updated_at,last_activity_at,last_heartbeat_at,catalog_json,bundle_version,dsh_version)
        VALUES(?,?,'',?,?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET state=?,updated_at=excluded.updated_at,last_heartbeat_at=excluded.last_heartbeat_at,catalog_json=excluded.catalog_json,bundle_version=excluded.bundle_version,dsh_version=excluded.dsh_version,last_error=NULL`)
        .run(employeeId, state, now, now, now, JSON.stringify(heartbeat.catalog), heartbeat.bundleVersion, heartbeat.dshVersion, state)
      const lease = this.iso(this.now() + CLAIM_LEASE_MS)
      for (const runId of heartbeat.runningRunIds) {
        this.db.prepare("UPDATE cloud_runs SET lease_until=? WHERE id=? AND employee_id=? AND status IN ('claimed','running') AND lease_until>?").run(lease, runId, employeeId, now)
      }
      const cancelRunIds = this.db.prepare("SELECT id FROM cloud_runs WHERE employee_id=? AND cancel_requested=1 AND status IN ('claimed','running') ORDER BY queued_at LIMIT 50").all(employeeId).map(row => String(row.id))
      return { cancelRunIds, drain }
    })
  }
  catalog(employeeId: string): { catalog: ExecutorCatalog | null; stale: boolean } {
    const row = this.db.prepare('SELECT catalog_json, last_heartbeat_at, state FROM cloud_instances WHERE employee_id=?').get(employeeId)
    if (!row?.catalog_json) return { catalog: null, stale: true }
    const parsed = ExecutorCatalogSchema.safeParse(JSON.parse(String(row.catalog_json)))
    if (!parsed.success) return { catalog: null, stale: true }
    const heartbeat = row.last_heartbeat_at === null ? 0 : Date.parse(String(row.last_heartbeat_at))
    return { catalog: parsed.data, stale: row.state !== 'running' || this.now() - heartbeat > CATALOG_STALE_MS }
  }
  private instanceRecord(row: Row): InstanceRecord {
    const text = (value: SQLInputValue | undefined) => value === null || value === undefined ? null : String(value)
    return {
      employeeId: String(row.employee_id), state: row.state as InstanceStatus['state'], backend: String(row.backend ?? ''), backendRef: text(row.backend_ref), port: row.port === null ? null : Number(row.port),
      launchUrl: text(row.launch_url), executorTokenHash: text(row.executor_token_hash), lastHeartbeatAt: text(row.last_heartbeat_at), bundleVersion: text(row.bundle_version), dshVersion: text(row.dsh_version),
      updatedAt: String(row.updated_at), lastActivityAt: String(row.last_activity_at), lastError: text(row.last_error), hasCatalog: row.catalog_json !== null,
    }
  }

  // ── Tasks ──────────────────────────────────────────────────────────────
  createTask(employeeId: string, input: unknown): CloudTask {
    const definition = this.definition(input)
    const now = this.now()
    const next = nextRunAt(definition, now)
    if (next === null) throw new CloudError('INVALID_REQUEST', 400, 'schedule never fires in the future')
    return this.transaction(() => {
      const count = Number(this.db.prepare('SELECT COUNT(*) AS value FROM cloud_tasks WHERE employee_id=?').get(employeeId)!.value)
      if (count >= MAX_TASKS_PER_USER) throw new CloudError('QUEUE_FULL', 409, `at most ${MAX_TASKS_PER_USER} tasks per user`)
      const id = `ct_${randomBytes(16).toString('hex')}`
      this.db.prepare('INSERT INTO cloud_tasks VALUES(?,?,?,?,?,?,?,?)').run(id, employeeId, JSON.stringify(definition), 'scheduled', this.iso(next), 1, this.iso(now), this.iso(now))
      return this.task(employeeId, id)
    })
  }
  listTasks(employeeId: string): CloudTask[] {
    return this.db.prepare('SELECT * FROM cloud_tasks WHERE employee_id=? ORDER BY created_at DESC, id LIMIT ?').all(employeeId, MAX_TASKS_PER_USER).map(row => this.taskRecord(row))
  }
  task(employeeId: string, id: string): CloudTask {
    const row = this.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND employee_id=?').get(id, employeeId)
    if (!row) throw new CloudError('NOT_FOUND', 404)
    return this.taskRecord(row)
  }
  updateTask(employeeId: string, id: string, expectedRevision: number, input: unknown): CloudTask {
    const definition = this.definition(input)
    return this.transaction(() => {
      const current = this.lockedTask(employeeId, id, expectedRevision)
      const now = this.now()
      const next = current.state === 'scheduled' ? nextRunAt(definition, now) : null
      if (current.state === 'scheduled' && next === null) throw new CloudError('INVALID_REQUEST', 400, 'schedule never fires in the future')
      this.db.prepare('UPDATE cloud_tasks SET definition_json=?, next_run_at=?, revision=revision+1, updated_at=? WHERE id=?').run(JSON.stringify(definition), next === null ? null : this.iso(next), this.iso(now), id)
      return this.task(employeeId, id)
    })
  }
  setTaskState(employeeId: string, id: string, expectedRevision: number, state: Extract<TaskState, 'scheduled' | 'paused'>): CloudTask {
    return this.transaction(() => {
      const current = this.lockedTask(employeeId, id, expectedRevision)
      const now = this.now()
      let next: number | null = null
      if (state === 'scheduled') {
        next = nextRunAt(this.storedDefinition(current), now)
        if (next === null) throw new CloudError('INVALID_REQUEST', 400, 'schedule never fires in the future')
      }
      this.db.prepare('UPDATE cloud_tasks SET state=?, next_run_at=?, revision=revision+1, updated_at=? WHERE id=?').run(state, next === null ? null : this.iso(next), this.iso(now), id)
      return this.task(employeeId, id)
    })
  }
  /** Delete a task; queued runs are cancelled, a claimed/running run blocks the deletion (TASK_RUNNING). */
  deleteTask(employeeId: string, id: string): void {
    this.transaction(() => {
      this.task(employeeId, id)
      const active = this.db.prepare("SELECT COUNT(*) AS value FROM cloud_runs WHERE task_id=? AND status IN ('claimed','running')").get(id)!.value
      if (Number(active) > 0) throw new CloudError('TASK_RUNNING', 409, 'cancel the running run first')
      const now = this.iso()
      this.db.prepare("UPDATE cloud_runs SET status='cancelled', finished_at=? WHERE task_id=? AND status='queued'").run(now, id)
      this.db.prepare('DELETE FROM cloud_tasks WHERE id=?').run(id)
    })
  }
  private definition(input: unknown): CloudTaskDefinition {
    const parsed = CloudTaskDefinitionSchema.safeParse(input)
    if (!parsed.success) throw new CloudError('INVALID_REQUEST', 400, parsed.error.issues[0]?.message ?? 'invalid task definition')
    const definition = parsed.data
    if (definition.activeFrom !== undefined && definition.activeUntil !== undefined && Date.parse(definition.activeFrom) >= Date.parse(definition.activeUntil)) throw new CloudError('INVALID_REQUEST', 400, 'activeUntil must be after activeFrom')
    return definition
  }
  private storedDefinition(row: Row): CloudTaskDefinition { return CloudTaskDefinitionSchema.parse(JSON.parse(String(row.definition_json))) }
  private lockedTask(employeeId: string, id: string, expectedRevision: number): Row {
    const row = this.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND employee_id=?').get(id, employeeId)
    if (!row) throw new CloudError('NOT_FOUND', 404)
    if (Number(row.revision) !== expectedRevision) throw new CloudError('REVISION_CONFLICT', 409)
    return row
  }
  private taskRecord(row: Row): CloudTask {
    const lastRun = this.db.prepare('SELECT * FROM cloud_runs WHERE task_id=? ORDER BY queued_at DESC, id DESC LIMIT 1').get(String(row.id))
    return CloudTaskSchema.parse({
      ...this.storedDefinition(row), id: row.id, employeeId: row.employee_id, state: row.state,
      nextRunAt: row.next_run_at === null ? null : row.next_run_at, ...(lastRun ? { lastRun: this.runRecord(lastRun) } : {}),
      revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
    })
  }

  // ── Runs ───────────────────────────────────────────────────────────────
  /** Create a queued run for a task; the per-user queue cap protects the executor from bursts. */
  enqueueRun(employeeId: string, taskId: string, trigger: 'schedule' | 'manual', scheduledAt = this.now()): CloudRun {
    return this.transaction(() => this.enqueueLocked(employeeId, taskId, trigger, scheduledAt))
  }
  private enqueueLocked(employeeId: string, taskId: string, trigger: 'schedule' | 'manual', scheduledAt: number): CloudRun {
    const task = this.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND employee_id=?').get(taskId, employeeId)
    if (!task) throw new CloudError('NOT_FOUND', 404)
    const queued = Number(this.db.prepare("SELECT COUNT(*) AS value FROM cloud_runs WHERE employee_id=? AND status='queued'").get(employeeId)!.value)
    if (queued >= MAX_QUEUED_RUNS_PER_USER) throw new CloudError('QUEUE_FULL', 409, `at most ${MAX_QUEUED_RUNS_PER_USER} queued runs per user`)
    const definition = this.storedDefinition(task)
    const id = `cr_${randomBytes(16).toString('hex')}`
    this.db.prepare('INSERT INTO cloud_runs(id,task_id,employee_id,task_name,definition_json,status,trigger,scheduled_at,queued_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, taskId, employeeId, definition.name, JSON.stringify(definition), 'queued', trigger, this.iso(scheduledAt), this.iso())
    return this.run(employeeId, id)
  }
  listRuns(employeeId: string, query: RunListQuery): { runs: CloudRun[]; total: number } {
    const values: SQLInputValue[] = [employeeId]
    let where = 'employee_id=?'
    if (query.taskId !== undefined) { where += ' AND task_id=?'; values.push(query.taskId) }
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS value FROM cloud_runs WHERE ${where}`).get(...values)!.value)
    const runs = this.db.prepare(`SELECT * FROM cloud_runs WHERE ${where} ORDER BY queued_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset).map(row => this.runRecord(row))
    return { runs, total }
  }
  run(employeeId: string, id: string): CloudRun {
    const row = this.db.prepare('SELECT * FROM cloud_runs WHERE id=? AND employee_id=?').get(id, employeeId)
    if (!row) throw new CloudError('NOT_FOUND', 404)
    return this.runRecord(row)
  }
  /** Cancel: a queued run ends immediately; a claimed/running one is flagged and the executor is told on its next heartbeat. */
  cancelRun(employeeId: string, id: string): CloudRun {
    return this.transaction(() => {
      const row = this.lockedRun(employeeId, id)
      const status = row.status as RunStatus
      if (status === 'queued') this.db.prepare("UPDATE cloud_runs SET status='cancelled', finished_at=?, cancel_requested=1 WHERE id=?").run(this.iso(), id)
      else if (!isTerminalRunStatus(status)) this.db.prepare('UPDATE cloud_runs SET cancel_requested=1 WHERE id=?').run(id)
      return this.run(employeeId, id)
    })
  }
  /** Atomically hand the oldest queued run of this user to the executor. */
  claimRun(employeeId: string, instanceId: string): ClaimedRun | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id, definition_json FROM cloud_runs WHERE employee_id=? AND status='queued' ORDER BY queued_at, id LIMIT 1").get(employeeId)
      if (!row) return undefined
      const now = this.now()
      this.db.prepare("UPDATE cloud_runs SET status='claimed', claimed_at=?, lease_until=?, executor_instance=? WHERE id=? AND status='queued'").run(this.iso(now), this.iso(now + CLAIM_LEASE_MS), instanceId, row.id!)
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(this.iso(now), employeeId)
      return { run: this.run(employeeId, String(row.id)), definition: CloudTaskDefinitionSchema.parse(JSON.parse(String(row.definition_json))), leaseMs: CLAIM_LEASE_MS }
    })
  }
  progressRun(employeeId: string, id: string, progress: RunProgress): CloudRun {
    return this.transaction(() => {
      this.activeRun(employeeId, id)
      this.db.prepare("UPDATE cloud_runs SET status='running', started_at=COALESCE(started_at,?), session_id=COALESCE(?,session_id), lease_until=? WHERE id=?").run(progress.startedAt, progress.sessionId ?? null, this.iso(this.now() + CLAIM_LEASE_MS), id)
      return this.run(employeeId, id)
    })
  }
  attachArtifact(employeeId: string, id: string, artifact: ArtifactInfo): CloudRun {
    return this.transaction(() => {
      this.activeRun(employeeId, id)
      this.db.prepare('UPDATE cloud_runs SET artifact_json=?, lease_until=? WHERE id=?').run(JSON.stringify(ArtifactInfoSchema.parse(artifact)), this.iso(this.now() + CLAIM_LEASE_MS), id)
      return this.run(employeeId, id)
    })
  }
  completeRun(employeeId: string, id: string, completion: RunCompletion): CloudRun {
    return this.transaction(() => {
      const row = this.activeRun(employeeId, id)
      const stored = row.artifact_json === null ? undefined : ArtifactInfoSchema.parse(JSON.parse(String(row.artifact_json)))
      if (completion.artifact !== undefined && (stored === undefined || stored.sha256 !== completion.artifact.sha256 || stored.size !== completion.artifact.size || stored.fileCount !== completion.artifact.fileCount)) throw new CloudError('ARTIFACT_MISMATCH', 409, 'completion artifact does not match the uploaded file')
      const now = this.iso()
      this.db.prepare('UPDATE cloud_runs SET status=?, finished_at=?, summary=?, error_code=?, session_id=COALESCE(?,session_id), auto_decisions=COALESCE(?,auto_decisions), artifact_json=? WHERE id=?')
        .run(completion.status, completion.finishedAt, completion.summary, completion.errorCode, completion.sessionId ?? null, completion.autoDecisions ?? null, completion.artifact === undefined ? row.artifact_json ?? null : JSON.stringify(completion.artifact), id)
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(now, employeeId)
      return this.run(employeeId, id)
    })
  }
  private lockedRun(employeeId: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM cloud_runs WHERE id=? AND employee_id=?').get(id, employeeId)
    if (!row) throw new CloudError('NOT_FOUND', 404)
    return row
  }
  private activeRun(employeeId: string, id: string): Row {
    const row = this.lockedRun(employeeId, id)
    if (row.status !== 'claimed' && row.status !== 'running') throw new CloudError('INVALID_REQUEST', 409, `run is ${String(row.status)}`)
    if (row.lease_until === null || Date.parse(String(row.lease_until)) <= this.now()) throw new CloudError('INVALID_REQUEST', 409, 'run lease expired')
    return row
  }
  private runRecord(row: Row): CloudRun {
    return CloudRunSchema.parse({
      id: row.id, taskId: row.task_id, employeeId: row.employee_id, taskName: row.task_name, status: row.status, trigger: row.trigger,
      scheduledAt: row.scheduled_at, queuedAt: row.queued_at,
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}), ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      summary: row.summary, errorCode: row.error_code, ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.auto_decisions === null ? {} : { autoDecisions: Number(row.auto_decisions) }),
      ...(row.artifact_json ? { artifact: JSON.parse(String(row.artifact_json)) } : {}), cancelRequested: Number(row.cancel_requested) === 1,
    })
  }

  // ── Scheduler support ──────────────────────────────────────────────────
  /** One scheduler pass over the database: fire due tasks, recycle expired leases, drop stale queue entries. */
  advance(now = this.now()): TickResult {
    return this.transaction(() => {
      const result: TickResult = { enqueued: [], requeued: [], failed: [], expired: [] }
      const nowIso = this.iso(now)
      for (const row of this.db.prepare("SELECT * FROM cloud_tasks WHERE state='scheduled' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 500").all(nowIso)) {
        const employeeId = String(row.employee_id), id = String(row.id)
        const queued = Number(this.db.prepare("SELECT COUNT(*) AS value FROM cloud_runs WHERE employee_id=? AND status='queued'").get(employeeId)!.value)
        // A full queue leaves the task due; it fires once the executor drains the backlog.
        if (queued >= MAX_QUEUED_RUNS_PER_USER) continue
        const run = this.enqueueLocked(employeeId, id, 'schedule', Date.parse(String(row.next_run_at)))
        result.enqueued.push(run.id)
        const next = nextRunAt(this.storedDefinition(row), now)
        this.db.prepare('UPDATE cloud_tasks SET next_run_at=?, updated_at=? WHERE id=?').run(next === null ? null : this.iso(next), nowIso, id)
      }
      for (const row of this.db.prepare("SELECT id, lease_expirations, cancel_requested FROM cloud_runs WHERE status IN ('claimed','running') AND lease_until<=? LIMIT 500").all(nowIso)) {
        const id = String(row.id)
        if (Number(row.cancel_requested) === 1) {
          this.db.prepare("UPDATE cloud_runs SET status='cancelled', finished_at=?, lease_until=NULL WHERE id=?").run(nowIso, id)
        } else if (Number(row.lease_expirations) >= MAX_LEASE_EXPIRATIONS) {
          this.db.prepare("UPDATE cloud_runs SET status='failed', finished_at=?, error_code='lease-expired', lease_until=NULL WHERE id=?").run(nowIso, id)
          result.failed.push(id)
        } else {
          this.db.prepare("UPDATE cloud_runs SET status='queued', claimed_at=NULL, started_at=NULL, lease_until=NULL, executor_instance=NULL, lease_expirations=lease_expirations+1 WHERE id=?").run(id)
          result.requeued.push(id)
        }
      }
      for (const row of this.db.prepare("SELECT id FROM cloud_runs WHERE status='queued' AND queued_at<? LIMIT 500").all(this.iso(now - QUEUED_EXPIRY_MS))) {
        this.db.prepare("UPDATE cloud_runs SET status='expired', finished_at=?, error_code='queue-expired' WHERE id=?").run(nowIso, String(row.id))
        result.expired.push(String(row.id))
      }
      return result
    })
  }
  /** Users who currently need a live instance. */
  employeesWithPendingRuns(): string[] {
    return this.db.prepare("SELECT DISTINCT employee_id FROM cloud_runs WHERE status IN ('queued','claimed','running') ORDER BY employee_id LIMIT 1000").all().map(row => String(row.employee_id))
  }
  /** Live instances without pending runs whose last activity is older than the threshold. */
  idleInstances(idleBefore: number): string[] {
    return this.db.prepare(`SELECT employee_id FROM cloud_instances i WHERE i.state IN ('starting','running') AND i.last_activity_at<?
      AND NOT EXISTS (SELECT 1 FROM cloud_runs r WHERE r.employee_id=i.employee_id AND r.status IN ('queued','claimed','running')) ORDER BY employee_id LIMIT 1000`).all(this.iso(idleBefore)).map(row => String(row.employee_id))
  }
  /** Drop finished runs older than the retention window; returns the run ids whose artifacts must be deleted. */
  maintain(): string[] {
    return this.transaction(() => {
      const before = this.iso(this.now() - RESULT_RETENTION_DAYS * DAY)
      const ids = this.db.prepare('SELECT id FROM cloud_runs WHERE finished_at IS NOT NULL AND finished_at<? LIMIT 5000').all(before).map(row => String(row.id))
      for (const id of ids) this.db.prepare('DELETE FROM cloud_runs WHERE id=?').run(id)
      this.db.prepare('DELETE FROM cloud_tokens WHERE (revoked_at IS NOT NULL AND revoked_at<?) OR (expires_at IS NOT NULL AND expires_at<?)').run(this.iso(this.now() - TOKEN_GRACE_DAYS * DAY), this.iso(this.now() - TOKEN_GRACE_DAYS * DAY))
      return ids
    })
  }
  /** Runs recorded per user for the administrator view (newest first). */
  adminRuns(employeeId: string | undefined, limit: number): CloudRun[] {
    const rows = employeeId === undefined
      ? this.db.prepare('SELECT * FROM cloud_runs ORDER BY queued_at DESC, id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM cloud_runs WHERE employee_id=? ORDER BY queued_at DESC, id DESC LIMIT ?').all(employeeId, limit)
    return rows.map(row => this.runRecord(row))
  }
  close() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* closing anyway */ } this.db.close() }
}
