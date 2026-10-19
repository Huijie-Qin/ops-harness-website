import { integrationTest as test, createTestDatabase } from './helpers/clickhouse.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { type Installation } from '../server/tracking/database.js'
import type { TrackingEvent } from '@dsh-ops/tracking-contract'
const now = Date.parse('2026-09-20T06:00:00Z')
const q = { from: '2026-09-20', to: '2026-09-20', environment: 'all', offset: 0, limit: 50 }
function event(i: Installation, employeeId?: string, extra: Partial<TrackingEvent> = {}): TrackingEvent {
  return { schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName: 'operation.accepted', module: 'tool-market', feature: 'tools', action: 'tool.add', occurredAt: new Date(now).toISOString(), installationId: i.installationId, runtimeId: randomUUID(), sequence: 1, initiator: 'user', interactionId: randomUUID(), operationId: randomUUID(), platform: 'darwin', appVersion: '0.1.0', environment: i.environment, properties: {}, ...(employeeId ? { employee: { source: 'welink', employeeId } } : {}), ...extra }
}
const profile = { chineseName: '示例同事', departmentName: '示例集团 / 终端事业部 / 体验研究组', deptL1Name: '终端事业部', deptName: '体验研究组', profileUpdatedAt: '2026-09-20T05:00:00.000Z' }

test('employee profiles enrich all personal views without changing attribution or accepting stale overwrites', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-profile-')); const db = await createTestDatabase(root, () => now)
  const installation: Installation = { tenantId: 'development', installationId: randomUUID(), environment: 'development' }
  const employee = { source: 'welink' as const, employeeId: 'qa-profile', ...profile }
  const send = async (value: typeof employee | TrackingEvent['employee']) => (await db.ingest(installation, [event(installation, undefined, { employee: value })]))
  try {
    assert.equal((await send(employee)).acceptedIds.length, 1)
    const first = ((await db.query('users', q)) as any).rows[0]
    for (const [key, value] of Object.entries(profile)) assert.equal(first[key], value)
    assert.equal(first.displayName, profile.chineseName); assert.equal(first.account, employee.employeeId)
    const otherInstallation = { ...installation, installationId: randomUUID(), environment: 'test' as const }
    assert.equal((await db.ingest(otherInstallation, [event(otherInstallation, undefined, { employee: { ...employee, chineseName: '旧姓名', deptName: '旧部门', profileUpdatedAt: '2026-09-19T05:00:00.000Z' } })])).acceptedIds.length, 1)
    ;(await send({ source: 'welink', employeeId: employee.employeeId }))
    ;(await send({ source: 'welink', employeeId: employee.employeeId, profileUpdatedAt: '2026-09-21T05:00:00.000Z' }))
    ;(await send({ source: 'welink', employeeId: employee.employeeId, chineseName: '缺时间的姓名' }))
    ;(await send({ source: 'welink', employeeId: employee.employeeId, deptName: '新体验研究组', profileUpdatedAt: '2026-09-20T05:30:00.000Z' }))
    for (const kind of ['users', 'rankings', 'operations']) {
      const row = ((await db.query(kind, { ...q, userId: first.userId })) as any).rows[0]
      assert.equal(row.displayName, profile.chineseName); assert.equal(row.chineseName, profile.chineseName)
      assert.equal(row.departmentName, profile.departmentName); assert.equal(row.deptL1Name, profile.deptL1Name)
      assert.equal(row.deptName, '新体验研究组'); assert.equal(row.profileUpdatedAt, '2026-09-20T05:30:00.000Z')
    }
    assert.equal(((await db.query('users', q)) as any).total, 1)
    assert.equal(((await db.query('overview', q)) as any).activeUsers, 1)
    assert.equal(((await db.query('users', { ...q, search: profile.chineseName })) as any).total, 1)
  } finally { (await db.close()); await rm(root, { recursive: true, force: true }) }
})

test('frozen operation profiles continue to match and rejected conflicts cannot overwrite a profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-profile-operation-')); const db = await createTestDatabase(root, () => now)
  const installation: Installation = { tenantId: 'development', installationId: randomUUID(), environment: 'development' }
  const employee = { source: 'welink' as const, employeeId: 'qa-profile', ...profile }
  try {
    const accepted = event(installation, undefined, { employee })
    ;(await db.ingest(installation, [accepted]))
    const changed = { ...employee, chineseName: '不应保存', profileUpdatedAt: '2026-09-20T05:50:00.000Z' }
    const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
    assert.equal((await db.ingest(installation, [{ ...terminal, employee: changed }])).rejected[0]?.code, 'OPERATION_CONTEXT_CONFLICT')
    assert.equal(((await db.query('users', q)) as any).rows[0].chineseName, profile.chineseName)
    assert.equal((await db.ingest(installation, [terminal])).acceptedIds.length, 1)
    assert.equal((await db.ingest(installation, [terminal])).duplicateIds.length, 1)
    assert.equal(((await db.query('overview', q)) as any).successes, 1)
    const laterAccepted = event(installation, undefined, { employee })
    const earlyTerminal = { ...laterAccepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
    assert.equal((await db.ingest(installation, [earlyTerminal])).acceptedIds.length, 1)
    assert.equal((await db.ingest(installation, [laterAccepted])).acceptedIds.length, 1)
    assert.equal(((await db.query('overview', q)) as any).successes, 2)
  } finally { (await db.close()); await rm(root, { recursive: true, force: true }) }
})


test('user search and sorting run before pagination and preserve aggregate counts', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'tracking-user-search-'));const db=await createTestDatabase(root,()=>now)
  const i:Installation={tenantId:'development',installationId:randomUUID(),environment:'development'}
  try{
    ;(await db.ingest(i,[event(i,'alpha'),event(i,'beta'),event(i,'beta'),event(i,'gamma'),event(i,'gamma'),event(i,'gamma')]))
    const first=(await db.query('users',{...q,sort:'interactions',direction:'desc',limit:1})) as any
    const second=(await db.query('users',{...q,sort:'interactions',direction:'desc',limit:1,offset:1})) as any
    assert.equal(first.rows[0].account,'gamma');assert.equal(second.rows[0].account,'beta');assert.equal(first.total,3)
    const ascending=(await db.query('users',{...q,sort:'interactions',direction:'asc',limit:1})) as any
    assert.equal(ascending.rows[0].account,'alpha')
    const search=(await db.query('users',{...q,search:'BETA',sort:'interactions',direction:'desc'})) as any
    assert.equal(search.total,1);assert.equal(search.rows[0].interactions,2)
    assert.equal(((await db.query('users',{...q,search:"' OR 1=1 --"})) as any).total,0)
    assert.equal(((await db.query('users',{...q,search:'%'})) as any).total,0)
    assert.equal(((await db.query('rankings',{...q,search:'beta'})) as any).rows[0].account,'beta')
    assert.equal(((await db.query('overview',q)) as any).activeUsers,3)
  }finally{(await db.close());await rm(root,{recursive:true,force:true})}
})
test('all environments deduplicate employee numbers across devices and platforms, including MAU outside the selected dates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-employee-')); const db = await createTestDatabase(root, () => now)
  const a: Installation = { tenantId: 'development', installationId: randomUUID(), environment: 'development' }
  const b: Installation = { ...a, installationId: randomUUID(), environment: 'test' }
  try {
    const events = [event(a, 'a123'), event(a, 'b123'), event(a), event(a, 'older', { occurredAt: '2026-09-19T06:00:00Z' }), event(a, 'background', { initiator: 'scheduler' })]
    assert.equal((await db.ingest(a, events)).acceptedIds.length, events.length)
    assert.equal((await db.ingest(a, events)).duplicateIds.length, events.length)
    assert.equal((await db.ingest(b, [event(b, 'a123', { platform: 'win32' })])).acceptedIds.length, 1)
    const overview = (await db.query('overview', q)) as any
    assert.equal(overview.loginUsers, 2); assert.equal(overview.activeUsers, 2)
    assert.equal(overview.dau, 2); assert.equal(overview.mau, 3); assert.equal(overview.interactions, 3)
    assert.equal(overview.metricVersion, 3)
    const users = (await db.query('users', q)) as any
    assert.equal(users.rows.filter((r: any) => r.account === 'a123').length, 1)
    assert.equal(users.rows.find((r: any) => r.account === 'a123').interactions, 2)
    assert.equal(((await db.query('rankings', q)) as any).rows.filter((r: any) => r.account === 'a123').length, 1)
    assert.equal(((await db.query('features', q)) as any).rows[0].users, 2)
    assert.equal(((await db.query('features', q)) as any).rows[0].uses, 3)
    assert.equal(((await db.query('trends', q)) as any).rows[0].dau, 2)
    const state = (await db.query('health', q)) as any
    assert.equal(state.collected, 5); assert.equal(state.installations, 2)
    assert.equal(state.anonymousEvents, 1); assert.equal(state.identifiedEvents, 4)
    assert.equal(((await db.query('operations', q)) as any).rows.length, 5)
    assert.equal(((await db.query('overview', { ...q, environment: 'development' })) as any).dau, 2)
    assert.equal(((await db.query('overview', { ...q, environment: 'test' })) as any).dau, 1)
    assert.equal(((await db.query('overview', { ...q, environment: 'production' })) as any).dau, 0)
    assert.equal(((await db.query('health', { ...q, appVersion: '9.9.9' })) as any).collected, 0)
  } finally { (await db.close()); await rm(root, { recursive: true, force: true }) }
})
test('employee attribution preserves anonymous history and validates out-of-order operation ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-employee-')); const db = await createTestDatabase(root, () => now)
  const i: Installation = { tenantId: 'development', installationId: randomUUID(), environment: 'development' }
  try {
    ;(await db.ingest(i, [event(i)]))
    const accepted = event(i, 'a123')
    const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
    assert.equal((await db.ingest(i, [terminal])).acceptedIds.length, 1)
    assert.equal(((await db.query('overview', q)) as any).successes, 0)
    const wrong = { ...accepted, employee: { source: 'welink', employeeId: 'b123' } }
    assert.equal((await db.ingest(i, [wrong])).rejected[0]?.code, 'OPERATION_CONTEXT_CONFLICT')
    assert.equal((await db.ingest(i, [accepted])).acceptedIds.length, 1)
    assert.equal(((await db.query('overview', q)) as any).successes, 1)
    assert.equal(((await db.query('health', q)) as any).anonymousEvents, 1)
    const user = ((await db.query('users', q)) as any).rows[0]
    assert.equal(user.account, 'a123'); assert.equal(user.successes, 1)
    assert.equal(((await db.query('operations', { ...q, userId: user.userId })) as any).rows.length, 2)
  } finally { (await db.close()); await rm(root, { recursive: true, force: true }) }
})

test('conversation and Skill views aggregate all environments and support employee drill-down', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-employee-')); const db = await createTestDatabase(root, () => now)
  try {
    for (const environment of ['development', 'test'] as const) {
      const i = { tenantId: 'development', installationId: randomUUID(), environment }
      const { action, operationId, ...base } = event(i, 'a123')
      const context = { conversationId: (environment === 'development' ? 'a' : 'b').repeat(64), turn: 1, sessionKind: 'root' }
      const events = [
        { ...base, eventName: 'conversation.message.accepted', feature: 'conversation', properties: context },
        { ...base, eventId: randomUUID(), eventName: 'conversation.model.usage', feature: 'conversation', properties: { ...context, step: 1, provider: 'test', model: 'mock', usageReported: true, inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 1 } },
        { ...base, eventId: randomUUID(), eventName: 'skill.load.completed', feature: 'skills', properties: { ...context, step: 1, skillName: 'test-skill', method: 'model', result: 'succeeded' } },
      ]
      assert.equal((await db.ingest(i, events)).acceptedIds.length, 3)
    }
    const conversations = (await db.query('conversations', q)) as any
    assert.equal(conversations.messages, 2); assert.equal(conversations.users, 1)
    assert.equal(conversations.conversations, 2); assert.equal(conversations.totalTokens, 34)
    assert.equal(((await db.query('skills', q)) as any).loads, 2)
    assert.equal(((await db.query('skills', q)) as any).users, 1)
    const user = ((await db.query('users', q)) as any).rows[0]
    assert.equal(user.messages, 2); assert.equal(user.totalTokens, 34); assert.equal(user.skillLoads, 2)
    assert.equal(((await db.query('skills', { ...q, userId: user.userId })) as any).loads, 2)
    assert.equal(((await db.query('conversations', { ...q, environment: 'test' })) as any).totalTokens, 17)
  } finally { (await db.close()); await rm(root, { recursive: true, force: true }) }
})
