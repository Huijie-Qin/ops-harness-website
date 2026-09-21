import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TrackingDatabase, type Installation } from '../server/tracking/database.js'
import type { TrackingEvent } from '@dsh-ops/tracking/contracts'
const now = Date.parse('2026-09-20T06:00:00Z')
const q = { from: '2026-09-20', to: '2026-09-20', environment: 'all', offset: 0, limit: 50 }
function event(i: Installation, employeeId?: string, extra: Partial<TrackingEvent> = {}): TrackingEvent {
  return { schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName: 'operation.accepted', module: 'tool-market', feature: 'tools', action: 'tool.add', occurredAt: new Date(now).toISOString(), installationId: i.installationId, runtimeId: randomUUID(), sequence: 1, initiator: 'user', interactionId: randomUUID(), operationId: randomUUID(), platform: 'darwin', appVersion: '0.1.0', environment: i.environment, properties: {}, ...(employeeId ? { employee: { source: 'welink', employeeId } } : {}), ...extra }
}
test('all environments deduplicate employee numbers across devices and platforms, including MAU outside the selected dates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-employee-')); const db = new TrackingDatabase(root, () => now)
  const a: Installation = { tenantId: 'development', installationId: randomUUID(), environment: 'development' }
  const b: Installation = { ...a, installationId: randomUUID(), environment: 'test' }
  try {
    const events = [event(a, 'a123'), event(a, 'b123'), event(a), event(a, 'older', { occurredAt: '2026-09-19T06:00:00Z' }), event(a, 'background', { initiator: 'scheduler' })]
    assert.equal(db.ingest(a, events).acceptedIds.length, events.length)
    assert.equal(db.ingest(a, events).duplicateIds.length, events.length)
    assert.equal(db.ingest(b, [event(b, 'a123', { platform: 'win32' })]).acceptedIds.length, 1)
    const overview = db.query('overview', q) as any
    assert.equal(overview.loginUsers, 2); assert.equal(overview.activeUsers, 2)
    assert.equal(overview.dau, 2); assert.equal(overview.mau, 3); assert.equal(overview.interactions, 3)
    assert.equal(overview.metricVersion, 3)
    const users = db.query('users', q) as any
    assert.equal(users.rows.filter((r: any) => r.account === 'a123').length, 1)
    assert.equal(users.rows.find((r: any) => r.account === 'a123').interactions, 2)
    assert.equal((db.query('rankings', q) as any).rows.filter((r: any) => r.account === 'a123').length, 1)
    assert.equal((db.query('features', q) as any).rows[0].users, 2)
    assert.equal((db.query('features', q) as any).rows[0].uses, 3)
    assert.equal((db.query('trends', q) as any).rows[0].dau, 2)
    const state = db.query('health', q) as any
    assert.equal(state.collected, 5); assert.equal(state.installations, 2)
    assert.equal(state.anonymousEvents, 1); assert.equal(state.identifiedEvents, 4)
    assert.equal((db.query('operations', q) as any).rows.length, 5)
    assert.equal((db.query('overview', { ...q, environment: 'development' }) as any).dau, 2)
    assert.equal((db.query('overview', { ...q, environment: 'test' }) as any).dau, 1)
    assert.equal((db.query('overview', { ...q, environment: 'production' }) as any).dau, 0)
    assert.equal((db.query('health', { ...q, appVersion: '9.9.9' }) as any).collected, 0)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
test('employee attribution preserves anonymous history and validates out-of-order operation ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-employee-')); const db = new TrackingDatabase(root, () => now)
  const i: Installation = { tenantId: 'development', installationId: randomUUID(), environment: 'development' }
  try {
    db.ingest(i, [event(i)])
    const accepted = event(i, 'a123')
    const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
    assert.equal(db.ingest(i, [terminal]).acceptedIds.length, 1)
    assert.equal((db.query('overview', q) as any).successes, 0)
    const wrong = { ...accepted, employee: { source: 'welink', employeeId: 'b123' } }
    assert.equal(db.ingest(i, [wrong]).rejected[0]?.code, 'OPERATION_CONTEXT_CONFLICT')
    assert.equal(db.ingest(i, [accepted]).acceptedIds.length, 1)
    assert.equal((db.query('overview', q) as any).successes, 1)
    assert.equal((db.query('health', q) as any).anonymousEvents, 1)
    const user = (db.query('users', q) as any).rows[0]
    assert.equal(user.account, 'a123'); assert.equal(user.successes, 1)
    assert.equal((db.query('operations', { ...q, userId: user.userId }) as any).rows.length, 2)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test('conversation and Skill views aggregate all environments and support employee drill-down', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-employee-')); const db = new TrackingDatabase(root, () => now)
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
      assert.equal(db.ingest(i, events).acceptedIds.length, 3)
    }
    const conversations = db.query('conversations', q) as any
    assert.equal(conversations.messages, 2); assert.equal(conversations.users, 1)
    assert.equal(conversations.conversations, 2); assert.equal(conversations.totalTokens, 34)
    assert.equal((db.query('skills', q) as any).loads, 2)
    assert.equal((db.query('skills', q) as any).users, 1)
    const user = (db.query('users', q) as any).rows[0]
    assert.equal(user.messages, 2); assert.equal(user.totalTokens, 34); assert.equal(user.skillLoads, 2)
    assert.equal((db.query('skills', { ...q, userId: user.userId }) as any).loads, 2)
    assert.equal((db.query('conversations', { ...q, environment: 'test' }) as any).totalTokens, 17)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
