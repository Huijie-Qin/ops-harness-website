import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudScheduleSchema, CloudTaskDefinitionSchema } from '@dsh-ops/cloud-task-contract'
import { nextOccurrence, nextRunAt, ScheduleError } from '../server/cloud/schedule.js'

const at = (value: string) => Date.parse(value)
const iso = (epoch: number | null) => epoch === null ? null : new Date(epoch).toISOString()
const schedule = (value: unknown) => CloudScheduleSchema.parse(value)

test('once fires exactly once and never again', () => {
  const once = schedule({ kind: 'once', at: '2026-10-01T02:00:00.000Z' })
  assert.equal(iso(nextOccurrence(once, at('2026-09-30T00:00:00Z'))), '2026-10-01T02:00:00.000Z')
  assert.equal(nextOccurrence(once, at('2026-10-01T02:00:00Z')), null)
})

test('interval walks from the anchor in fixed steps, before and after the anchor', () => {
  const every = schedule({ kind: 'interval', everyMinutes: 90, anchorAt: '2026-09-25T08:00:00.000Z' })
  assert.equal(iso(nextOccurrence(every, at('2026-09-20T00:00:00Z'))), '2026-09-25T08:00:00.000Z')
  assert.equal(iso(nextOccurrence(every, at('2026-09-25T08:00:00Z'))), '2026-09-25T09:30:00.000Z')
  assert.equal(iso(nextOccurrence(every, at('2026-09-25T09:29:59.999Z'))), '2026-09-25T09:30:00.000Z')
  assert.equal(iso(nextOccurrence(every, at('2026-09-26T00:10:00Z'))), '2026-09-26T00:30:00.000Z')
})

test('daily calendar respects the configured time zone and its offset', () => {
  const shanghai = schedule({ kind: 'calendar', frequency: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' })
  assert.equal(iso(nextOccurrence(shanghai, at('2026-09-25T01:29:00Z'))), '2026-09-25T01:30:00.000Z')
  assert.equal(iso(nextOccurrence(shanghai, at('2026-09-25T01:30:00Z'))), '2026-09-26T01:30:00.000Z')
  const newYork = schedule({ kind: 'calendar', frequency: 'daily', time: '09:30', timeZone: 'America/New_York' })
  // EDT (UTC-4) in September, EST (UTC-5) after the November switch.
  assert.equal(iso(nextOccurrence(newYork, at('2026-09-25T00:00:00Z'))), '2026-09-25T13:30:00.000Z')
  assert.equal(iso(nextOccurrence(newYork, at('2026-11-02T00:00:00Z'))), '2026-11-02T14:30:00.000Z')
})

test('DST gap drops the skipped wall-clock time and continues the next day', () => {
  // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
  const gap = schedule({ kind: 'calendar', frequency: 'daily', time: '02:30', timeZone: 'America/New_York' })
  assert.equal(iso(nextOccurrence(gap, at('2026-03-08T00:00:00Z'))), '2026-03-09T06:30:00.000Z')
})

test('weekly uses ISO weekdays with Monday = 1', () => {
  const weekly = schedule({ kind: 'calendar', frequency: 'weekly', time: '18:00', timeZone: 'UTC', weekdays: [1, 5] })
  // 2026-09-25 is a Friday.
  assert.equal(iso(nextOccurrence(weekly, at('2026-09-25T17:59:00Z'))), '2026-09-25T18:00:00.000Z')
  assert.equal(iso(nextOccurrence(weekly, at('2026-09-25T18:00:00Z'))), '2026-09-28T18:00:00.000Z')
  assert.equal(iso(nextOccurrence(weekly, at('2026-09-28T18:00:00Z'))), '2026-10-02T18:00:00.000Z')
})

test('monthly on day 31 skips shorter months; day 29 skips February outside leap years', () => {
  const thirtyFirst = schedule({ kind: 'calendar', frequency: 'monthly', time: '00:00', timeZone: 'UTC', dayOfMonth: 31 })
  assert.equal(iso(nextOccurrence(thirtyFirst, at('2026-01-31T00:00:00Z'))), '2026-03-31T00:00:00.000Z')
  assert.equal(iso(nextOccurrence(thirtyFirst, at('2026-03-31T00:00:00Z'))), '2026-05-31T00:00:00.000Z')
  const twentyNinth = schedule({ kind: 'calendar', frequency: 'monthly', time: '00:00', timeZone: 'UTC', dayOfMonth: 29 })
  assert.equal(iso(nextOccurrence(twentyNinth, at('2027-01-29T00:00:00Z'))), '2027-03-29T00:00:00.000Z')
  assert.equal(iso(nextOccurrence(twentyNinth, at('2028-01-29T00:00:00Z'))), '2028-02-29T00:00:00.000Z')
})

test('activeFrom and activeUntil bound the next run and an exhausted window returns null', () => {
  const base = CloudTaskDefinitionSchema.parse({
    name: 'x', expertId: 'e', prompt: 'p', schedule: { kind: 'interval', everyMinutes: 60, anchorAt: '2026-09-25T00:00:00.000Z' },
    activeFrom: '2026-09-26T00:00:00.000Z', activeUntil: '2026-09-26T02:00:00.000Z',
  })
  assert.equal(iso(nextRunAt(base, at('2026-09-25T05:00:00Z'))), '2026-09-26T00:00:00.000Z')
  assert.equal(iso(nextRunAt(base, at('2026-09-26T00:00:00Z'))), '2026-09-26T01:00:00.000Z')
  assert.equal(iso(nextRunAt(base, at('2026-09-26T01:00:00Z'))), '2026-09-26T02:00:00.000Z')
  assert.equal(nextRunAt(base, at('2026-09-26T02:00:00Z')), null)
})

test('unknown time zones are rejected instead of silently using UTC', () => {
  assert.throws(() => nextOccurrence(schedule({ kind: 'calendar', frequency: 'daily', time: '09:00', timeZone: 'Mars/Olympus' }), 0), ScheduleError)
})
