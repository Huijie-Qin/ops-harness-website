import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  ARTIFACT_FILE_COUNT_HEADER, ARTIFACT_SHA256_HEADER, CLOUD_API_BASE, CONTRACT_VERSION, CatalogResponseSchema, ClaimRequestSchema, ClaimedRunSchema,
  CommandClaimResponseSchema, CommandIdSchema, CommandResultSchema, EmployeeIdSchema, ExecutorHeartbeatSchema, HeartbeatResponseSchema, MAX_ARTIFACT_FILES,
  MeResponseSchema, RunCompletionSchema, RunIdSchema, RunListQuerySchema, RunListResponseSchema, RunProgressSchema, RunResponseSchema,
  SessionEventsQuerySchema, SessionEventsResponseSchema, SessionFrameBatchResponseSchema, SessionFrameBatchSchema, SessionIdSchema, SessionListResponseSchema,
  SessionPromptRequestSchema, SessionResponseSchema, SessionStatusReportSchema, Sha256Schema, TaskIdSchema, TaskListResponseSchema, TaskResponseSchema,
  TaskStateRequestSchema, UpdateTaskRequestSchema, WorkspaceIdSchema, WorkspaceListResponseSchema, WorkspaceResponseSchema, bearerToken, terminalSessionStates,
  type CloudErrorCode,
} from '@dsh-ops/cloud-task-contract'
import type { AdminHandler } from '../admin-files.js'
import { GuideError } from '../guide-store.js'
import { workspaceSnapshotKey } from './artifacts.js'
import type { CloudRuntime } from './index.js'
import { CloudError, describeFailure } from './errors.js'
import { CloudEmployeeIdSchema } from './identity.js'

export type CloudHttpOptions = { executorPollMs: number; log?: ((line: string) => void) | undefined; now?: () => number }
const MAX_JSON_BYTES = 64 * 1024
/** A frame batch may carry up to 200 frames of 512 KiB each in theory; executors flush far smaller batches, and this bounds one request. */
export const MAX_FRAME_BATCH_BYTES = 8 * 1024 * 1024
/** Per-token budgets: a user polling an active session and an executor relaying frames for several sessions both exceed the phase-1 300/min. */
const REQUESTS_PER_MINUTE = { user: 600, executor: 1200 } as const
const FAILED_AUTH_PER_MINUTE = 120
const MAX_INFLIGHT = 64
type RouteName =
  | 'me' | 'catalog' | 'tasks' | 'task' | 'taskState' | 'taskRun' | 'runs' | 'run' | 'runCancel' | 'runArtifact'
  | 'executorHeartbeat' | 'executorClaim' | 'executorProgress' | 'executorArtifact' | 'executorComplete'
  | 'workspaces' | 'workspace' | 'workspaceSnapshot' | 'workspaceSnapshotArchive'
  | 'runSession' | 'sessions' | 'session' | 'sessionPrompt' | 'sessionCancel' | 'sessionClose' | 'sessionEvents'
  | 'executorCommandClaim' | 'executorCommandResult' | 'executorSessionFrames' | 'executorSessionStatus' | 'executorWorkspaceSnapshot'
const ID = '([A-Za-z0-9_-]{1,64})'
const routes: { name: RouteName; methods: string[]; pattern: RegExp }[] = [
  { name: 'me', methods: ['GET'], pattern: /^\/me$/ },
  { name: 'catalog', methods: ['GET'], pattern: /^\/catalog$/ },
  { name: 'tasks', methods: ['GET', 'POST'], pattern: /^\/tasks$/ },
  { name: 'task', methods: ['GET', 'PUT', 'DELETE'], pattern: new RegExp(`^/tasks/${ID}$`) },
  { name: 'taskState', methods: ['POST'], pattern: new RegExp(`^/tasks/${ID}/state$`) },
  { name: 'taskRun', methods: ['POST'], pattern: new RegExp(`^/tasks/${ID}/run$`) },
  { name: 'runs', methods: ['GET'], pattern: /^\/runs$/ },
  { name: 'run', methods: ['GET'], pattern: new RegExp(`^/runs/${ID}$`) },
  { name: 'runCancel', methods: ['POST'], pattern: new RegExp(`^/runs/${ID}/cancel$`) },
  { name: 'runArtifact', methods: ['GET'], pattern: new RegExp(`^/runs/${ID}/artifact$`) },
  { name: 'executorHeartbeat', methods: ['POST'], pattern: /^\/executor\/heartbeat$/ },
  { name: 'executorClaim', methods: ['POST'], pattern: /^\/executor\/claim$/ },
  { name: 'executorProgress', methods: ['POST'], pattern: new RegExp(`^/executor/runs/${ID}/progress$`) },
  { name: 'executorArtifact', methods: ['PUT'], pattern: new RegExp(`^/executor/runs/${ID}/artifact$`) },
  { name: 'executorComplete', methods: ['POST'], pattern: new RegExp(`^/executor/runs/${ID}/complete$`) },
  // Phase 2 — workspaces and sessions (user token)
  { name: 'workspaces', methods: ['GET', 'POST'], pattern: /^\/workspaces$/ },
  { name: 'workspace', methods: ['GET', 'DELETE'], pattern: new RegExp(`^/workspaces/${ID}$`) },
  { name: 'workspaceSnapshot', methods: ['POST'], pattern: new RegExp(`^/workspaces/${ID}/snapshot$`) },
  { name: 'workspaceSnapshotArchive', methods: ['GET'], pattern: new RegExp(`^/workspaces/${ID}/snapshot/archive$`) },
  { name: 'sessions', methods: ['GET', 'POST'], pattern: /^\/sessions$/ },
  { name: 'session', methods: ['GET'], pattern: new RegExp(`^/sessions/${ID}$`) },
  { name: 'sessionPrompt', methods: ['POST'], pattern: new RegExp(`^/sessions/${ID}/prompt$`) },
  { name: 'sessionCancel', methods: ['POST'], pattern: new RegExp(`^/sessions/${ID}/cancel$`) },
  { name: 'sessionClose', methods: ['POST'], pattern: new RegExp(`^/sessions/${ID}/close$`) },
  { name: 'runSession', methods: ['POST'], pattern: new RegExp(`^/runs/${ID}/session$`) },
  { name: 'sessionEvents', methods: ['GET'], pattern: new RegExp(`^/sessions/${ID}/events$`) },
  // Phase 2 — command queue and relay (executor token)
  { name: 'executorCommandClaim', methods: ['POST'], pattern: /^\/executor\/commands\/claim$/ },
  { name: 'executorCommandResult', methods: ['POST'], pattern: new RegExp(`^/executor/commands/${ID}/result$`) },
  { name: 'executorSessionFrames', methods: ['POST'], pattern: new RegExp(`^/executor/sessions/${ID}/frames$`) },
  { name: 'executorSessionStatus', methods: ['POST'], pattern: new RegExp(`^/executor/sessions/${ID}/status$`) },
  { name: 'executorWorkspaceSnapshot', methods: ['PUT'], pattern: new RegExp(`^/executor/workspaces/${ID}/snapshot$`) },
]
const IssueTokenSchema = z.object({ employeeId: CloudEmployeeIdSchema, label: z.string().trim().max(80).default(''), expiresInDays: z.number().int().min(1).max(3650).optional() }).strict()
const AdminListQuerySchema = z.object({ employeeId: EmployeeIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict()
const AdminWorkspacesQuerySchema = z.object({ employeeId: EmployeeIdSchema.optional() }).strict()

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}
function empty(res: ServerResponse, status = 204) { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end() }
async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new CloudError('INVALID_REQUEST', 415, 'application/json required')
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new CloudError('INVALID_REQUEST', 415, 'content-encoding not supported')
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new CloudError('INVALID_REQUEST', 413, `body exceeds ${limit} bytes`)
  const timer = setTimeout(() => req.destroy(), 15_000)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new CloudError('INVALID_REQUEST', 413, `body exceeds ${limit} bytes`); chunks.push(Buffer.from(chunk)) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new CloudError('INVALID_REQUEST', 400, 'body is not JSON') }
  } finally { clearTimeout(timer) }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) { const issue = result.error.issues[0]; throw new CloudError('INVALID_REQUEST', 400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request') }
  return result.data
}
const identifier = (schema: z.ZodType<string>) => (value: string) => { const parsed = schema.safeParse(value); if (!parsed.success) throw new CloudError('NOT_FOUND', 404); return parsed.data }
const taskId = identifier(TaskIdSchema), runId = identifier(RunIdSchema), workspaceId = identifier(WorkspaceIdSchema), sessionId = identifier(SessionIdSchema), commandId = identifier(CommandIdSchema)
/** Upload headers shared by run artifacts and workspace snapshots. */
function artifactHeaders(req: IncomingMessage) {
  return {
    sha256: parse(Sha256Schema, String(req.headers[ARTIFACT_SHA256_HEADER] ?? '')),
    fileCount: parse(z.coerce.number().int().min(0).max(MAX_ARTIFACT_FILES), req.headers[ARTIFACT_FILE_COUNT_HEADER] ?? 0),
  }
}

export function createCloudHandlers(runtime: CloudRuntime | undefined, options: CloudHttpOptions) {
  const now = options.now ?? Date.now
  const budgets = new Map<string, { window: number; count: number }>()
  let failedAuth = { window: 0, count: 0 }
  let inflight = 0
  const limited = (key: string, limit: number) => {
    if (budgets.size > 5000) budgets.clear()
    const current = budgets.get(key)
    if (!current || now() - current.window > 60_000) { budgets.set(key, { window: now(), count: 1 }); return false }
    return ++current.count > limit
  }
  const fail = (res: ServerResponse, error: unknown) => {
    if (error instanceof CloudError) {
      if (error.status === 429) res.setHeader('Retry-After', '60')
      if (error.status === 405) res.setHeader('Allow', error.message)
      json(res, { error: error.code, ...(error.status === 405 || error.message === error.code ? {} : { message: error.message }) }, error.status)
      return
    }
    options.log?.(`request failed: ${describeFailure(error)}`)
    if (res.headersSent) { res.destroy(); return }
    json(res, { error: 'INTERNAL' satisfies CloudErrorCode }, 500)
  }
  /** Wake the user's instance now instead of waiting for the next scheduler pass (fire and forget). */
  const wake = (cloud: CloudRuntime, employeeId: string) => { void cloud.instances.ensureRunning(employeeId).catch(error => options.log?.(`wake ${employeeId} failed: ${describeFailure(error)}`)) }

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== CLOUD_API_BASE && !url.pathname.startsWith(`${CLOUD_API_BASE}/`)) return false
    try {
      if (!runtime) throw new CloudError('CLOUD_NOT_ENABLED', 503)
      // Same posture as tracking: Host-to-website only, never a browser page.
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new CloudError('FORBIDDEN', 403, 'browser requests are not accepted')
      const relative = url.pathname.slice(CLOUD_API_BASE.length)
      let match: { route: (typeof routes)[number]; params: string[] } | undefined
      for (const route of routes) { const found = route.pattern.exec(relative); if (found) { match = { route, params: found.slice(1) }; break } }
      if (!match) throw new CloudError('NOT_FOUND', 404)
      if (!match.route.methods.includes(req.method ?? '')) throw new CloudError('METHOD_NOT_ALLOWED', 405, match.route.methods.join(', '))
      const token = bearerToken(req.headers.authorization)
      if (!token) throw new CloudError('UNAUTHORIZED', 401)
      const key = createHash('sha256').update(token).digest('hex')
      const kind = match.route.name.startsWith('executor') ? 'executor' : 'user'
      if (limited(key, REQUESTS_PER_MINUTE[kind]) || inflight >= MAX_INFLIGHT) throw new CloudError('RATE_LIMITED', 429)
      const principal = runtime.db.authenticate(token, kind)
      if (!principal) {
        if (now() - failedAuth.window > 60_000) failedAuth = { window: now(), count: 0 }
        if (++failedAuth.count > FAILED_AUTH_PER_MINUTE) throw new CloudError('RATE_LIMITED', 429)
        throw new CloudError('UNAUTHORIZED', 401)
      }
      inflight++
      const reauthenticate = () => {
        if (runtime.db.authenticate(token, kind)?.employeeId !== principal.employeeId) throw new CloudError('UNAUTHORIZED', 401)
      }
      try { await dispatch(runtime, match.route.name, match.params, principal.employeeId, req, res, url, reauthenticate) }
      finally { inflight-- }
    } catch (error) { fail(res, error) }
    return true
  }

  const dispatch = async (cloud: CloudRuntime, name: RouteName, params: string[], employeeId: string, req: IncomingMessage, res: ServerResponse, url: URL, reauthenticate: () => void) => {
    const { db } = cloud
    switch (name) {
      case 'me': return json(res, MeResponseSchema.parse({ contractVersion: CONTRACT_VERSION, employeeId, displayName: '', instance: db.instanceStatus(employeeId) }))
      case 'catalog': {
        const catalog = db.catalog(employeeId)
        // A new user needs the executor's expert list before they can create their first task.
        // Once a catalog exists, polling it must preserve the instance's idle sleep.
        if (catalog.catalog === null) void cloud.instances.ensureRunning(employeeId).catch(error => options.log?.(`catalog wake ${employeeId} failed: ${describeFailure(error)}`))
        return json(res, CatalogResponseSchema.parse(catalog))
      }
      case 'tasks':
        if (req.method === 'GET') return json(res, TaskListResponseSchema.parse({ tasks: db.listTasks(employeeId) }))
        return json(res, TaskResponseSchema.parse({ task: db.createTask(employeeId, await readJson(req)) }), 201)
      case 'task': {
        const id = taskId(params[0]!)
        if (req.method === 'GET') return json(res, TaskResponseSchema.parse({ task: db.task(employeeId, id) }))
        if (req.method === 'DELETE') { db.deleteTask(employeeId, id); return empty(res) }
        const update = parse(UpdateTaskRequestSchema, await readJson(req))
        return json(res, TaskResponseSchema.parse({ task: db.updateTask(employeeId, id, update.expectedRevision, update.definition) }))
      }
      case 'taskState': {
        const request = parse(TaskStateRequestSchema, await readJson(req))
        return json(res, TaskResponseSchema.parse({ task: db.setTaskState(employeeId, taskId(params[0]!), request.expectedRevision, request.state) }))
      }
      case 'taskRun': {
        const run = db.enqueueRun(employeeId, taskId(params[0]!), 'manual')
        wake(cloud, employeeId)
        return json(res, RunResponseSchema.parse({ run }), 201)
      }
      case 'runs': {
        const query = parse(RunListQuerySchema, Object.fromEntries(url.searchParams))
        return json(res, RunListResponseSchema.parse(db.listRuns(employeeId, query)))
      }
      case 'runSession': {
        const session = db.requestRunSession(employeeId, runId(params[0]!))
        if (session.historyStatus === 'loading') wake(cloud, employeeId)
        return json(res, SessionResponseSchema.parse({ session }))
      }
      case 'run': return json(res, RunResponseSchema.parse({ run: db.run(employeeId, runId(params[0]!)) }))
      case 'runCancel': return json(res, RunResponseSchema.parse({ run: db.cancelRun(employeeId, runId(params[0]!)) }))
      case 'runArtifact': {
        const run = db.run(employeeId, runId(params[0]!))
        if (!run.artifact) throw new CloudError('NOT_FOUND', 404, 'run has no artifact')
        return cloud.artifacts.serve(req, res, run.id, run.artifact)
      }
      case 'executorHeartbeat': {
        const body = await readJson(req)
        if ((body as { contractVersion?: unknown } | null)?.contractVersion !== CONTRACT_VERSION) throw new CloudError('CONTRACT_VERSION_MISMATCH', 409, `website speaks contract ${CONTRACT_VERSION}`)
        const heartbeat = parse(ExecutorHeartbeatSchema, body)
        if (heartbeat.instanceId !== employeeId) throw new CloudError('FORBIDDEN', 403, 'instanceId does not match the executor token')
        const result = db.heartbeat(employeeId, heartbeat)
        return json(res, HeartbeatResponseSchema.parse({ cancelRunIds: result.cancelRunIds, pollIntervalMs: options.executorPollMs, drain: result.drain }))
      }
      case 'executorClaim': {
        const claim = parse(ClaimRequestSchema, await readJson(req))
        if (claim.instanceId !== employeeId) throw new CloudError('FORBIDDEN', 403, 'instanceId does not match the executor token')
        const claimed = db.claimRun(employeeId, claim.instanceId)
        if (!claimed) return empty(res)
        return json(res, ClaimedRunSchema.parse(claimed))
      }
      case 'executorProgress': return json(res, RunResponseSchema.parse({ run: db.progressRun(employeeId, runId(params[0]!), parse(RunProgressSchema, await readJson(req))) }))
      case 'executorArtifact': {
        const id = runId(params[0]!)
        const { sha256, fileCount } = artifactHeaders(req)
        const current = db.run(employeeId, id)
        if (current.status !== 'claimed' && current.status !== 'running') throw new CloudError('INVALID_REQUEST', 409, `run is ${current.status}`)
        const received = await cloud.artifacts.receive(req, id, sha256)
        return json(res, RunResponseSchema.parse({ run: db.attachArtifact(employeeId, id, { size: received.size, sha256: received.sha256, fileCount }) }))
      }
      case 'executorComplete': return json(res, RunResponseSchema.parse({ run: db.completeRun(employeeId, runId(params[0]!), parse(RunCompletionSchema, await readJson(req))) }))

      // ── Phase 2: workspaces ──
      case 'workspaces': {
        if (req.method === 'GET') return json(res, WorkspaceListResponseSchema.parse({ workspaces: db.listWorkspaces(employeeId) }))
        const workspace = db.createWorkspace(employeeId, await readJson(req))
        wake(cloud, employeeId)
        return json(res, WorkspaceResponseSchema.parse({ workspace }), 201)
      }
      case 'workspace': {
        const id = workspaceId(params[0]!)
        if (req.method === 'GET') return json(res, WorkspaceResponseSchema.parse({ workspace: db.workspace(employeeId, id) }))
        const { hadSnapshot } = db.deleteWorkspace(employeeId, id)
        if (hadSnapshot) await cloud.artifacts.remove(workspaceSnapshotKey(id)).catch(error => options.log?.(`snapshot cleanup ${id} failed: ${describeFailure(error)}`))
        return empty(res)
      }
      case 'workspaceSnapshot': {
        const workspace = db.requestWorkspaceSnapshot(employeeId, workspaceId(params[0]!))
        wake(cloud, employeeId)
        return json(res, WorkspaceResponseSchema.parse({ workspace }), 202)
      }
      case 'workspaceSnapshotArchive': {
        const workspace = db.workspace(employeeId, workspaceId(params[0]!))
        if (!workspace.snapshot) throw new CloudError('NOT_FOUND', 404, 'workspace has no snapshot')
        return cloud.artifacts.serve(req, res, workspaceSnapshotKey(workspace.id), workspace.snapshot)
      }

      // ── Phase 2: sessions ──
      case 'sessions': {
        if (req.method === 'GET') return json(res, SessionListResponseSchema.parse({ sessions: db.listSessions(employeeId) }))
        const session = db.createSession(employeeId, await readJson(req))
        wake(cloud, employeeId)
        return json(res, SessionResponseSchema.parse({ session }), 201)
      }
      case 'session': return json(res, SessionResponseSchema.parse({ session: db.session(employeeId, sessionId(params[0]!)) }))
      case 'sessionPrompt': {
        const request = parse(SessionPromptRequestSchema, await readJson(req))
        return json(res, SessionResponseSchema.parse({ session: db.promptSession(employeeId, sessionId(params[0]!), request) }), 202)
      }
      case 'sessionCancel': return json(res, SessionResponseSchema.parse({ session: db.cancelSession(employeeId, sessionId(params[0]!)) }))
      case 'sessionClose': return json(res, SessionResponseSchema.parse({ session: db.closeSession(employeeId, sessionId(params[0]!)) }))
      case 'sessionEvents': {
        const id = sessionId(params[0]!)
        const query = parse(SessionEventsQuerySchema, Object.fromEntries(url.searchParams))
        let page = db.sessionEvents(employeeId, id, query.since, query.limit)
        if (page.events.length === 0 && query.waitMs > 0 && (!terminalSessionStates.includes(page.session.state) || page.session.historyStatus === 'loading')) {
          // Park until the executor relays something or the session changes; the parked reader does not hold an inflight slot.
          inflight--
          try { await cloud.waiters.wait(id, query.waitMs, res) } finally { inflight++ }
          if (res.destroyed || res.writableEnded) return
          // The user's credential can be revoked or expire while this response is parked.
          reauthenticate()
          page = db.sessionEvents(employeeId, id, query.since, query.limit)
        }
        return json(res, SessionEventsResponseSchema.parse(page))
      }

      // ── Phase 2: executor command queue and relay ──
      case 'executorCommandClaim': {
        const claim = parse(ClaimRequestSchema, await readJson(req))
        if (claim.instanceId !== employeeId) throw new CloudError('FORBIDDEN', 403, 'instanceId does not match the executor token')
        const claimed = db.claimCommand(employeeId)
        if (!claimed) return empty(res)
        return json(res, CommandClaimResponseSchema.parse(claimed))
      }
      case 'executorCommandResult': {
        db.completeCommand(employeeId, commandId(params[0]!), parse(CommandResultSchema, await readJson(req)))
        return empty(res)
      }
      case 'executorSessionFrames': {
        const batch = parse(SessionFrameBatchSchema, await readJson(req, MAX_FRAME_BATCH_BYTES))
        return json(res, SessionFrameBatchResponseSchema.parse(db.appendSessionFrames(employeeId, sessionId(params[0]!), batch.events)))
      }
      case 'executorSessionStatus': {
        const report = parse(SessionStatusReportSchema, await readJson(req))
        return json(res, SessionResponseSchema.parse({ session: db.reportSessionStatus(employeeId, sessionId(params[0]!), report) }))
      }
      case 'executorWorkspaceSnapshot': {
        const id = workspaceId(params[0]!)
        const { sha256, fileCount } = artifactHeaders(req)
        db.workspace(employeeId, id)
        const received = await cloud.artifacts.receive(req, workspaceSnapshotKey(id), sha256)
        try {
          return json(res, WorkspaceResponseSchema.parse({ workspace: db.setWorkspaceSnapshot(employeeId, id, { size: received.size, sha256: received.sha256, fileCount }) }))
        } catch (error) {
          // A user can delete the workspace while its archive is still streaming in.
          if (error instanceof CloudError && error.code === 'NOT_FOUND') await cloud.artifacts.remove(workspaceSnapshotKey(id))
          throw error
        }
      }
    }
  }

  const admin: AdminHandler = async (req, res, url, context) => {
    if (!url.pathname.startsWith('/api/admin/cloud/')) return false
    if (!runtime) throw new GuideError('CLOUD_NOT_ENABLED', 503)
    try {
      const { db } = runtime
      if (url.pathname === '/api/admin/cloud/tokens') {
        context.method(req, ['GET', 'POST'])
        if (req.method === 'GET') { context.json(res, { tokens: db.listTokens() }); return true }
        const input = parse(IssueTokenSchema, await context.body(req))
        const issued = db.issueToken({ employeeId: input.employeeId, kind: 'user', label: input.label, expiresAt: input.expiresInDays === undefined ? undefined : now() + input.expiresInDays * 86_400_000 })
        // The plaintext token exists only in this response.
        context.json(res, { token: issued.token, record: issued.record }, 201)
        return true
      }
      const revoke = /^\/api\/admin\/cloud\/tokens\/([0-9a-f]{12,64})$/.exec(url.pathname)
      if (revoke) { context.method(req, ['DELETE']); context.json(res, { token: db.revokeToken(revoke[1]!) }); return true }
      if (url.pathname === '/api/admin/cloud/instances') {
        context.method(req, ['GET'])
        const instances = db.listInstances().map(({ executorTokenHash: _hash, launchUrl, ...record }) => ({ ...record, launchUrl: record.backend === 'process' ? launchUrl : null }))
        context.json(res, { instances, backend: runtime.instances.orchestrator.backend })
        return true
      }
      const stop = /^\/api\/admin\/cloud\/instances\/([a-z0-9._-]{1,64})\/stop$/.exec(url.pathname)
      if (stop) { context.method(req, ['POST']); context.json(res, { instance: await runtime.instances.stop(stop[1]!) }); return true }
      if (url.pathname === '/api/admin/cloud/runs') {
        context.method(req, ['GET'])
        const query = parse(AdminListQuerySchema, Object.fromEntries(url.searchParams))
        context.json(res, { runs: db.adminRuns(query.employeeId, query.limit) })
        return true
      }
      if (url.pathname === '/api/admin/cloud/sessions') {
        context.method(req, ['GET'])
        const query = parse(AdminListQuerySchema, Object.fromEntries(url.searchParams))
        context.json(res, { sessions: db.adminSessions(query.employeeId, query.limit) })
        return true
      }
      const close = /^\/api\/admin\/cloud\/sessions\/(cs_[0-9a-f]{32})\/close$/.exec(url.pathname)
      if (close) { context.method(req, ['POST']); context.json(res, { session: db.adminCloseSession(close[1]!) }); return true }
      if (url.pathname === '/api/admin/cloud/commands') {
        context.method(req, ['GET'])
        const query = parse(AdminListQuerySchema, Object.fromEntries(url.searchParams))
        context.json(res, { commands: db.adminCommands(query.employeeId, query.limit) })
        return true
      }
      if (url.pathname === '/api/admin/cloud/workspaces') {
        context.method(req, ['GET'])
        const query = parse(AdminWorkspacesQuerySchema, Object.fromEntries(url.searchParams))
        context.json(res, { workspaces: db.adminWorkspaces(query.employeeId) })
        return true
      }
      throw new GuideError('NOT_FOUND', 404)
    } catch (error) {
      if (error instanceof CloudError) throw new GuideError(error.code, error.status)
      throw error
    }
  }
  return { api, admin, configured: runtime !== undefined }
}
