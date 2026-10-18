import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { applyChanges, emptyState } from '../server/tracking/canonical.js'
import { decideIngest } from '../server/tracking/decision.js'
import { AnalyticsConfigSchema } from '../server/tracking/config.js'
import { event, installation } from './helpers/tracking-events.js'

test('pure ingestion preserves retry/conflict, terminal ordering, profiles and event-time boundaries', () => {
  const i = installation(), now = Date.now(), accepted = event(i), state = emptyState()
  const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
  const first = decideIngest(state, i, [terminal], now)
  assert.equal(first.result.acceptedIds.length, 1); assert.equal(state.activity_facts.length, 0)
  const pending = applyChanges(state, first.changes)
  assert.equal(pending.activity_facts[0]!.pending, 1)
  const second = decideIngest(pending, i, [accepted], now)
  const final = applyChanges(pending, second.changes)
  assert.equal(final.activity_facts.length, 2)
  assert.equal(final.activity_facts.filter(row => row.pending !== 0).length, 0)
  assert.equal(new Set(final.activity_facts.map(row => row.user_id)).size, 1)
  assert.equal(decideIngest(final, i, [accepted, terminal], now).result.duplicateIds.length, 2)
  assert.equal(decideIngest(final, i, [{ ...accepted, initiator: 'system' }], now).result.rejected[0]?.code, 'EVENT_CONFLICT')
  assert.equal(decideIngest(final, i, [event(i, { occurredAt: new Date(now - 31 * 86400000).toISOString() })], now).result.rejected[0]?.code, 'EVENT_TIME_OUT_OF_RANGE')
  assert.equal(decideIngest(final, i, [event(i, { employee: { source: 'welink', employeeId: 'test-person', chineseName: 'Current', profileUpdatedAt: new Date(now).toISOString() } })], now).changes.find(row => row.table === 'users')?.row?.chinese_name, 'Current')
})

test('configuration has only a ClickHouse backend and accepts credentials by environment name', () => {
  assert.equal(AnalyticsConfigSchema.parse({}).clickhouse.database, 'website_analytics_dual')
  for (const input of [{ writeBackend: 'sqlite' }, { readBackend: 'sqlite' }, { query: { fallbackToSqlite: true } }, { clickhouse: { password: 'not-allowed' } }, { clickhouse: { url: 'http://user:password@localhost:8123' } }]) assert.equal(AnalyticsConfigSchema.safeParse(input).success, false)
})
