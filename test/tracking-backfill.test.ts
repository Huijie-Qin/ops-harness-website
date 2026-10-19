import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { integrationTest as test, createTestDatabase, prepareTestDatabase } from './helpers/clickhouse.js'
import { event, installation } from './helpers/tracking-events.js'
import { TABLES, TABLE_META, applyChanges, emptyState, canonical, hashCanonical, rowKey, type State } from '../server/tracking/canonical.js'
import { decideIngest } from '../server/tracking/decision.js'
import { backfillSqlite } from '../scripts/tracking/backfill.js'
import { dayAt } from '../server/tracking/types.js'
import { TrackingDatabase } from '../server/tracking/database.js'
import { ClickHouseHttpClient, initializeClickHouse } from '../server/tracking/clickhouse.js'
import { qualified, identifier } from '../server/tracking/clickhouse-schema.js'

function writeSource(file: string, state: State) {
  const db = new DatabaseSync(file)
  try {
    for (const table of TABLES) {
      const columns = TABLE_META[table].columns
      db.exec(`CREATE TABLE ${table} (${columns.map(column => `"${column}"`).join(',')})`)
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of state[table]) insert.run(...columns.map(column => row[column]!))
    }
  } finally { db.close() }
}
const query = () => ({ from: dayAt(Date.now() - 60 * 86400000), to: dayAt(Date.now()), environment: 'all', offset: 0, limit: 100 })

test('backfill adds missing rows and changed pending facts, skips bad rows, maps employees, and can be repeated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-backfill-')), db = await createTestDatabase(root)
  try {
    const i = installation(), now = Date.now(), accepted = event(i)
    const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
    // The migrated database has a pending terminal and an existing employee ID.
    await db.ingest(i, [terminal])
    const first = decideIngest(emptyState(), i, [terminal], now)
    const source = applyChanges(applyChanges(emptyState(), first.changes), decideIngest(applyChanges(emptyState(), first.changes), i, [accepted], now).changes)
    const old = event(i, { occurredAt: new Date(now - 45 * 86400000).toISOString(), employee: { source: 'welink', employeeId: 'older-person' } })
    const final = applyChanges(source, decideIngest(source, i, [old], now - 45 * 86400000).changes)
    const sourceFile = path.join(root, 'source.sqlite')
    writeSource(sourceFile, final)
    const corrupt = new DatabaseSync(sourceFile)
    corrupt.prepare('INSERT INTO tracking_events VALUES (?,?,?,?)').run(null, randomUUID(), '{}', new Date(now).toISOString()); corrupt.close()
    const before = await readFile(sourceFile)
    const recent = await backfillSqlite(sourceFile, db.backend, { since: new Date(now - 86400000).toISOString(), batchSize: 1 })
    // The previously migrated terminal may also differ in its server receipt timestamp.
    assert.equal(recent.find(row => row.table === 'tracking_events')?.read, 3)
    assert.equal((await db.query('health', query())).collected, 2)
    assert.equal((await db.query('users', query())).total, 1)
    const since = new Date(now - 60 * 86400000).toISOString()
    const report = await backfillSqlite(sourceFile, db.backend, { since, batchSize: 1 })
    assert.ok(report.reduce((n, row) => n + row.written, 0) > 0)
    assert.equal(report.find(row => row.table === 'tracking_events')?.skipped, 1)
    assert.deepEqual(await readFile(sourceFile), before)
    assert.equal((await db.query('health', query())).collected, 3)
    assert.equal((await db.query('overview', query())).successes, 1)
    assert.equal((await db.query('users', query())).total, 2)
    const again = await backfillSqlite(sourceFile, db.backend, { since, batchSize: 2 })
    assert.equal(again.reduce((n, row) => n + row.written, 0), 0)
    assert.equal((await db.ingest(i, [accepted])).duplicateIds.length, 1)
    assert.equal((await db.ingest(i, [event(i)])).acceptedIds.length, 1)
    assert.equal((await db.query('users', query())).total, 2)
  } finally { await db.close(); await rm(root, { recursive: true, force: true }) }
})

test('a partially inserted batch recovers after restart and an ambiguous publication does not double count', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-recovery-'))
  const config = await prepareTestDatabase(root)
  let db = new TrackingDatabase(root, config)
  try {
    await db.ready
    const i = installation(), accepted = event(i), insert = db.backend.client.insert.bind(db.backend.client)
    db.backend.client.insert = async (table, rows, options) => {
      if (table === 'activity_fact_versions') throw new Error('SIMULATED_CONNECTION_LOSS')
      return insert(table, rows, options)
    }
    await assert.rejects(db.ingest(i, [accepted]), /SIMULATED_CONNECTION_LOSS/)
    assert.equal((await db.query('health', query())).collected, 0)
    await db.close(); db = new TrackingDatabase(root, config); await db.ready
    assert.equal((await db.ingest(i, [accepted])).duplicateIds.length, 1)
    const second = event(i), publish = db.backend.client.insert.bind(db.backend.client)
    db.backend.client.insert = async (table, rows, options) => { await publish(table, rows, options); if (table === 'published_watermarks') throw new Error('SIMULATED_RESPONSE_LOSS') }
    await assert.rejects(db.ingest(i, [second]), /SIMULATED_RESPONSE_LOSS/)
    await db.close(); db = new TrackingDatabase(root, config); await db.ready
    assert.equal((await db.ingest(i, [second])).duplicateIds.length, 1)
    assert.equal((await db.query('health', query())).collected, 2)
  } finally { await db.close(); await rm(root, { recursive: true, force: true }) }
})

test('adopts origin/main version tables and keeps unpublished legacy versions hidden as new commits advance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-adopt-')), config = await prepareTestDatabase(root)
  const client = new ClickHouseHttpClient(config.clickhouse), table = (name: string) => qualified(client.database, name)
  let db: TrackingDatabase | undefined
  try {
    // Remove only the test runtime marker, leaving the same origin/main business/control DDL.
    const epoch = String((await client.query(`SELECT epoch FROM ${table('projection_manifest')} LIMIT 1`))[0]!.epoch)
    await client.command(`TRUNCATE TABLE ${table('tracking_runtime')}`)
    const version = (seq: number, count: number) => ({ source_epoch: epoch, key: rowKey('ingestion_health', { code: 'TEST' }), commit_seq: String(seq), deleted: 0, payload: canonical({ code: 'TEST', count }), payload_hash: hashCanonical({ code: 'TEST', count }), retention_day: '', partition_date: '1970-01-01', physical_delete_at: '2106-02-07 06:28:15' })
    await client.insert('ingestion_health_versions', [version(1, 1), version(2, 999), version(6, 9999)])
    await client.insert('published_watermarks', [{ epoch, seq: '5', hash: hashCanonical('legacy'), baseline: 0 }])
    await client.command(`CREATE TABLE ${table('authority_manifest')} (revision UInt64,payload String) ENGINE=MergeTree ORDER BY revision`)
    await client.insert('authority_manifest', [{ revision: 1, payload: canonical({ epoch, replicaTail: { after: 1, through: 3 } }) }])
    await client.command(`CREATE TABLE ${table('ingest_commits')} (source_epoch UUID,seq UInt64) ENGINE=MergeTree ORDER BY (source_epoch,seq)`)
    await client.insert('ingest_commits', [{ source_epoch: epoch, seq: '7' }])
    const state = await initializeClickHouse(client)
    assert.equal(state.startSeq, 8)
    assert.deepEqual(await initializeClickHouse(client), state)
    db = new TrackingDatabase(root, config); await db.ready
    assert.equal((await db.backend.rows('ingestion_health'))[0]!.count, 1)
    const i = installation(), value = event(i)
    assert.equal((await db.ingest(i, [value])).acceptedIds.length, 1)
    assert.equal((await db.backend.rows('ingestion_health'))[0]!.count, 1)
    await db.close(); db = new TrackingDatabase(root, config); await db.ready
    assert.equal((await db.ingest(i, [value])).duplicateIds.length, 1)
    assert.equal((await db.backend.rows('ingestion_health'))[0]!.count, 1)
  } finally { if (db) await db.close(); client.close(); await rm(root, { recursive: true, force: true }) }
})

test('runtime works with SELECT/INSERT writer and readonly reader, serializes retries and drops expired queued work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-permissions-')), config = await prepareTestDatabase(root)
  const admin = new ClickHouseHttpClient(config.clickhouse), suffix = randomUUID().replaceAll('-', '')
  const writer = `website_writer_${suffix}`, reader = `website_reader_${suffix}`
  let db: TrackingDatabase | undefined
  try {
    await admin.command(`CREATE USER ${writer} IDENTIFIED WITH no_password`)
    await admin.command(`CREATE USER ${reader} IDENTIFIED WITH no_password SETTINGS readonly=2`)
    await admin.command(`GRANT SELECT,INSERT ON ${identifier(admin.database)+'.*'} TO ${writer}`)
    await admin.command(`GRANT SELECT ON ${identifier(admin.database)+'.*'} TO ${reader}`)
    db = new TrackingDatabase(root, { ...config, clickhouse: { ...config.clickhouse, writerUser: writer, readerUser: reader } })
    await db.ready
    const i = installation(), value = event(i)
    const results = await Promise.all(Array.from({ length: 6 }, () => db!.ingest(i, [value])))
    assert.equal(results.reduce((sum, result) => sum + result.acceptedIds.length, 0), 1)
    assert.equal(results.reduce((sum, result) => sum + result.duplicateIds.length, 0), 5)
    await assert.rejects(db.ingest(i, [event(i)], Date.now() - 1), /ANALYTICS_QUEUE_TIMEOUT/)
    assert.equal((await db.query('health', query())).collected, 1)
  } finally {
    if (db) await db.close()
    await admin.command(`DROP USER IF EXISTS ${writer},${reader}`)
    admin.close(); await rm(root, { recursive: true, force: true })
  }
})
