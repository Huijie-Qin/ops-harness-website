import { parseArgs } from 'node:util'
import path from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { loadConfig } from '../../server/config.js'
import { ClickHouseHttpClient, initializeClickHouse } from '../../server/tracking/clickhouse.js'
import { TrackingDatabase } from '../../server/tracking/database.js'
import { acquireTrackingLock } from '../../server/tracking/lock.js'
import { parseBackfillSince } from './backfill-time.js'
import { parseTrackingTimeout, trackingAnalyticsConfig } from './resources.js'

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, sqlite: { type: 'string' }, since: { type: 'string' }, 'batch-size': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log('pnpm tracking init [--config /path/website.json] [--timeout-ms 300000]\npnpm tracking backfill --sqlite /path/analytics.sqlite --since "2026-10-18T10:00:00+08:00" [--config /path/website.json] [--batch-size 500] [--timeout-ms 300000]\n--since is required, timezone-qualified and inclusive. Related identities/context are included; daily totals include the cutoff day; undated health counters are skipped.\npnpm tracking starts Node with a 16384 MiB old-space limit. --timeout-ms sets each ClickHouse request/read budget (1000-300000 ms, default 300000); there is no overall migration deadline.\nStop the previous website writer before init and final backfill. The SQLite source is opened read-only.'); return
  }
  const command = positionals[0]
  if (positionals.length !== 1 || !['init', 'backfill'].includes(command!)) throw new Error('EXPECTED_INIT_OR_BACKFILL')
  if (command === 'backfill' && !values.sqlite) throw new Error('SQLITE_SOURCE_REQUIRED')
  const since = command === 'backfill' ? parseBackfillSince(values.since) : undefined
  const timeoutMs = parseTrackingTimeout(values['timeout-ms'])
  const config = await loadConfig(values.config)
  const analytics = trackingAnalyticsConfig(config.analytics, timeoutMs)
  console.log(JSON.stringify({ step: 'starting', command, heapLimitMiB: Math.floor(getHeapStatistics().heap_size_limit / 1024 / 1024), requestTimeoutMs: analytics.clickhouse.requestTimeoutMs, queryTimeoutMs: analytics.queryTimeoutMs, ...(since ? { since } : {}) }))
  if (command === 'init') {
    const unlock = acquireTrackingLock(config.analyticsDirectory, 'clickhouse-init')
    const connection = analytics.clickhouse
    const client = new ClickHouseHttpClient({ ...connection, writerUser: connection.adminUser, writerPasswordEnv: connection.adminPasswordEnv })
    try {
      const state = await initializeClickHouse(client)
      console.log(JSON.stringify({ step: 'initialized', database: connection.database, epoch: state.epoch, startSeq: state.startSeq }))
    } finally { client.close(); unlock() }
    return
  }
  const store = new TrackingDatabase(config.analyticsDirectory, analytics)
  try {
    await store.ready
    // SQLite is loaded only for this explicit offline command, never by the website or init.
    const { backfillSqlite } = await import('./backfill.js')
    const report = await backfillSqlite(path.resolve(values.sqlite!), store.backend, {
      since: since!,
      batchSize: Number(values['batch-size'] ?? 500),
      progress: counts => console.log(JSON.stringify({ step: 'backfill', ...counts })),
    })
    console.log(JSON.stringify({ step: 'complete', since, tables: report }))
  } finally { await store.close() }
}
main().catch(error => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'TRACKING_COMMAND_FAILED'
  const diagnostics = error && typeof error === 'object' && 'diagnostics' in error ? error.diagnostics : undefined
  console.error(JSON.stringify({ error: code, ...(diagnostics ? { diagnostics } : {}) })); process.exitCode = 1
})
