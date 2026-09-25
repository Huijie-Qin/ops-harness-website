import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CLAIM_LEASE_MS, MAX_EVENT_FRAME_BYTES, RESULT_RETENTION_DAYS, cloudRoutes,
  type CloudSession, type CloudSessionEvent, type CloudWorkspace, type ExecutorCommand,
} from '@dsh-ops/cloud-task-contract'
import { CloudDatabase, MAX_ACTIVE_SESSIONS_PER_USER, MAX_WORKSPACES_PER_USER, type CommandRecord } from '../server/cloud/database.js'
import { CloudError } from '../server/cloud/errors.js'
import { createCloudHandlers } from '../server/cloud/http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { GuideStore } from '../server/guide-store.js'
import { START, cloudFixture } from './cloud-fixture.js'

const employee = 'w00000042'
const MINUTE = 60_000
type Fixture = Awaited<ReturnType<typeof httpFixture>>
type Claimed = { command: ExecutorCommand; leaseMs: number }

async function httpFixture(t: TestContext, options: { maxEventsPerSession?: number } = {}) {
  const cloud = await cloudFixture(t, {}, options)
  const handlers = createCloudHandlers(cloud.runtime, { executorPollMs: 2500, now: cloud.clock.now })
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
  guide = await createGuideHandler(new GuideStore(path.resolve('content/guide'), path.join(cloud.root, `content-${(server.address() as { port: number }).port}`)), { origin, password: 'test-admin-password-only', admin: handlers.admin })
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
    return (await response.json() as { token: string }).token
  }
  /** Executor token of the user's instance: the instance is launched by the scheduler or the wake-up on demand. */
  const executor = async (id = employee) => {
    await cloud.runtime.instances.ensureRunning(id)
    return cloud.orchestrator.environments.get(id)!.DSH_OPS_CLOUD_EXECUTOR_TOKEN!
  }
  const claim = async (token: string, id = employee): Promise<Claimed | undefined> => {
    const response = await api(cloudRoutes.executorCommandClaim, token, { method: 'POST', data: { instanceId: id } })
    if (response.status === 204) return undefined
    assert.equal(response.status, 200)
    return await response.json() as Claimed
  }
  const result = async (token: string, commandId: string, data: Record<string, unknown>) => api(cloudRoutes.executorCommandResult(commandId), token, { method: 'POST', data })
  const frames = async (token: string, sessionId: string, events: CloudSessionEvent[]) => api(cloudRoutes.executorSessionFrames(sessionId), token, { method: 'POST', data: { events } })
  const status = async (token: string, sessionId: string, data: Record<string, unknown>) => api(cloudRoutes.executorSessionStatus(sessionId), token, { method: 'POST', data })
  const commands = async (id = employee) => (await (await admin(`/api/admin/cloud/commands?employeeId=${id}&limit=50`)).json() as { commands: CommandRecord[] }).commands
  return { origin, cloud, admin, api, issue, executor, claim, result, frames, status, commands }
}
const error = async (response: Response) => (await response.json() as { error: string; message?: string })
const at = () => new Date(START).toISOString()
const event = (seq: number, frame: Record<string, unknown> = { type: 'event', event: { type: 'assistant/message', seq, time: START, data: { message: { content: [{ type: 'text', text: `frame ${seq}` }] } } } }): CloudSessionEvent => ({ seq, at: at(), frame })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** Create a workspace and let the fake executor finish `workspace.create`. */
async function readyWorkspace(f: Fixture, token: string, executor: string, name = '报告'): Promise<CloudWorkspace> {
  const created = await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name } })
  assert.equal(created.status, 201)
  const { workspace } = await created.json() as { workspace: CloudWorkspace }
  const claimed = await f.claim(executor)
  assert.equal(claimed?.command.kind, 'workspace.create')
  assert.equal(claimed?.command.workspace?.id, workspace.id)
  assert.equal((await f.result(executor, claimed!.command.id, { status: 'done', relativePath: `workspaces/${workspace.id}` })).status, 204)
  return (await (await f.api(cloudRoutes.workspace(workspace.id), token)).json() as { workspace: CloudWorkspace }).workspace
}

test('workspaces: creation queues workspace.create, names are unique per user, the cap and deletion rules hold', async t => {
  const f = await httpFixture(t)
  const token = await f.issue()
  const other = await f.issue('w00000043')
  const created = await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: '  报告  ' } })
  assert.equal(created.status, 201)
  const { workspace } = await created.json() as { workspace: CloudWorkspace }
  assert.match(workspace.id, /^cw_[0-9a-f]{32}$/)
  assert.equal(workspace.name, '报告'); assert.equal(workspace.relativePath, ''); assert.equal(workspace.snapshot, undefined); assert.equal(workspace.employeeId, employee)
  await settle()
  assert.deepEqual(f.cloud.orchestrator.calls, [`ensure:${employee}`], 'creating a workspace wakes the instance so the directory gets made')
  const duplicate = await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: '报告' } })
  assert.equal(duplicate.status, 409); assert.equal((await error(duplicate)).error, 'INVALID_REQUEST')
  assert.equal((await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: '..' } })).status, 400)
  assert.equal((await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: 'a/b' } })).status, 400)
  assert.equal((await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: 'x', extra: 1 } })).status, 400)
  assert.deepEqual(((await (await f.api(cloudRoutes.workspaces, token)).json()) as { workspaces: CloudWorkspace[] }).workspaces.map(item => item.id), [workspace.id])
  assert.deepEqual(((await (await f.api(cloudRoutes.workspaces, other)).json()) as { workspaces: CloudWorkspace[] }).workspaces, [], 'workspaces are scoped to the token owner')
  assert.equal((await f.api(cloudRoutes.workspace(workspace.id), other)).status, 404)
  assert.equal((await f.api(cloudRoutes.workspace('cw_' + '0'.repeat(32)), token)).status, 404)
  assert.equal((await f.api(`${cloudRoutes.workspaces}/not-an-id`, token)).status, 404)
  for (let index = 1; index < MAX_WORKSPACES_PER_USER; index += 1) assert.equal((await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: `ws-${index}` } })).status, 201)
  const full = await f.api(cloudRoutes.workspaces, token, { method: 'POST', data: { name: 'one-too-many' } })
  assert.equal(full.status, 409); assert.equal((await error(full)).error, 'QUEUE_FULL')
  // The executor claims the create commands in FIFO order and reports the directory it made.
  const executor = await f.executor()
  const first = await f.claim(executor)
  assert.equal(first?.command.kind, 'workspace.create'); assert.equal(first?.command.workspace?.id, workspace.id); assert.equal(first?.leaseMs, CLAIM_LEASE_MS)
  assert.equal(first?.command.session, undefined); assert.equal(first?.command.prompt, undefined)
  const missingPath = await f.result(executor, first!.command.id, { status: 'done' })
  assert.equal(missingPath.status, 400)
  assert.equal((await f.result(executor, first!.command.id, { status: 'done', relativePath: 'workspaces/报告' })).status, 204)
  assert.equal((await f.result(executor, first!.command.id, { status: 'done', relativePath: 'again' })).status, 204, 'a repeated result is a harmless no-op')
  assert.equal((await f.result(executor, 'cc_' + 'f'.repeat(32), { status: 'done' })).status, 404)
  const ready = (await (await f.api(cloudRoutes.workspace(workspace.id), token)).json() as { workspace: CloudWorkspace }).workspace
  assert.equal(ready.relativePath, 'workspaces/报告')
  // A workspace with an open session cannot be deleted; closing a not-yet-started session ends it at once.
  const session = (await (await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default', prompt: '整理报告' } })).json() as { session: CloudSession }).session
  const blocked = await f.api(cloudRoutes.workspace(workspace.id), token, { method: 'DELETE' })
  assert.equal(blocked.status, 409); assert.equal((await error(blocked)).error, 'TASK_RUNNING')
  const closed = (await (await f.api(cloudRoutes.sessionClose(session.id), token, { method: 'POST' })).json() as { session: CloudSession }).session
  assert.equal(closed.state, 'closed')
  assert.equal((await f.api(cloudRoutes.workspace(workspace.id), token, { method: 'DELETE' })).status, 204)
  assert.equal((await f.api(cloudRoutes.workspace(workspace.id), token)).status, 404)
  assert.equal((await f.api(cloudRoutes.workspace(workspace.id), token, { method: 'DELETE' })).status, 404)
  const commands = await f.commands()
  const start = commands.find(command => command.sessionId === session.id)
  assert.equal(start?.kind, 'session.start'); assert.equal(start?.status, 'failed'); assert.equal(start?.result?.errorCode, 'session-closed')
  // Deleting a workspace whose create command is still queued fails that command instead of leaving it for the executor.
  const pending = commands.filter(command => command.kind === 'workspace.create' && command.status === 'queued')
  assert.equal(pending.length, MAX_WORKSPACES_PER_USER - 1)
  assert.equal((await f.api(cloudRoutes.workspace(pending[0]!.workspaceId!), token, { method: 'DELETE' })).status, 204)
  assert.equal((await f.commands()).find(command => command.id === pending[0]!.id)?.result?.errorCode, 'workspace-deleted')
  const admin = await (await f.admin(`/api/admin/cloud/workspaces?employeeId=${employee}`)).json() as { workspaces: CloudWorkspace[] }
  assert.equal(admin.workspaces.length, MAX_WORKSPACES_PER_USER - 2)
})

test('sessions: commands carry the session, workspace and prompt; results, frames, long polling, follow-ups, cancel and close drive the state machine', async t => {
  const f = await httpFixture(t)
  const token = await f.issue()
  const executor = await f.executor()
  const workspace = await readyWorkspace(f, token, executor)
  assert.equal((await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default' } })).status, 400, 'prompt is required')
  assert.equal((await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: 'cw_' + '1'.repeat(32), expertId: 'product-default', prompt: 'x' } })).status, 404)
  assert.equal((await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default', prompt: 'x', unattended: false } })).status, 400, 'only unattended sessions exist in this phase')
  const created = await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default', skillNames: ['daily-brief'], title: '晨报', prompt: '请生成昨日晨报' } })
  assert.equal(created.status, 201)
  const { session } = await created.json() as { session: CloudSession }
  assert.match(session.id, /^cs_[0-9a-f]{32}$/)
  assert.equal(session.state, 'queued'); assert.equal(session.lastSeq, 0); assert.equal(session.turns, 0); assert.deepEqual(session.skillNames, ['daily-brief']); assert.equal(session.title, '晨报')
  assert.deepEqual(((await (await f.api(cloudRoutes.sessions, token)).json()) as { sessions: CloudSession[] }).sessions.map(item => item.id), [session.id])
  const early = await f.api(cloudRoutes.sessionPrompt(session.id), token, { method: 'POST', data: { prompt: '追问' } })
  assert.equal(early.status, 409); assert.equal((await error(early)).error, 'INVALID_REQUEST')
  // The executor claims session.start with everything it needs.
  const start = await f.claim(executor)
  assert.equal(start?.command.kind, 'session.start')
  assert.equal(start?.command.session?.id, session.id); assert.equal(start?.command.session?.state, 'starting')
  assert.equal(start?.command.workspace?.id, workspace.id); assert.equal(start?.command.workspace?.relativePath, `workspaces/${workspace.id}`)
  assert.equal(start?.command.prompt, '请生成昨日晨报'); assert.equal(start?.command.mode, undefined)
  assert.equal((await f.claim(executor)), undefined, 'nothing else is queued')
  assert.equal(((await (await f.api(cloudRoutes.session(session.id), token)).json()) as { session: CloudSession }).session.state, 'starting')
  // A reader parked on the event stream wakes as soon as the first batch lands.
  const parked = f.api(`${cloudRoutes.sessionEvents(session.id)}?since=0&waitMs=5000`, token)
  await settle()
  const snapshot = { type: 'snapshot', header: { id: 'dsh-1' }, cursor: 1, records: [], hasMore: false, projections: {} }
  const batch = await f.frames(executor, session.id, [event(1, snapshot), event(2)])
  assert.equal(batch.status, 200)
  assert.deepEqual(await batch.json(), { lastSeq: 2, cancelRequested: false })
  const woken = await parked
  assert.equal(woken.status, 200)
  const page = await woken.json() as { session: CloudSession; events: CloudSessionEvent[]; nextSince: number; hasMore: boolean }
  assert.deepEqual(page.events.map(item => item.seq), [1, 2]); assert.deepEqual(page.events[0]?.frame, snapshot); assert.equal(page.nextSince, 2); assert.equal(page.hasMore, false)
  assert.equal(page.session.lastSeq, 2)
  assert.equal((await f.result(executor, start!.command.id, { status: 'done' })).status, 400, 'session.start must report the DSH session id')
  assert.equal((await f.result(executor, start!.command.id, { status: 'done', instanceSessionId: 'dsh-1' })).status, 204)
  const running = ((await (await f.api(cloudRoutes.session(session.id), token)).json()) as { session: CloudSession }).session
  assert.equal(running.state, 'running'); assert.equal(running.instanceSessionId, 'dsh-1')
  // Retries and overlaps are idempotent, gaps are refused with the current lastSeq, batches must be contiguous, frames are bounded.
  assert.deepEqual(await (await f.frames(executor, session.id, [event(1, snapshot), event(2)])).json(), { lastSeq: 2, cancelRequested: false })
  assert.deepEqual(await (await f.frames(executor, session.id, [event(2), event(3)])).json(), { lastSeq: 3, cancelRequested: false })
  const gap = await f.frames(executor, session.id, [event(5)])
  assert.equal(gap.status, 409); assert.equal((await error(gap)).error, 'INVALID_REQUEST'); assert.match((await error(await f.frames(executor, session.id, [event(5)]))).message ?? '', /lastSeq=3/)
  assert.equal((await f.frames(executor, session.id, [event(4), event(6)])).status, 400)
  assert.equal((await f.frames(executor, session.id, [])).status, 400)
  const oversized = await f.frames(executor, session.id, [event(4, { type: 'event', event: { type: 'assistant/message', seq: 4, time: START, data: 'x'.repeat(MAX_EVENT_FRAME_BYTES) } })])
  assert.equal(oversized.status, 413)
  assert.equal(((await (await f.api(cloudRoutes.session(session.id), token)).json()) as { session: CloudSession }).session.lastSeq, 3, 'refused batches store nothing')
  const other = await f.issue('w00000043')
  assert.equal((await f.api(cloudRoutes.session(session.id), other)).status, 404)
  assert.equal((await f.api(cloudRoutes.sessionEvents(session.id), other)).status, 404)
  // Pagination and a long poll that times out empty.
  const firstPage = await (await f.api(`${cloudRoutes.sessionEvents(session.id)}?since=0&limit=2`, token)).json() as { events: CloudSessionEvent[]; nextSince: number; hasMore: boolean }
  assert.deepEqual(firstPage.events.map(item => item.seq), [1, 2]); assert.equal(firstPage.nextSince, 2); assert.equal(firstPage.hasMore, true)
  const secondPage = await (await f.api(`${cloudRoutes.sessionEvents(session.id)}?since=2&limit=2`, token)).json() as { events: CloudSessionEvent[]; nextSince: number; hasMore: boolean }
  assert.deepEqual(secondPage.events.map(item => item.seq), [3]); assert.equal(secondPage.nextSince, 3); assert.equal(secondPage.hasMore, false)
  assert.equal((await f.api(`${cloudRoutes.sessionEvents(session.id)}?waitMs=99999`, token)).status, 400, 'waitMs is capped by the contract')
  const started = Date.now()
  const timedOut = await (await f.api(`${cloudRoutes.sessionEvents(session.id)}?since=3&waitMs=200`, token)).json() as { events: CloudSessionEvent[]; nextSince: number }
  assert.ok(Date.now() - started >= 150, 'the poll held until waitMs elapsed')
  assert.deepEqual(timedOut.events, []); assert.equal(timedOut.nextSince, 3)
  // State reports are visible to the user and wake parked readers even without new frames.
  const idle = await f.status(executor, session.id, { state: 'idle', turns: 1 })
  assert.equal(idle.status, 200); assert.equal((await idle.json() as { session: CloudSession }).session.state, 'idle')
  const waiting = f.api(`${cloudRoutes.sessionEvents(session.id)}?since=3&waitMs=5000`, token)
  await settle()
  assert.equal((await f.status(executor, session.id, { state: 'running' })).status, 200)
  const stateChange = await (await waiting).json() as { session: CloudSession; events: CloudSessionEvent[] }
  assert.deepEqual(stateChange.events, []); assert.equal(stateChange.session.state, 'running'); assert.equal(stateChange.session.turns, 1)
  // Follow-up prompts queue session.prompt with the requested mode.
  const prompted = await f.api(cloudRoutes.sessionPrompt(session.id), token, { method: 'POST', data: { prompt: '把结论压缩到三句话', mode: 'steer' } })
  assert.equal(prompted.status, 202)
  const prompt = await f.claim(executor)
  assert.equal(prompt?.command.kind, 'session.prompt'); assert.equal(prompt?.command.prompt, '把结论压缩到三句话'); assert.equal(prompt?.command.mode, 'steer'); assert.equal(prompt?.command.session?.id, session.id)
  assert.equal((await f.result(executor, prompt!.command.id, { status: 'done' })).status, 204)
  // Cancel: flagged on the next frame batch, cleared once session.cancel is confirmed.
  assert.equal(((await (await f.api(cloudRoutes.sessionCancel(session.id), token, { method: 'POST' })).json()) as { session: CloudSession }).session.state, 'running')
  assert.equal((await f.api(cloudRoutes.sessionCancel(session.id), token, { method: 'POST' })).status, 200, 'a repeated cancel does not queue a second command')
  assert.deepEqual(await (await f.frames(executor, session.id, [event(4)])).json(), { lastSeq: 4, cancelRequested: true })
  const cancel = await f.claim(executor)
  assert.equal(cancel?.command.kind, 'session.cancel')
  assert.equal(await f.claim(executor), undefined)
  assert.equal((await f.result(executor, cancel!.command.id, { status: 'done' })).status, 204)
  assert.deepEqual(await (await f.frames(executor, session.id, [event(5)])).json(), { lastSeq: 5, cancelRequested: false })
  // Close: the session stays live until the executor confirms session.close.
  assert.equal(((await (await f.api(cloudRoutes.sessionClose(session.id), token, { method: 'POST' })).json()) as { session: CloudSession }).session.state, 'running')
  const close = await f.claim(executor)
  assert.equal(close?.command.kind, 'session.close')
  assert.equal((await f.result(executor, close!.command.id, { status: 'done' })).status, 204)
  const ended = ((await (await f.api(cloudRoutes.session(session.id), token)).json()) as { session: CloudSession }).session
  assert.equal(ended.state, 'closed'); assert.equal(ended.errorCode, '')
  assert.equal((await f.api(cloudRoutes.sessionPrompt(session.id), token, { method: 'POST', data: { prompt: 'x' } })).status, 409)
  assert.equal((await f.api(cloudRoutes.sessionCancel(session.id), token, { method: 'POST' })).status, 409)
  assert.equal(((await (await f.api(cloudRoutes.sessionClose(session.id), token, { method: 'POST' })).json()) as { session: CloudSession }).session.state, 'closed', 'closing twice is idempotent')
  const after = Date.now()
  const finished = await (await f.api(`${cloudRoutes.sessionEvents(session.id)}?since=5&waitMs=5000`, token)).json() as { events: CloudSessionEvent[] }
  assert.ok(Date.now() - after < 1000, 'closed sessions never park the reader'); assert.deepEqual(finished.events, [])
  assert.equal((await f.status(executor, session.id, { state: 'failed', errorCode: 'late' })).status, 200)
  assert.equal(((await (await f.api(cloudRoutes.session(session.id), token)).json()) as { session: CloudSession }).session.state, 'closed', 'terminal sessions are immutable')
  // Administrator views.
  const sessions = await (await f.admin(`/api/admin/cloud/sessions?employeeId=${employee}`)).json() as { sessions: (CloudSession & { cancelRequested: boolean })[] }
  assert.deepEqual(sessions.sessions.map(item => [item.id, item.state, item.cancelRequested]), [[session.id, 'closed', false]])
  const commands = await f.commands()
  assert.deepEqual(commands.map(command => [command.kind, command.status]), [['session.close', 'done'], ['session.cancel', 'done'], ['session.prompt', 'done'], ['session.start', 'done'], ['workspace.create', 'done']])
  assert.ok(commands.every(command => command.attempts === 1 && command.finishedAt && command.leaseUntil === null))
  assert.equal((await f.admin('/api/admin/cloud/commands?limit=0')).status, 400)
})

test('sessions: three open sessions per user, the frame cap fails a session, an administrator can close one', async t => {
  const f = await httpFixture(t, { maxEventsPerSession: 3 })
  const token = await f.issue()
  const executor = await f.executor()
  const workspace = await readyWorkspace(f, token, executor)
  const ids: string[] = []
  for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_USER; index += 1) {
    const response = await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default', prompt: `会话 ${index}` } })
    assert.equal(response.status, 201)
    ids.push((await response.json() as { session: CloudSession }).session.id)
  }
  const full = await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default', prompt: '第四个' } })
  assert.equal(full.status, 409); assert.equal((await error(full)).error, 'QUEUE_FULL')
  const start = await f.claim(executor)
  assert.equal(start?.command.session?.id, ids[0])
  assert.deepEqual(await (await f.frames(executor, ids[0]!, [event(1), event(2), event(3)])).json(), { lastSeq: 3, cancelRequested: false })
  const overflow = await f.frames(executor, ids[0]!, [event(4)])
  assert.equal(overflow.status, 409)
  const failed = ((await (await f.api(cloudRoutes.session(ids[0]!), token)).json()) as { session: CloudSession }).session
  assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'event-limit'); assert.equal(failed.lastSeq, 3)
  assert.equal((await f.frames(executor, ids[0]!, [event(4)])).status, 409, 'a failed session takes no more frames')
  assert.equal((await f.result(executor, start!.command.id, { status: 'done', instanceSessionId: 'dsh-late' })).status, 204, 'the late start result is ignored')
  assert.equal(((await (await f.api(cloudRoutes.session(ids[0]!), token)).json()) as { session: CloudSession }).session.state, 'failed')
  assert.equal((await f.commands()).find(command => command.id === start!.command.id)?.result?.errorCode, 'session-failed')
  assert.equal((await f.api(cloudRoutes.sessions, token, { method: 'POST', data: { workspaceId: workspace.id, expertId: 'product-default', prompt: '补位' } })).status, 201, 'a finished session frees a slot')
  // An executor-reported failure fails the session with its code; the administrator closes a queued one directly.
  const second = await f.claim(executor)
  assert.equal(second?.command.session?.id, ids[1])
  assert.equal((await f.result(executor, second!.command.id, { status: 'failed', errorCode: 'preset-missing', message: '专家不可用' })).status, 204)
  const broken = ((await (await f.api(cloudRoutes.session(ids[1]!), token)).json()) as { session: CloudSession }).session
  assert.equal(broken.state, 'failed'); assert.equal(broken.errorCode, 'preset-missing'); assert.equal(broken.errorMessage, '专家不可用')
  assert.equal((await f.admin(`/api/admin/cloud/sessions/${ids[2]}/close`, { method: 'POST', data: {} })).status, 200)
  assert.equal(((await (await f.api(cloudRoutes.session(ids[2]!), token)).json()) as { session: CloudSession }).session.state, 'closed')
  assert.equal((await f.admin('/api/admin/cloud/sessions/cs_00000000000000000000000000000000/close', { method: 'POST', data: {} })).status, 404)
})

test('command leases: an unreported command returns to the queue once and then fails, taking its session with it', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const workspace = db.createWorkspace(employee, { name: '租约' })
  const first = db.claimCommand(employee)
  assert.equal(first?.command.kind, 'workspace.create'); assert.equal(first?.leaseMs, CLAIM_LEASE_MS)
  assert.equal(db.claimCommand(employee), undefined)
  clock.advance(CLAIM_LEASE_MS + 1)
  let tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.commandsRequeued, [first!.command.id]); assert.deepEqual(tick.commandsFailed, [])
  const second = db.claimCommand(employee)
  assert.equal(second?.command.id, first?.command.id)
  assert.equal(db.adminCommands(employee, 10)[0]?.attempts, 2)
  clock.advance(CLAIM_LEASE_MS + 1)
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.commandsFailed, [first!.command.id])
  const record = db.adminCommands(employee, 10)[0]!
  assert.equal(record.status, 'failed'); assert.equal(record.result?.errorCode, 'command-lease-expired')
  assert.equal(db.workspace(employee, workspace.id).relativePath, '', 'the workspace record survives a failed command')
  assert.doesNotThrow(() => db.completeCommand(employee, first!.command.id, { status: 'done', errorCode: '', message: '', relativePath: 'x' }), 'a late result for a finished command is ignored')
  assert.equal(db.adminCommands(employee, 10)[0]?.status, 'failed')
  const session = db.createSession(employee, { workspaceId: workspace.id, expertId: 'product-default', prompt: '开始' })
  assert.equal(db.claimCommand(employee)?.command.kind, 'session.start')
  assert.equal(db.session(employee, session.id).state, 'starting')
  clock.advance(CLAIM_LEASE_MS + 1)
  await runtime.scheduler.tick()
  assert.equal(db.session(employee, session.id).state, 'queued', 'a requeued start puts the session back to queued')
  assert.equal(db.claimCommand(employee)?.command.session?.state, 'starting')
  clock.advance(CLAIM_LEASE_MS + 1)
  tick = await runtime.scheduler.tick()
  assert.equal(tick.commandsFailed.length, 1)
  const failed = db.session(employee, session.id)
  assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'command-lease-expired')
})

test('instances: queued commands and open sessions wake the instance; idle stop closes idle sessions and drops their commands', async t => {
  const { clock, db, runtime, orchestrator } = await cloudFixture(t, { idleStopMinutes: 10 })
  const workspace = db.createWorkspace(employee, { name: '实例' })
  let tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.ensured, [employee], 'a queued command needs the instance even without runs')
  assert.deepEqual(orchestrator.calls, [`ensure:${employee}`])
  const create = db.claimCommand(employee)!
  db.completeCommand(employee, create.command.id, { status: 'done', errorCode: '', message: '', relativePath: 'w' })
  const session = db.createSession(employee, { workspaceId: workspace.id, expertId: 'product-default', prompt: '开始' })
  const start = db.claimCommand(employee)!
  db.completeCommand(employee, start.command.id, { status: 'done', errorCode: '', message: '', instanceSessionId: 'dsh-1' })
  db.reportSessionStatus(employee, session.id, { state: 'running', errorCode: '', errorMessage: '' })
  clock.advance(11 * MINUTE)
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.stopped, [], 'a running session keeps the instance alive')
  db.reportSessionStatus(employee, session.id, { state: 'idle', turns: 1, errorCode: '', errorMessage: '' })
  db.promptSession(employee, session.id, { prompt: '继续', mode: 'queue' })
  clock.advance(11 * MINUTE)
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.stopped, [], 'a queued follow-up keeps the instance alive')
  const followUp = db.claimCommand(employee)!
  db.completeCommand(employee, followUp.command.id, { status: 'done', errorCode: '', message: '' })
  db.reportSessionStatus(employee, session.id, { state: 'idle', turns: 2, errorCode: '', errorMessage: '' })
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.stopped, [], 'activity was just reported')
  clock.advance(11 * MINUTE)
  db.cancelSession(employee, session.id)
  const cancel = db.claimCommand(employee)!
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.stopped, [], 'a claimed command keeps the instance alive')
  db.completeCommand(employee, cancel.command.id, { status: 'done', errorCode: '', message: '' })
  clock.advance(11 * MINUTE)
  tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.stopped, [employee])
  const closed = db.session(employee, session.id)
  assert.equal(closed.state, 'closed'); assert.equal(closed.errorCode, 'instance-stopped')
  assert.equal(db.instanceStatus(employee).state, 'stopped')
  // A session that is idle when the administrator stops the instance ends the same way, and its pending prompt is dropped.
  const again = db.createSession(employee, { workspaceId: workspace.id, expertId: 'product-default', prompt: '再来' })
  await runtime.scheduler.tick()
  db.completeCommand(employee, db.claimCommand(employee)!.command.id, { status: 'done', errorCode: '', message: '', instanceSessionId: 'dsh-2' })
  db.reportSessionStatus(employee, again.id, { state: 'idle', errorCode: '', errorMessage: '' })
  db.promptSession(employee, again.id, { prompt: '追问', mode: 'queue' })
  await runtime.instances.stop(employee)
  assert.equal(db.session(employee, again.id).state, 'closed')
  assert.equal(db.adminCommands(employee, 1)[0]?.result?.errorCode, 'session-closed')
  assert.deepEqual(db.employeesNeedingInstance(), [])
})

test('workspace snapshots: one pending request at a time, the archive round-trips with headers, results must match the upload, deletion removes the file', async t => {
  const f = await httpFixture(t)
  const token = await f.issue()
  const executor = await f.executor()
  const workspace = await readyWorkspace(f, token, executor)
  assert.equal((await f.api(cloudRoutes.workspaceSnapshotArchive(workspace.id), token)).status, 404)
  const requested = await f.api(cloudRoutes.workspaceSnapshot(workspace.id), token, { method: 'POST' })
  assert.equal(requested.status, 202); assert.equal((await requested.json() as { workspace: CloudWorkspace }).workspace.snapshot, undefined)
  assert.equal((await f.api(cloudRoutes.workspaceSnapshot(workspace.id), token, { method: 'POST' })).status, 202)
  assert.equal((await f.commands()).filter(command => command.kind === 'workspace.snapshot').length, 1, 'a second request while one is pending is coalesced')
  const claimed = await f.claim(executor)
  assert.equal(claimed?.command.kind, 'workspace.snapshot'); assert.equal(claimed?.command.workspace?.id, workspace.id)
  const bytes = Buffer.from('PK\u0003\u0004 workspace snapshot bytes', 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const upload = (body: Buffer, sha: string) => f.api(cloudRoutes.executorWorkspaceSnapshot(workspace.id), executor, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'X-Artifact-Sha256': sha, 'X-Artifact-File-Count': '3' }, body })
  const wrong = await upload(bytes, 'e'.repeat(64))
  assert.equal(wrong.status, 400); assert.equal((await error(wrong)).error, 'ARTIFACT_MISMATCH')
  assert.equal((await f.api(cloudRoutes.executorWorkspaceSnapshot('cw_' + '2'.repeat(32)), executor, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'X-Artifact-Sha256': sha256 }, body: bytes })).status, 404)
  const stored = await upload(bytes, sha256)
  assert.equal(stored.status, 200)
  const uploaded = (await stored.json() as { workspace: CloudWorkspace }).workspace
  assert.deepEqual(uploaded.snapshot, { size: bytes.length, sha256, fileCount: 3 }); assert.ok(uploaded.snapshotAt)
  const mismatch = await f.result(executor, claimed!.command.id, { status: 'done', artifact: { size: 1, sha256, fileCount: 3 } })
  assert.equal(mismatch.status, 409); assert.equal((await error(mismatch)).error, 'ARTIFACT_MISMATCH')
  assert.equal((await f.result(executor, claimed!.command.id, { status: 'done', artifact: { size: bytes.length, sha256, fileCount: 3 } })).status, 204)
  assert.equal((await f.commands()).find(command => command.id === claimed!.command.id)?.status, 'done')
  const download = await f.api(cloudRoutes.workspaceSnapshotArchive(workspace.id), token)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('x-artifact-sha256'), sha256); assert.equal(download.headers.get('x-artifact-file-count'), '3'); assert.equal(download.headers.get('etag'), `"${sha256}"`)
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''ws_cw_[0-9a-f]{32}\.zip$/)
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(bytes))
  assert.equal((await f.api(cloudRoutes.workspaceSnapshotArchive(workspace.id), token, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 304)
  assert.equal((await f.api(cloudRoutes.workspaceSnapshotArchive(workspace.id), await f.issue('w00000043'))).status, 404)
  // A later snapshot replaces the archive in place.
  const next = Buffer.from('PK\u0003\u0004 second snapshot', 'utf8')
  const nextSha = createHash('sha256').update(next).digest('hex')
  assert.equal((await upload(next, nextSha)).status, 200)
  assert.ok(Buffer.from(await (await f.api(cloudRoutes.workspaceSnapshotArchive(workspace.id), token)).arrayBuffer()).equals(next))
  const artifacts = path.join(f.cloud.root, 'cloud', 'artifacts')
  assert.deepEqual((await readdir(artifacts)).filter(name => name.startsWith('ws_')), [`ws_${workspace.id}.zip`])
  assert.equal((await f.api(cloudRoutes.workspace(workspace.id), token, { method: 'DELETE' })).status, 204)
  assert.deepEqual((await readdir(artifacts)).filter(name => name.startsWith('ws_')), [], 'the snapshot file goes with the workspace')
})

test('retention: finished sessions, their frames and finished commands are removed after the retention window', async t => {
  const { clock, db, runtime } = await cloudFixture(t)
  const workspace = db.createWorkspace(employee, { name: '保留' })
  db.completeCommand(employee, db.claimCommand(employee)!.command.id, { status: 'done', errorCode: '', message: '', relativePath: 'w' })
  const session = db.createSession(employee, { workspaceId: workspace.id, expertId: 'product-default', prompt: '开始' })
  const start = db.claimCommand(employee)!
  db.appendSessionFrames(employee, session.id, [event(1), event(2)])
  db.completeCommand(employee, start.command.id, { status: 'done', errorCode: '', message: '', instanceSessionId: 'dsh-1' })
  const open = db.createSession(employee, { workspaceId: workspace.id, expertId: 'product-default', prompt: '仍在' })
  db.reportSessionStatus(employee, session.id, { state: 'closed', errorCode: '', errorMessage: '' })
  clock.advance((RESULT_RETENTION_DAYS + 1) * 24 * 60 * MINUTE)
  await runtime.maintain()
  assert.throws(() => db.session(employee, session.id), (error: unknown) => error instanceof CloudError && error.code === 'NOT_FOUND')
  assert.deepEqual(db.sessionEvents(employee, open.id, 0, 10).events, [])
  assert.equal(db.session(employee, open.id).state, 'queued', 'open sessions are kept')
  assert.deepEqual(db.adminCommands(employee, 10).map(command => command.status), ['queued'], 'only the open session\'s start command remains')
  assert.equal(db.workspace(employee, workspace.id).name, '保留', 'workspaces are not subject to retention')
})

test('schema: a version 1 database upgrades in place to version 2', async t => {
  const { root } = await cloudFixture(t)
  const directory = path.join(root, 'v1')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(directory, { recursive: true })
  const legacy = new DatabaseSync(path.join(directory, 'cloud.sqlite'))
  legacy.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(1);
    CREATE TABLE cloud_tokens(hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_used_at TEXT);
    CREATE TABLE cloud_instances(employee_id TEXT PRIMARY KEY, state TEXT NOT NULL, backend TEXT NOT NULL DEFAULT '', backend_ref TEXT, port INTEGER, launch_url TEXT, executor_token_hash TEXT, last_heartbeat_at TEXT, catalog_json TEXT, bundle_version TEXT, dsh_version TEXT, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, last_error TEXT);
    CREATE TABLE cloud_tasks(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, definition_json TEXT NOT NULL, state TEXT NOT NULL, next_run_at TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE cloud_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, employee_id TEXT NOT NULL, task_name TEXT NOT NULL, definition_json TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_at TEXT NOT NULL, queued_at TEXT NOT NULL, claimed_at TEXT, lease_until TEXT, lease_expirations INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, summary TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', session_id TEXT, auto_decisions INTEGER, artifact_json TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, executor_instance TEXT);`)
  legacy.close()
  const upgraded = new CloudDatabase(directory)
  try {
    const workspace = upgraded.createWorkspace(employee, { name: '升级' })
    assert.equal(upgraded.listWorkspaces(employee)[0]?.id, workspace.id)
    assert.equal(upgraded.claimCommand(employee)?.command.kind, 'workspace.create')
  } finally { upgraded.close() }
  const reopened = new CloudDatabase(directory)
  try { assert.equal(reopened.listWorkspaces(employee).length, 1) } finally { reopened.close() }
})
