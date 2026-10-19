import { integrationTest as test, createTestDatabase } from './helpers/clickhouse.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { type AnalyticsQuery } from '../server/tracking/database.js'
import type { TrackingEvent } from '@dsh-ops/tracking-contract'
const now = Date.parse('2026-09-20T06:00:00Z')
const q: AnalyticsQuery = { from: '2026-09-01', to: '2026-09-20', environment: 'test', offset: 0, limit: 50 }
const installation = { tenantId: 'test', installationId: randomUUID(), environment: 'test' as const }
const context = { conversationId: 'a'.repeat(64), turn: 1, sessionKind: 'root' }
function event(eventName: TrackingEvent['eventName'], properties: Record<string, unknown>, extra: Partial<TrackingEvent> = {}): TrackingEvent {
  return { schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName, feature: eventName.startsWith('skill.') ? 'skills' : 'conversation', module: 'session-observer', occurredAt: new Date(now).toISOString(), installationId: installation.installationId, runtimeId: randomUUID(), sequence: 1, initiator: 'user', interactionId: randomUUID(), platform: 'darwin', appVersion: '0.1.0', environment: 'test', properties: { ...context, ...properties }, ...extra }
}
const usage = { step: 1, provider: 'test', model: 'test-model', usageReported: true, inputTokens: 10, outputTokens: 6, cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 4 }
test('conversation/Skill facts preserve identity, anonymous totals, exact token buckets and retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-runtime-'))
  let time = now - 1000
  const db = await createTestDatabase(root, () => time)
  try {
    const identity = (await db.identity(installation, { issuer: 'company-sso', subject: 'test-user', displayName: '测试用户', expiresAt: now + 3600000 }))
    time = now
    const identified = { identityRef: identity.identityRef }
    const events = [event('conversation.message.accepted', {}, identified), event('conversation.message.accepted', {}, identified), event('conversation.model.usage', usage, identified),
      event('conversation.model.usage', { ...usage, sessionKind: 'subagent' }, { ...identified, initiator: 'agent' }),
      event('conversation.model.usage', usage, { initiator: 'unknown' }),
      event('conversation.model.usage', { ...usage, usageReported: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
      event('skill.load.completed', { step: 1, skillName: 'example-skill', method: 'explicit', result: 'succeeded' }, identified),
      event('skill.load.completed', { step: 1, skillName: 'example-skill', method: 'model', result: 'succeeded' }),
      event('skill.load.completed', { step: 1, skillName: 'example-skill', method: 'model', result: 'failed' })]
    assert.equal((await db.ingest(installation, events)).acceptedIds.length, 9)
    assert.equal((await db.ingest(installation, events)).duplicateIds.length, 9)
    const conversations = (await db.query('conversations', q)) as any
    assert.equal(conversations.messages, 2); assert.equal(conversations.conversations, 1); assert.equal(conversations.users, 1)
    assert.equal(conversations.totalTokens, 117); assert.equal(conversations.reasoningTokens, 12); assert.equal(conversations.anonymousTokens, 39)
    assert.equal(conversations.modelSteps, 4); assert.equal(conversations.missingUsage, 1)
    const skill = ((await db.query('skills', q)) as any).rows[0]
    assert.equal(skill.loads, 2); assert.equal(skill.failures, 1); assert.equal(skill.explicitLoads, 1); assert.equal(skill.modelLoads, 1); assert.equal(skill.users, 1)
    const user = ((await db.query('users', q)) as any).rows[0]
    assert.equal(user.messages, 2); assert.equal(user.totalTokens, 78); assert.equal(user.skillLoads, 1)
    assert.equal(((await db.query('conversations', { ...q, userId: user.userId })) as any).totalTokens, 78)
    assert.equal(((await db.query('skills', { ...q, userId: user.userId })) as any).loads, 1)
    assert.equal(((await db.query('conversations', { ...q, platform: 'win32' })) as any).totalTokens, 0)
    assert.equal(((await db.query('skills', { ...q, appVersion: '9.9.9' })) as any).loads, 0)
    assert.equal(((await db.query('overview', q)) as any).dau, 1)
    assert.equal(((await db.query('skills', { ...q, offset: 1 })) as any).rows.length, 0)
    time = now + 100 * 86400000; (await db.maintain())
    assert.equal(((await db.query('conversations', q)) as any).totalTokens, 117) // No dependency on raw 90-day event bodies.
    assert.equal(((await db.query('skills', q)) as any).loads, 2)
    time = now + 401 * 86400000; (await db.maintain())
    assert.equal(((await db.query('conversations', q)) as any).totalTokens, 0)
  } finally { (await db.close()); await rm(root, { recursive: true, force: true }) }
})
