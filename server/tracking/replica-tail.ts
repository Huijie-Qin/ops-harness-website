/** Historical unpublished intervals remain invisible after adopting a migrated database. */
export type ReplicaTail = { after: number; through: number }
export function replicaTailSql(ranges: readonly ReplicaTail[] = []) {
  return ranges.map(range => {
    if (!Number.isSafeInteger(range.after) || !Number.isSafeInteger(range.through) || range.after < 0 || range.through <= range.after) throw new Error('INVALID_ANALYTICS_EXCLUDED_RANGE')
    return ` AND NOT (commit_seq > ${range.after} AND commit_seq <= ${range.through})`
  }).join('')
}
