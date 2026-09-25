import type { CloudSchedule, CloudTaskDefinition } from '@dsh-ops/cloud-task-contract'

// Port of the product scheduled-task "next trigger" semantics (packages/features/scheduled-tasks/src/schedule.ts)
// for the three cloud schedule kinds. Calendar schedules are evaluated on the wall clock of `timeZone` with
// Intl; a wall-clock time skipped by a DST gap is dropped, an ambiguous one resolves to the earlier instant.
const MAX_CALENDAR_SEARCH_DAYS = 366 * 12
const CLOCK_PATTERN = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u
const OFFSET_PATTERN = /^GMT(?:(?<sign>[+-])(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?)?$/u

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }

export class ScheduleError extends Error {}

export function canonicalTimeZone(value: string): string {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone }
  catch { throw new ScheduleError('INVALID_TIME_ZONE') }
}

/** First occurrence strictly after `afterEpoch`, or null when the schedule never fires again. */
export function nextOccurrence(schedule: CloudSchedule, afterEpoch: number): number | null {
  if (!Number.isSafeInteger(afterEpoch)) throw new ScheduleError('INVALID_EPOCH')
  if (schedule.kind === 'once') {
    const target = Date.parse(schedule.at)
    return target > afterEpoch ? target : null
  }
  if (schedule.kind === 'interval') {
    const anchor = Date.parse(schedule.anchorAt)
    const interval = schedule.everyMinutes * 60_000
    if (afterEpoch < anchor) return anchor
    return anchor + (Math.floor((afterEpoch - anchor) / interval) + 1) * interval
  }
  return calendarOccurrence(schedule, afterEpoch)
}

/** Next run of a task definition after `afterEpoch`, honouring the activeFrom/activeUntil window. */
export function nextRunAt(definition: Pick<CloudTaskDefinition, 'schedule' | 'activeFrom' | 'activeUntil'>, afterEpoch: number): number | null {
  const from = definition.activeFrom === undefined ? undefined : Date.parse(definition.activeFrom)
  const until = definition.activeUntil === undefined ? undefined : Date.parse(definition.activeUntil)
  // An occurrence exactly at activeFrom counts, hence the "- 1".
  const candidate = nextOccurrence(definition.schedule, from !== undefined ? Math.max(afterEpoch, from - 1) : afterEpoch)
  if (candidate !== null && until !== undefined && candidate > until) return null
  return candidate
}

function calendarOccurrence(schedule: Extract<CloudSchedule, { kind: 'calendar' }>, boundaryEpoch: number): number | null {
  const zone = canonicalTimeZone(schedule.timeZone)
  const clock = CLOCK_PATTERN.exec(schedule.time)?.groups
  if (clock === undefined) throw new ScheduleError('INVALID_TIME')
  const boundaryLocal = projectLocal(boundaryEpoch, zone)
  let dateEpoch = utcDateEpoch(boundaryLocal.year, boundaryLocal.month, boundaryLocal.day)
  for (let index = 0; index < MAX_CALENDAR_SEARCH_DAYS; index += 1) {
    const date = new Date(dateEpoch)
    const parts: LocalParts = {
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: Number(clock.hour), minute: Number(clock.minute), second: 0, millisecond: 0,
    }
    if (matchesCalendar(schedule, parts)) {
      const resolved = resolveLocal(parts, zone)
      if (resolved !== null && resolved > boundaryEpoch) return resolved
    }
    dateEpoch += 86_400_000
  }
  return null
}

function matchesCalendar(schedule: Extract<CloudSchedule, { kind: 'calendar' }>, parts: LocalParts): boolean {
  if (schedule.frequency === 'daily') return true
  if (schedule.frequency === 'monthly') return parts.day === schedule.dayOfMonth
  const weekday = new Date(utcDateEpoch(parts.year, parts.month, parts.day)).getUTCDay() || 7
  return (schedule.weekdays ?? []).includes(weekday)
}

function resolveLocal(parts: LocalParts, timeZone: string): number | null {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond)
  const offsets = new Set<number>()
  for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) offsets.add(projectLocal(naive + delta, timeZone).offset)
  const candidates: number[] = []
  for (const offset of offsets) {
    const candidate = naive - offset
    if (sameLocal(parts, projectLocal(candidate, timeZone))) candidates.push(candidate)
  }
  return candidates.sort((left, right) => left - right)[0] ?? null
}

function projectLocal(epoch: number, timeZone: string): LocalParts & { offset: number } {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset',
  })
  const values = Object.fromEntries(formatter.formatToParts(epoch).map(part => [part.type, part.value]))
  const offsetMatch = OFFSET_PATTERN.exec(values.timeZoneName ?? '')?.groups
  if (offsetMatch === undefined) throw new ScheduleError('INVALID_TIME_ZONE')
  const sign = offsetMatch.sign === '-' ? -1 : 1
  const offset = offsetMatch.sign === undefined ? 0 : sign * (Number(offsetMatch.hour) * 3_600_000 + Number(offsetMatch.minute) * 60_000 + Number(offsetMatch.second ?? '0') * 1_000)
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second), millisecond: Number(values.fractionalSecond), offset,
  }
}

function utcDateEpoch(year: number, month: number, day: number): number {
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(year, month - 1, day)
  return value.getTime()
}

function sameLocal(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute && left.second === right.second && left.millisecond === right.millisecond
}
