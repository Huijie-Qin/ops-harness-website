import { z } from 'zod'

/** Require an explicit timezone so the operator's cutoff is independent of the host timezone. */
export function parseBackfillSince(value: unknown): string {
  if (value === undefined) throw new Error('SINCE_REQUIRED')
  const parsed = z.iso.datetime({ offset: true }).safeParse(value)
  if (!parsed.success) throw new Error('SINCE_MUST_BE_ISO_TIMESTAMP_WITH_TIMEZONE')
  return new Date(parsed.data).toISOString()
}
