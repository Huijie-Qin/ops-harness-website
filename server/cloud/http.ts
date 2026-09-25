import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  CLOUD_API_BASE, CONTRACT_VERSION, CatalogResponseSchema, ClaimRequestSchema, ClaimedRunSchema, EmployeeIdSchema, ExecutorHeartbeatSchema,
  HeartbeatResponseSchema, MAX_ARTIFACT_FILES, MeResponseSchema, RunCompletionSchema, RunIdSchema, RunListQuerySchema, RunListResponseSchema,
  RunProgressSchema, RunResponseSchema, Sha256Schema, TaskIdSchema, TaskListResponseSchema, TaskResponseSchema, TaskStateRequestSchema,
  UpdateTaskRequestSchema, bearerToken, type CloudErrorCode,
} from '@dsh-ops/cloud-task-contract'
import type { AdminHandler } from '../admin-files.js'
import { GuideError } from '../guide-store.js'
import type { CloudRuntime } from './index.js'
import { CloudError, describeFailure } from './errors.js'
import { CloudEmployeeIdSchema } from './identity.js'

export type CloudHttpOptions = { executorPollMs: number; log?: ((line: string) => void) | undefined; now?: () => number }
const MAX_JSON_BYTES = 64 * 1024
const REQUESTS_PER_MINUTE = 300
const FAILED_AUTH_PER_MINUTE = 120
const MAX_INFLIGHT = 64
type RouteName = 'me' | 'catalog' | 'tasks' | 'task' | 'taskState' | 'taskRun' | 'runs' | 'run' | 'runCancel' | 'runArtifact' | 'executorHeartbeat' | 'executorClaim' | 'executorProgress' | 'executorArtifact' | 'executorComplete'
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
]
const IssueTokenSchema = z.object({ employeeId: CloudEmployeeIdSchema, label: z.string().trim().max(80).default(''), expiresInDays: z.number().int().min(1).max(3650).optional() }).strict()
const AdminRunsQuerySchema = z.object({ employeeId: EmployeeIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict()

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}
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
const taskId = (value: string) => { const parsed = TaskIdSchema.safeParse(value); if (!parsed.success) throw new CloudError('NOT_FOUND', 404); return parsed.data }
const runId = (value: string) => { const parsed = RunIdSchema.safeParse(value); if (!parsed.success) throw new CloudError('NOT_FOUND', 404); return parsed.data }

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
      if (limited(key, REQUESTS_PER_MINUTE) || inflight >= MAX_INFLIGHT) throw new CloudError('RATE_LIMITED', 429)
      const kind = match.route.name.startsWith('executor') ? 'executor' : 'user'
      const principal = runtime.db.authenticate(token, kind)
      if (!principal) {
        if (now() - failedAuth.window > 60_000) failedAuth = { window: now(), count: 0 }
        if (++failedAuth.count > FAILED_AUTH_PER_MINUTE) throw new CloudError('RATE_LIMITED', 429)
        throw new CloudError('UNAUTHORIZED', 401)
      }
      inflight++
      try { await dispatch(runtime, match.route.name, match.params, principal.employeeId, req, res, url) }
      finally { inflight-- }
    } catch (error) { fail(res, error) }
    return true
  }

  const dispatch = async (cloud: CloudRuntime, name: RouteName, params: string[], employeeId: string, req: IncomingMessage, res: ServerResponse, url: URL) => {
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
        if (req.method === 'DELETE') { db.deleteTask(employeeId, id); res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return }
        const update = parse(UpdateTaskRequestSchema, await readJson(req))
        return json(res, TaskResponseSchema.parse({ task: db.updateTask(employeeId, id, update.expectedRevision, update.definition) }))
      }
      case 'taskState': {
        const request = parse(TaskStateRequestSchema, await readJson(req))
        return json(res, TaskResponseSchema.parse({ task: db.setTaskState(employeeId, taskId(params[0]!), request.expectedRevision, request.state) }))
      }
      case 'taskRun': {
        const run = db.enqueueRun(employeeId, taskId(params[0]!), 'manual')
        // Wake the instance now instead of waiting for the next scheduler pass.
        void cloud.instances.ensureRunning(employeeId).catch(error => options.log?.(`wake ${employeeId} failed: ${describeFailure(error)}`))
        return json(res, RunResponseSchema.parse({ run }), 201)
      }
      case 'runs': {
        const query = parse(RunListQuerySchema, Object.fromEntries(url.searchParams))
        return json(res, RunListResponseSchema.parse(db.listRuns(employeeId, query)))
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
        if (!claimed) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return }
        return json(res, ClaimedRunSchema.parse(claimed))
      }
      case 'executorProgress': return json(res, RunResponseSchema.parse({ run: db.progressRun(employeeId, runId(params[0]!), parse(RunProgressSchema, await readJson(req))) }))
      case 'executorArtifact': {
        const id = runId(params[0]!)
        const sha256 = parse(Sha256Schema, String(req.headers['x-artifact-sha256'] ?? ''))
        const fileCount = parse(z.coerce.number().int().min(0).max(MAX_ARTIFACT_FILES), req.headers['x-artifact-file-count'] ?? 0)
        const current = db.run(employeeId, id)
        if (current.status !== 'claimed' && current.status !== 'running') throw new CloudError('INVALID_REQUEST', 409, `run is ${current.status}`)
        const received = await cloud.artifacts.receive(req, id, sha256)
        return json(res, RunResponseSchema.parse({ run: db.attachArtifact(employeeId, id, { size: received.size, sha256: received.sha256, fileCount }) }))
      }
      case 'executorComplete': return json(res, RunResponseSchema.parse({ run: db.completeRun(employeeId, runId(params[0]!), parse(RunCompletionSchema, await readJson(req))) }))
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
        const query = parse(AdminRunsQuerySchema, Object.fromEntries(url.searchParams))
        context.json(res, { runs: db.adminRuns(query.employeeId, query.limit) })
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
