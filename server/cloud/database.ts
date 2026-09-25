import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  ArtifactInfoSchema, CLAIM_LEASE_MS, CloudRunSchema, CloudSessionSchema, CloudTaskDefinitionSchema, CloudTaskSchema, CloudWorkspaceSchema,
  CreateSessionRequestSchema, CreateWorkspaceRequestSchema, ExecutorCatalogSchema, ExecutorCommandSchema, HEARTBEAT_INTERVAL_MS,
  InstanceStatusSchema, MAX_EVENT_FRAME_BYTES, MAX_QUEUED_RUNS_PER_USER, RESULT_RETENTION_DAYS, SessionEventSchema, isTerminalRunStatus, terminalSessionStates,
  type ArtifactInfo, type ClaimedRun, type CloudRun, type CloudSession, type CloudSessionEvent, type CloudSessionState, type CloudTask, type CloudTaskDefinition,
  type CloudWorkspace, type CommandResult, type ExecutorCatalog, type ExecutorCommand, type ExecutorHeartbeat,
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
export type TickResult = { enqueued: string[]; requeued: string[]; failed: string[]; expired: string[]; commandsRequeued: string[]; commandsFailed: string[] }
export type RunListQuery = { taskId?: string | undefined; limit: number; offset: number }
export type CommandKind = ExecutorCommand['kind']
export type CommandStatus = 'queued' | 'claimed' | 'done' | 'failed'
/** Administrator view of one queued executor command (never exposed to users). */
export type CommandRecord = {
  id: string; employeeId: string; kind: CommandKind; status: CommandStatus; attempts: number; sessionId: string | null; workspaceId: string | null
  createdAt: string; claimedAt: string | null; leaseUntil: string | null; finishedAt: string | null; result: CommandResult | null
}
export type SessionEventPage = { session: CloudSession; events: CloudSessionEvent[]; nextSince: number; hasMore: boolean }
export type CloudDatabaseOptions = {
  /** Called after any change a session's long-poll readers should see (new frames, state, cancel flag). */
  onSessionChange?: ((sessionId: string) => void) | undefined
  /** Frames a session may accumulate before further batches are refused and the session fails (`event-limit`). */
  maxEventsPerSession?: number | undefined
}

const DAY = 86_400_000
/** Queued runs nobody claimed within a day are dropped instead of running long after their slot. */
const QUEUED_EXPIRY_MS = 24 * 3_600_000
/** Two lease expiries send the same run back to the queue; the third fails it. */
const MAX_LEASE_EXPIRATIONS = 2
const CATALOG_STALE_MS = 3 * HEARTBEAT_INTERVAL_MS
const TOKEN_GRACE_DAYS = 30
const MAX_TASKS_PER_USER = 500
/** Phase 2 limits: named workspaces and concurrently open sessions per user, relayed frames per session. */
export const MAX_WORKSPACES_PER_USER = 20
export const MAX_ACTIVE_SESSIONS_PER_USER = 3
export const DEFAULT_MAX_EVENTS_PER_SESSION = 50_000
/** A claimed command whose lease expires returns to the queue once; the second expiry fails it. */
const MAX_COMMAND_ATTEMPTS = 2
const activeSessionStates: readonly CloudSessionState[] = ['queued', 'starting', 'idle', 'running']
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
type Row = Record<string, SQLInputValue>
type CommandPayload = { sessionId?: string; workspaceId?: string; prompt?: string; mode?: 'queue' | 'steer' }

/**
 * Website-owned state for cloud scheduled tasks: tokens (hash only), per-user instances, task definitions with
 * their next trigger, and run records. Synchronous node:sqlite on the main thread: every statement is a point
 * lookup or a tiny scan, and the scheduler tick is the only writer besides request handlers.
 *
 * Phase 2 adds persistent workspaces, interactive sessions with their relayed frames, and the per-user FIFO of
 * executor commands (schema version 2; the migration only adds tables, so version 1 files upgrade in place).
 */
export class CloudDatabase {
  private db: DatabaseSync
  private options: CloudDatabaseOptions
  constructor(directory: string, private now: () => number = Date.now, options: CloudDatabaseOptions = {}) {
    this.options = options
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
      -- Schema 2: workspaces, sessions, relayed frames and the executor command queue (additive, idempotent).
      CREATE TABLE IF NOT EXISTS cloud_workspaces(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL DEFAULT '', snapshot_json TEXT, snapshot_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(employee_id, name));
      CREATE TABLE IF NOT EXISTS cloud_sessions(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, workspace_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', expert_id TEXT NOT NULL, skill_names_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, instance_session_id TEXT, last_seq INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sessions_employee ON cloud_sessions(employee_id, created_at);
      CREATE INDEX IF NOT EXISTS sessions_state ON cloud_sessions(state, employee_id);
      CREATE INDEX IF NOT EXISTS sessions_workspace ON cloud_sessions(workspace_id, state);
      CREATE TABLE IF NOT EXISTS cloud_session_events(session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, frame_json TEXT NOT NULL, PRIMARY KEY(session_id, seq));
      CREATE TABLE IF NOT EXISTS cloud_commands(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, session_id TEXT, workspace_id TEXT, status TEXT NOT NULL, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT, created_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS commands_queue ON cloud_commands(employee_id, status, created_at);
      CREATE INDEX IF NOT EXISTS commands_lease ON cloud_commands(status, lease_until);
      INSERT OR IGNORE INTO schema_version VALUES(2);
    `)
    const version = Number(this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version)
    if (version !== 2) throw new Error('UNSUPPORTED_CLOUD_SCHEMA')
  }

  private iso(epoch = this.now()) { return new Date(epoch).toISOString() }
  /** Sessions touched inside the current transaction; their long-poll readers are woken once it has committed. */
  private changed = new Set<string>()
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    let value: T
    try { value = action(); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); this.changed.clear(); throw error }
    const sessions = [...this.changed]
    this.changed.clear()
    for (const sessionId of sessions) this.options.onSessionChange?.(sessionId)
    return value
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

  // ── Workspaces (phase 2) ───────────────────────────────────────────────
  /** Register a named workspace and queue `workspace.create`; the executor reports the directory it made. */
  createWorkspace(employeeId: string, input: unknown): CloudWorkspace {
    const request = this.parse(CreateWorkspaceRequestSchema, input)
    return this.transaction(() => {
      const count = Number(this.db.prepare('SELECT COUNT(*) AS value FROM cloud_workspaces WHERE employee_id=?').get(employeeId)!.value)
      if (count >= MAX_WORKSPACES_PER_USER) throw new CloudError('QUEUE_FULL', 409, `at most ${MAX_WORKSPACES_PER_USER} workspaces per user`)
      if (this.db.prepare('SELECT 1 FROM cloud_workspaces WHERE employee_id=? AND name=?').get(employeeId, request.name)) throw new CloudError('INVALID_REQUEST', 409, 'a workspace with this name already exists')
      const id = `cw_${randomBytes(16).toString('hex')}`
      const now = this.iso()
      this.db.prepare('INSERT INTO cloud_workspaces(id,employee_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, employeeId, request.name, now, now)
      this.enqueueCommandLocked(employeeId, 'workspace.create', { workspaceId: id })
      return this.workspace(employeeId, id)
    })
  }
  listWorkspaces(employeeId: string): CloudWorkspace[] {
    return this.db.prepare('SELECT * FROM cloud_workspaces WHERE employee_id=? ORDER BY created_at, id LIMIT 200').all(employeeId).map(row => this.workspaceRecord(row))
  }
  workspace(employeeId: string, id: string): CloudWorkspace { return this.workspaceRecord(this.lockedWorkspace(employeeId, id)) }
  /**
   * Remove the record, its pending commands and (for the caller) its snapshot file. The directory inside the instance is
   * left alone in this phase. A workspace with an open session cannot be deleted (TASK_RUNNING).
   */
  deleteWorkspace(employeeId: string, id: string): { hadSnapshot: boolean } {
    return this.transaction(() => {
      const row = this.lockedWorkspace(employeeId, id)
      const active = Number(this.db.prepare(`SELECT COUNT(*) AS value FROM cloud_sessions WHERE workspace_id=? AND state IN (${activeSessionStates.map(() => '?').join(',')})`).get(id, ...activeSessionStates)!.value)
      if (active > 0) throw new CloudError('TASK_RUNNING', 409, 'close the sessions using this workspace first')
      const now = this.iso()
      for (const command of this.db.prepare("SELECT id FROM cloud_commands WHERE workspace_id=? AND status IN ('queued','claimed')").all(id)) {
        this.finishCommand(String(command.id), { status: 'failed', errorCode: 'workspace-deleted', message: 'the workspace was deleted before the command ran' }, now)
      }
      this.db.prepare('DELETE FROM cloud_workspaces WHERE id=?').run(id)
      return { hadSnapshot: row.snapshot_json !== null }
    })
  }
  /** Queue `workspace.snapshot` unless one is already pending for this workspace. */
  requestWorkspaceSnapshot(employeeId: string, id: string): CloudWorkspace {
    return this.transaction(() => {
      this.lockedWorkspace(employeeId, id)
      const pending = this.db.prepare("SELECT 1 FROM cloud_commands WHERE workspace_id=? AND kind='workspace.snapshot' AND status IN ('queued','claimed')").get(id)
      if (!pending) this.enqueueCommandLocked(employeeId, 'workspace.snapshot', { workspaceId: id })
      return this.workspace(employeeId, id)
    })
  }
  /** The executor uploaded a snapshot archive (the `workspace.snapshot` result confirms the same bytes afterwards). */
  setWorkspaceSnapshot(employeeId: string, id: string, artifact: ArtifactInfo): CloudWorkspace {
    return this.transaction(() => {
      this.lockedWorkspace(employeeId, id)
      const now = this.iso()
      this.db.prepare('UPDATE cloud_workspaces SET snapshot_json=?, snapshot_at=?, updated_at=? WHERE id=?').run(JSON.stringify(ArtifactInfoSchema.parse(artifact)), now, now, id)
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(now, employeeId)
      return this.workspace(employeeId, id)
    })
  }
  private lockedWorkspace(employeeId: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM cloud_workspaces WHERE id=? AND employee_id=?').get(id, employeeId)
    if (!row) throw new CloudError('NOT_FOUND', 404)
    return row
  }
  private workspaceRecord(row: Row): CloudWorkspace {
    return CloudWorkspaceSchema.parse({
      id: row.id, employeeId: row.employee_id, name: row.name, relativePath: row.relative_path, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.snapshot_json ? { snapshot: JSON.parse(String(row.snapshot_json)), snapshotAt: row.snapshot_at } : {}),
    })
  }

  // ── Sessions (phase 2) ─────────────────────────────────────────────────
  /** Create a queued session and its `session.start` command (first prompt included); at most 3 open sessions per user. */
  createSession(employeeId: string, input: unknown): CloudSession {
    const request = this.parse(CreateSessionRequestSchema, input)
    return this.transaction(() => {
      this.lockedWorkspace(employeeId, request.workspaceId)
      const active = Number(this.db.prepare(`SELECT COUNT(*) AS value FROM cloud_sessions WHERE employee_id=? AND state IN (${activeSessionStates.map(() => '?').join(',')})`).get(employeeId, ...activeSessionStates)!.value)
      if (active >= MAX_ACTIVE_SESSIONS_PER_USER) throw new CloudError('QUEUE_FULL', 409, `at most ${MAX_ACTIVE_SESSIONS_PER_USER} open sessions per user`)
      const id = `cs_${randomBytes(16).toString('hex')}`
      const now = this.iso()
      this.db.prepare('INSERT INTO cloud_sessions(id,employee_id,workspace_id,title,expert_id,skill_names_json,state,created_at,updated_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, employeeId, request.workspaceId, request.title, request.expertId, JSON.stringify(request.skillNames), 'queued', now, now, now)
      this.enqueueCommandLocked(employeeId, 'session.start', { sessionId: id, workspaceId: request.workspaceId, prompt: request.prompt })
      this.changed.add(id)
      return this.session(employeeId, id)
    })
  }
  listSessions(employeeId: string): CloudSession[] {
    return this.db.prepare('SELECT * FROM cloud_sessions WHERE employee_id=? ORDER BY created_at DESC, id DESC LIMIT 200').all(employeeId).map(row => this.sessionRecord(row))
  }
  session(employeeId: string, id: string): CloudSession { return this.sessionRecord(this.lockedSession(employeeId, id)) }
  /** Follow-up prompt: only an idle or running session accepts one; the executor decides how `queue`/`steer` maps onto DSH. */
  promptSession(employeeId: string, id: string, request: { prompt: string; mode: 'queue' | 'steer' }): CloudSession {
    return this.transaction(() => {
      const row = this.lockedSession(employeeId, id)
      if (row.state !== 'idle' && row.state !== 'running') throw new CloudError('INVALID_REQUEST', 409, `session is ${String(row.state)}`)
      this.enqueueCommandLocked(employeeId, 'session.prompt', { sessionId: id, prompt: request.prompt, mode: request.mode })
      const now = this.iso()
      this.db.prepare('UPDATE cloud_sessions SET updated_at=?, last_activity_at=? WHERE id=?').run(now, now, id)
      this.changed.add(id)
      return this.session(employeeId, id)
    })
  }
  /** Cancel the current turn: flag the session (visible on the next frame batch) and queue `session.cancel`. */
  cancelSession(employeeId: string, id: string): CloudSession {
    return this.transaction(() => {
      const row = this.lockedSession(employeeId, id)
      if (row.state !== 'starting' && row.state !== 'idle' && row.state !== 'running') throw new CloudError('INVALID_REQUEST', 409, `session is ${String(row.state)}`)
      const now = this.iso()
      this.db.prepare('UPDATE cloud_sessions SET cancel_requested=1, updated_at=?, last_activity_at=? WHERE id=?').run(now, now, id)
      if (!this.db.prepare("SELECT 1 FROM cloud_commands WHERE session_id=? AND kind='session.cancel' AND status IN ('queued','claimed')").get(id)) this.enqueueCommandLocked(employeeId, 'session.cancel', { sessionId: id })
      this.changed.add(id)
      return this.session(employeeId, id)
    })
  }
  /** Close: a session that has not started ends immediately; a live one gets `session.close` and closes when the executor confirms. */
  closeSession(employeeId: string, id: string): CloudSession {
    return this.transaction(() => { this.closeSessionLocked(this.lockedSession(employeeId, id)); return this.session(employeeId, id) })
  }
  adminCloseSession(id: string): CloudSession & { cancelRequested: boolean } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM cloud_sessions WHERE id=?').get(id)
      if (!row) throw new CloudError('NOT_FOUND', 404)
      this.closeSessionLocked(row)
      return this.adminSessionRecord(this.db.prepare('SELECT * FROM cloud_sessions WHERE id=?').get(id)!)
    })
  }
  private closeSessionLocked(row: Row) {
    const id = String(row.id), state = row.state as CloudSessionState
    if (terminalSessionStates.includes(state)) return
    const now = this.iso()
    if (state === 'queued') {
      this.db.prepare("UPDATE cloud_sessions SET state='closed', cancel_requested=0, updated_at=?, last_activity_at=? WHERE id=?").run(now, now, id)
      this.finishSessionCommands(id, 'session-closed', 'the session was closed before it started', now)
    } else {
      this.db.prepare('UPDATE cloud_sessions SET updated_at=?, last_activity_at=? WHERE id=?').run(now, now, id)
      if (!this.db.prepare("SELECT 1 FROM cloud_commands WHERE session_id=? AND kind='session.close' AND status IN ('queued','claimed')").get(id)) this.enqueueCommandLocked(String(row.employee_id), 'session.close', { sessionId: id })
    }
    this.changed.add(id)
  }
  /** Page of relayed frames after `since` (ascending), plus the current session record. */
  sessionEvents(employeeId: string, id: string, since: number, limit: number): SessionEventPage {
    const session = this.session(employeeId, id)
    const rows = this.db.prepare('SELECT seq, at, frame_json FROM cloud_session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, since, limit + 1)
    const page = rows.slice(0, limit)
    const events = page.map(row => SessionEventSchema.parse({ seq: Number(row.seq), at: row.at, frame: JSON.parse(String(row.frame_json)) }))
    return { session, events, nextSince: events.length ? events[events.length - 1]!.seq : since, hasMore: rows.length > limit }
  }
  /**
   * Store a contiguous batch from the executor. Frames already stored (seq ≤ lastSeq, a retry) are ignored; a batch that
   * starts beyond lastSeq + 1 is refused with the current lastSeq in the message so the executor can resend from there.
   */
  appendSessionFrames(employeeId: string, id: string, events: CloudSessionEvent[]): { lastSeq: number; cancelRequested: boolean } {
    const limit = this.options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION
    const row = this.lockedSession(employeeId, id)
    if (row.state === 'failed') throw new CloudError('INVALID_REQUEST', 409, 'session is failed')
    for (let index = 1; index < events.length; index += 1) if (events[index]!.seq !== events[index - 1]!.seq + 1) throw new CloudError('INVALID_REQUEST', 400, 'batch sequence numbers are not contiguous')
    const lastSeq = Number(row.last_seq)
    const first = events[0]!.seq
    if (first > lastSeq + 1) throw new CloudError('INVALID_REQUEST', 409, `sequence gap: expected ${lastSeq + 1}, got ${first}; lastSeq=${lastSeq}`)
    const fresh = events.filter(event => event.seq > lastSeq)
    if (lastSeq + fresh.length > limit) {
      this.transaction(() => this.failSessionLocked(id, 'event-limit', `more than ${limit} frames were relayed`))
      throw new CloudError('INVALID_REQUEST', 409, `event limit of ${limit} frames reached; the session has been failed`)
    }
    for (const event of fresh) if (Buffer.byteLength(JSON.stringify(event.frame)) > MAX_EVENT_FRAME_BYTES) throw new CloudError('INVALID_REQUEST', 413, `frame ${event.seq} exceeds ${MAX_EVENT_FRAME_BYTES} bytes`)
    return this.transaction(() => {
      const current = this.db.prepare('SELECT last_seq, cancel_requested FROM cloud_sessions WHERE id=?').get(id)!
      let seq = Number(current.last_seq)
      for (const event of fresh) {
        if (event.seq <= seq) continue
        if (event.seq !== seq + 1) throw new CloudError('INVALID_REQUEST', 409, `sequence gap: expected ${seq + 1}, got ${event.seq}; lastSeq=${seq}`)
        this.db.prepare('INSERT INTO cloud_session_events(session_id,seq,at,frame_json) VALUES(?,?,?,?)').run(id, event.seq, event.at, JSON.stringify(event.frame))
        seq = event.seq
      }
      const now = this.iso()
      this.db.prepare('UPDATE cloud_sessions SET last_seq=?, updated_at=?, last_activity_at=? WHERE id=?').run(seq, now, now, id)
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(now, employeeId)
      if (seq !== Number(current.last_seq)) this.changed.add(id)
      return { lastSeq: seq, cancelRequested: Number(current.cancel_requested) === 1 }
    })
  }
  /** Executor state report; terminal sessions are immutable (a repeated report is a no-op). */
  reportSessionStatus(employeeId: string, id: string, report: { state: 'idle' | 'running' | 'closed' | 'failed'; turns?: number | undefined; errorCode: string; errorMessage: string }): CloudSession {
    return this.transaction(() => {
      const row = this.lockedSession(employeeId, id)
      if (terminalSessionStates.includes(row.state as CloudSessionState)) return this.sessionRecord(row)
      const now = this.iso()
      const clearsCancel = report.state !== 'running'
      this.db.prepare('UPDATE cloud_sessions SET state=?, turns=COALESCE(?,turns), error_code=?, error_message=?, updated_at=?, last_activity_at=?, cancel_requested=CASE WHEN ? THEN 0 ELSE cancel_requested END WHERE id=?')
        .run(report.state, report.turns ?? null, report.errorCode, report.errorMessage.slice(0, 500), now, now, clearsCancel ? 1 : 0, id)
      if (report.state === 'closed' || report.state === 'failed') this.finishSessionCommands(id, report.state === 'closed' ? 'session-closed' : 'session-failed', `the session is ${report.state}`, now)
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(now, employeeId)
      this.changed.add(id)
      return this.session(employeeId, id)
    })
  }
  /** Instance going away: idle/running sessions are closed with the reason and their pending commands dropped. Returns the closed ids. */
  closeSessionsForInstance(employeeId: string, errorCode: string, errorMessage: string): string[] {
    return this.transaction(() => {
      const ids = this.db.prepare("SELECT id FROM cloud_sessions WHERE employee_id=? AND state IN ('idle','running')").all(employeeId).map(row => String(row.id))
      const now = this.iso()
      for (const id of ids) {
        this.db.prepare("UPDATE cloud_sessions SET state='closed', error_code=?, error_message=?, cancel_requested=0, updated_at=?, last_activity_at=? WHERE id=?").run(errorCode, errorMessage.slice(0, 500), now, now, id)
        this.finishSessionCommands(id, 'session-closed', errorMessage, now)
        this.changed.add(id)
      }
      return ids
    })
  }
  private failSessionLocked(id: string, errorCode: string, errorMessage: string) {
    const now = this.iso()
    const changed = this.db.prepare("UPDATE cloud_sessions SET state='failed', error_code=?, error_message=?, cancel_requested=0, updated_at=?, last_activity_at=? WHERE id=? AND state NOT IN ('closed','failed')").run(errorCode, errorMessage.slice(0, 500), now, now, id).changes
    if (Number(changed) > 0) { this.finishSessionCommands(id, 'session-failed', errorMessage, now); this.changed.add(id) }
  }
  private finishSessionCommands(sessionId: string, errorCode: string, message: string, nowIso: string) {
    for (const command of this.db.prepare("SELECT id FROM cloud_commands WHERE session_id=? AND status IN ('queued','claimed')").all(sessionId)) {
      this.finishCommand(String(command.id), { status: 'failed', errorCode, message }, nowIso)
    }
  }
  private lockedSession(employeeId: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM cloud_sessions WHERE id=? AND employee_id=?').get(id, employeeId)
    if (!row) throw new CloudError('NOT_FOUND', 404)
    return row
  }
  private sessionRecord(row: Row): CloudSession {
    return CloudSessionSchema.parse({
      id: row.id, employeeId: row.employee_id, workspaceId: row.workspace_id, title: row.title, expertId: row.expert_id, skillNames: JSON.parse(String(row.skill_names_json)),
      state: row.state, ...(row.instance_session_id ? { instanceSessionId: row.instance_session_id } : {}), lastSeq: Number(row.last_seq), turns: Number(row.turns),
      errorCode: row.error_code, errorMessage: row.error_message, cancelRequested: Number(row.cancel_requested) === 1,
      createdAt: row.created_at, updatedAt: row.updated_at, lastActivityAt: row.last_activity_at,
    })
  }
  private adminSessionRecord(row: Row): CloudSession & { cancelRequested: boolean } { return this.sessionRecord(row) }

  // ── Executor commands (phase 2) ────────────────────────────────────────
  private enqueueCommandLocked(employeeId: string, kind: CommandKind, payload: CommandPayload): string {
    const id = `cc_${randomBytes(16).toString('hex')}`
    this.db.prepare("INSERT INTO cloud_commands(id,employee_id,kind,payload_json,session_id,workspace_id,status,created_at) VALUES(?,?,?,?,?,?,'queued',?)")
      .run(id, employeeId, kind, JSON.stringify(payload), payload.sessionId ?? null, payload.workspaceId ?? null, this.iso())
    return id
  }
  /** Hand the user's oldest queued command to the executor (FIFO); `session.start` moves its session to `starting`. */
  claimCommand(employeeId: string): { command: ExecutorCommand; leaseMs: number } | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM cloud_commands WHERE employee_id=? AND status='queued' ORDER BY created_at, rowid LIMIT 1").get(employeeId)
      if (!row) return undefined
      const now = this.iso()
      const id = String(row.id)
      this.db.prepare("UPDATE cloud_commands SET status='claimed', claimed_at=?, lease_until=?, attempts=attempts+1 WHERE id=?").run(now, this.iso(this.now() + CLAIM_LEASE_MS), id)
      if (row.session_id !== null) {
        if (row.kind === 'session.start') this.db.prepare("UPDATE cloud_sessions SET state='starting', updated_at=? WHERE id=? AND state='queued'").run(now, String(row.session_id))
        this.db.prepare('UPDATE cloud_sessions SET last_activity_at=? WHERE id=?').run(now, String(row.session_id))
        this.changed.add(String(row.session_id))
      }
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(now, employeeId)
      return { command: this.commandForExecutor(this.db.prepare('SELECT * FROM cloud_commands WHERE id=?').get(id)!), leaseMs: CLAIM_LEASE_MS }
    })
  }
  private commandForExecutor(row: Row): ExecutorCommand {
    const payload = JSON.parse(String(row.payload_json)) as CommandPayload
    const session = row.session_id === null ? undefined : this.db.prepare('SELECT * FROM cloud_sessions WHERE id=?').get(String(row.session_id))
    const workspaceId = payload.workspaceId ?? (session ? String(session.workspace_id) : undefined)
    const workspace = workspaceId === undefined ? undefined : this.db.prepare('SELECT * FROM cloud_workspaces WHERE id=?').get(workspaceId)
    return ExecutorCommandSchema.parse({
      id: row.id, kind: row.kind, employeeId: row.employee_id, queuedAt: row.created_at,
      ...(session ? { session: this.sessionRecord(session) } : {}),
      ...(workspace ? { workspace: this.workspaceRecord(workspace) } : {}),
      ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}), ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
    })
  }
  /**
   * Executor result. `done` applies the kind's effect (workspace path, snapshot confirmation, DSH session id, cancel flag,
   * close); `failed` fails the session. Reporting a command that already finished is a harmless no-op (retries).
   */
  completeCommand(employeeId: string, id: string, result: CommandResult): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM cloud_commands WHERE id=? AND employee_id=?').get(id, employeeId)
      if (!row) throw new CloudError('NOT_FOUND', 404)
      if (row.status === 'done' || row.status === 'failed') return
      const kind = String(row.kind) as CommandKind, sessionId = row.session_id === null ? undefined : String(row.session_id), workspaceId = row.workspace_id === null ? undefined : String(row.workspace_id)
      const now = this.iso()
      if (result.status === 'failed') {
        this.finishCommand(id, result, now)
        if (sessionId) this.failSessionLocked(sessionId, result.errorCode || 'command-failed', result.message || `${kind} failed in the instance`)
        return
      }
      if (kind === 'workspace.create') {
        if (!result.relativePath) throw new CloudError('INVALID_REQUEST', 400, 'relativePath is required for workspace.create')
        this.db.prepare('UPDATE cloud_workspaces SET relative_path=?, updated_at=? WHERE id=?').run(result.relativePath, now, workspaceId ?? '')
      } else if (kind === 'workspace.snapshot' && result.artifact !== undefined) {
        const stored = workspaceId === undefined ? undefined : this.db.prepare('SELECT snapshot_json FROM cloud_workspaces WHERE id=?').get(workspaceId)?.snapshot_json
        const current = stored ? ArtifactInfoSchema.parse(JSON.parse(String(stored))) : undefined
        if (!current || current.sha256 !== result.artifact.sha256 || current.size !== result.artifact.size) throw new CloudError('ARTIFACT_MISMATCH', 409, 'snapshot result does not match the uploaded archive')
      } else if (kind === 'session.start') {
        if (!result.instanceSessionId) throw new CloudError('INVALID_REQUEST', 400, 'instanceSessionId is required for session.start')
        this.db.prepare("UPDATE cloud_sessions SET instance_session_id=?, state=CASE WHEN state IN ('queued','starting') THEN 'running' ELSE state END, updated_at=?, last_activity_at=? WHERE id=?").run(result.instanceSessionId, now, now, sessionId ?? '')
      } else if (kind === 'session.cancel') {
        this.db.prepare('UPDATE cloud_sessions SET cancel_requested=0, updated_at=? WHERE id=?').run(now, sessionId ?? '')
      } else if (kind === 'session.close') {
        this.db.prepare("UPDATE cloud_sessions SET state='closed', cancel_requested=0, updated_at=?, last_activity_at=? WHERE id=? AND state NOT IN ('closed','failed')").run(now, now, sessionId ?? '')
        if (sessionId) this.finishSessionCommands(sessionId, 'session-closed', 'the session was closed', now)
      } else if (kind === 'session.prompt') {
        this.db.prepare('UPDATE cloud_sessions SET last_activity_at=? WHERE id=?').run(now, sessionId ?? '')
      }
      this.finishCommand(id, result, now)
      this.db.prepare('UPDATE cloud_instances SET last_activity_at=? WHERE employee_id=?').run(now, employeeId)
      if (sessionId) this.changed.add(sessionId)
    })
  }
  private finishCommand(id: string, result: CommandResult, nowIso: string) {
    this.db.prepare('UPDATE cloud_commands SET status=?, result_json=?, finished_at=?, lease_until=NULL WHERE id=?').run(result.status, JSON.stringify(result), nowIso, id)
  }
  private commandRecord(row: Row): CommandRecord {
    const text = (value: SQLInputValue | undefined) => value === null || value === undefined ? null : String(value)
    return {
      id: String(row.id), employeeId: String(row.employee_id), kind: row.kind as CommandKind, status: row.status as CommandStatus, attempts: Number(row.attempts),
      sessionId: text(row.session_id), workspaceId: text(row.workspace_id), createdAt: String(row.created_at), claimedAt: text(row.claimed_at), leaseUntil: text(row.lease_until), finishedAt: text(row.finished_at),
      result: row.result_json ? JSON.parse(String(row.result_json)) as CommandResult : null,
    }
  }
  adminSessions(employeeId: string | undefined, limit: number): (CloudSession & { cancelRequested: boolean })[] {
    const rows = employeeId === undefined
      ? this.db.prepare('SELECT * FROM cloud_sessions ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM cloud_sessions WHERE employee_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(employeeId, limit)
    return rows.map(row => this.adminSessionRecord(row))
  }
  adminCommands(employeeId: string | undefined, limit: number): CommandRecord[] {
    const rows = employeeId === undefined
      ? this.db.prepare('SELECT * FROM cloud_commands ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM cloud_commands WHERE employee_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(employeeId, limit)
    return rows.map(row => this.commandRecord(row))
  }
  adminWorkspaces(employeeId: string | undefined): CloudWorkspace[] {
    const rows = employeeId === undefined
      ? this.db.prepare('SELECT * FROM cloud_workspaces ORDER BY created_at DESC, id DESC LIMIT 500').all()
      : this.db.prepare('SELECT * FROM cloud_workspaces WHERE employee_id=? ORDER BY created_at DESC, id DESC LIMIT 500').all(employeeId)
    return rows.map(row => this.workspaceRecord(row))
  }
  private parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T {
    const result = schema.safeParse(input)
    if (!result.success) { const issue = result.error.issues[0]; throw new CloudError('INVALID_REQUEST', 400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request') }
    return result.data
  }

  // ── Scheduler support ──────────────────────────────────────────────────
  /** One scheduler pass over the database: fire due tasks, recycle expired leases, drop stale queue entries. */
  advance(now = this.now()): TickResult {
    return this.transaction(() => {
      const result: TickResult = { enqueued: [], requeued: [], failed: [], expired: [], commandsRequeued: [], commandsFailed: [] }
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
      // Command leases: the first expiry returns the command to the queue, the second fails it (and its session).
      for (const row of this.db.prepare("SELECT id, kind, attempts, session_id FROM cloud_commands WHERE status='claimed' AND lease_until<? LIMIT 500").all(nowIso)) {
        const id = String(row.id), kind = String(row.kind) as CommandKind
        if (Number(row.attempts) >= MAX_COMMAND_ATTEMPTS) {
          this.finishCommand(id, { status: 'failed', errorCode: 'command-lease-expired', message: 'the executor did not report a result before the lease expired' }, nowIso)
          if (row.session_id !== null) this.failSessionLocked(String(row.session_id), 'command-lease-expired', `${kind} was not completed by the instance`)
          result.commandsFailed.push(id)
        } else {
          this.db.prepare("UPDATE cloud_commands SET status='queued', lease_until=NULL, claimed_at=NULL WHERE id=?").run(id)
          if (kind === 'session.start' && row.session_id !== null) this.db.prepare("UPDATE cloud_sessions SET state='queued', updated_at=? WHERE id=? AND state='starting'").run(nowIso, String(row.session_id))
          result.commandsRequeued.push(id)
        }
      }
      return result
    })
  }
  /** Users who currently need a live instance: pending runs, queued commands or a session that is not finished. */
  employeesNeedingInstance(): string[] {
    return this.db.prepare(`SELECT DISTINCT employee_id FROM (
      SELECT employee_id FROM cloud_runs WHERE status IN ('queued','claimed','running')
      UNION SELECT employee_id FROM cloud_commands WHERE status IN ('queued','claimed')
      UNION SELECT employee_id FROM cloud_sessions WHERE state IN ('queued','starting','running')) ORDER BY employee_id LIMIT 1000`).all().map(row => String(row.employee_id))
  }
  /** Live instances without pending work whose last activity is older than the threshold (idle sessions do not keep an instance up). */
  idleInstances(idleBefore: number): string[] {
    return this.db.prepare(`SELECT employee_id FROM cloud_instances i WHERE i.state IN ('starting','running') AND i.last_activity_at<?
      AND NOT EXISTS (SELECT 1 FROM cloud_runs r WHERE r.employee_id=i.employee_id AND r.status IN ('queued','claimed','running'))
      AND NOT EXISTS (SELECT 1 FROM cloud_commands c WHERE c.employee_id=i.employee_id AND c.status IN ('queued','claimed'))
      AND NOT EXISTS (SELECT 1 FROM cloud_sessions s WHERE s.employee_id=i.employee_id AND s.state IN ('queued','starting','running')) ORDER BY employee_id LIMIT 1000`).all(this.iso(idleBefore)).map(row => String(row.employee_id))
  }
  /** Drop finished runs, sessions (with their frames) and commands older than the retention window; returns the run ids whose artifacts must be deleted. */
  maintain(): string[] {
    return this.transaction(() => {
      const before = this.iso(this.now() - RESULT_RETENTION_DAYS * DAY)
      const ids = this.db.prepare('SELECT id FROM cloud_runs WHERE finished_at IS NOT NULL AND finished_at<? LIMIT 5000').all(before).map(row => String(row.id))
      for (const id of ids) this.db.prepare('DELETE FROM cloud_runs WHERE id=?').run(id)
      this.db.prepare('DELETE FROM cloud_tokens WHERE (revoked_at IS NOT NULL AND revoked_at<?) OR (expires_at IS NOT NULL AND expires_at<?)').run(this.iso(this.now() - TOKEN_GRACE_DAYS * DAY), this.iso(this.now() - TOKEN_GRACE_DAYS * DAY))
      for (const row of this.db.prepare("SELECT id FROM cloud_sessions WHERE state IN ('closed','failed') AND updated_at<? LIMIT 5000").all(before)) {
        this.db.prepare('DELETE FROM cloud_session_events WHERE session_id=?').run(String(row.id))
        this.db.prepare('DELETE FROM cloud_sessions WHERE id=?').run(String(row.id))
      }
      this.db.prepare('DELETE FROM cloud_session_events WHERE session_id NOT IN (SELECT id FROM cloud_sessions)').run()
      this.db.prepare("DELETE FROM cloud_commands WHERE status IN ('done','failed') AND finished_at<?").run(before)
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
