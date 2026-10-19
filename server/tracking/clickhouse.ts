import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { TABLES, canonical, hashCanonical, rowKey, type Change, type Row, type TableName } from './canonical.js'
import type { AnalyticsConfig } from './config.js'
import type { AnalyticsQuery } from './types.js'
import { ClickHouseHttpClient } from './clickhouse-http.js'
import { analyticsSql, logicalTableSql, normalizeQueryRow, snapshotParams, type QueryParams } from './clickhouse-query.js'
import { controlDdls, entityDdl, identifier, qualified, RETAINED_TABLES, versionTable } from './clickhouse-schema.js'
import { replicaTailSql, type ReplicaTail } from './replica-tail.js'

export { ClickHouseHttpClient } from './clickhouse-http.js'
export type RuntimeState = { epoch: string; startSeq: number; excluded: ReplicaTail[]; ttlGraceSeconds: number }
type Version = { source_epoch: string; key: string; commit_seq: string; deleted: number; payload: string; payload_hash: string; retention_day: string; partition_date: string; physical_delete_at: string }
type Commit = { epoch: string; seq: number; createdAt: string; versions: Partial<Record<TableName, Version[]>> }
type Pending = { target: string; commit: Commit; hash: string }
const DAY = 86400000, FOREVER = '2106-02-07 06:28:15'
const integer = (value: unknown) => {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('INVALID_ANALYTICS_SEQUENCE')
  return result
}
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
}
function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, file); syncDirectory(path.dirname(file))
}

/** Run offline with DDL credentials, after stopping the previous website writer. */
export async function initializeClickHouse(client: ClickHouseHttpClient): Promise<RuntimeState> {
  const table = (name: string) => qualified(client.database, name)
  await client.command(`CREATE DATABASE IF NOT EXISTS ${identifier(client.database)}`, {}, { database: 'default' })
  for (const ddl of controlDdls(client.database)) await client.command(ddl)
  for (const name of TABLES) await client.command(entityDdl(client.database, name))
  await client.command(`CREATE TABLE IF NOT EXISTS ${table('tracking_runtime')} (payload String) ENGINE=MergeTree ORDER BY tuple() SETTINGS fsync_after_insert=1,fsync_part_directory=1`)
  await client.command(`CREATE TABLE IF NOT EXISTS ${table('tracking_commits')} (
    source_epoch UUID,seq UInt64,created_at DateTime('UTC'),payload String,hash FixedString(64)
    ) ENGINE=ReplacingMergeTree ORDER BY (source_epoch,seq) TTL created_at + INTERVAL 7 DAY DELETE
    SETTINGS fsync_after_insert=1,fsync_part_directory=1`)
  const existing = await client.query(`SELECT DISTINCT payload FROM ${table('tracking_runtime')}`)
  if (existing.length > 1) throw new Error('ANALYTICS_RUNTIME_CONFLICT')
  if (existing.length) return JSON.parse(String(existing[0]!.payload)) as RuntimeState
  let manifests = await client.query(`SELECT DISTINCT epoch,ttl_grace_seconds FROM ${table('projection_manifest')}`)
  if (!manifests.length) {
    // Refuse to hide data accidentally by creating a new epoch in a nonempty target.
    for (const name of TABLES) if ((await client.query(`SELECT 1 FROM ${table(versionTable(name))} LIMIT 1`)).length) throw new Error('ANALYTICS_EPOCH_MISSING')
    const epoch = randomUUID(), hash = hashCanonical({ epoch })
    await client.insert('projection_manifest', [{ epoch, projection_id: 'clickhouse-only', baseline_seq: '0', manifest_hash: hash, ttl_grace_seconds: 86400 }])
    await client.insert('published_watermarks', [{ epoch, seq: '0', hash, baseline: 1 }])
    manifests = [{ epoch, ttl_grace_seconds: 86400 }]
  }
  if (manifests.length !== 1) throw new Error('ANALYTICS_EPOCH_AMBIGUOUS')
  const epoch = String(manifests[0]!.epoch)
  const heads = await client.query(`SELECT max(seq) AS seq,count() AS count FROM ${table('published_watermarks')} WHERE epoch={epoch:UUID}`, { epoch })
  if (!Number(heads[0]?.count)) throw new Error('ANALYTICS_BASELINE_NOT_READY')
  const watermark = integer(heads[0]!.seq)
  let high = watermark
  for (const name of TABLES) {
    const rows = await client.query(`SELECT max(commit_seq) AS seq FROM ${table(versionTable(name))} WHERE source_epoch={epoch:UUID}`, { epoch })
    high = Math.max(high, integer(rows[0]?.seq ?? 0))
  }
  for (const name of ['delivery_intents', 'delivery_receipts']) {
    const rows = await client.query(`SELECT max(seq) AS seq FROM ${table(name)} WHERE epoch={epoch:UUID}`, { epoch })
    high = Math.max(high, integer(rows[0]?.seq ?? 0))
  }
  const excluded: ReplicaTail[] = []
  if (Number((await client.query(`EXISTS TABLE ${table('authority_manifest')}`))[0]?.result)) {
    const rows = await client.query(`SELECT payload FROM ${table('authority_manifest')} ORDER BY revision DESC LIMIT 1`)
    const previous = rows[0] ? JSON.parse(String(rows[0].payload)) as { epoch?: string; replicaTail?: ReplicaTail } : undefined
    if (previous?.epoch === epoch && previous.replicaTail) {
      excluded.push(previous.replicaTail)
      high = Math.max(high, integer(previous.replicaTail.through))
    }
  }
  if (Number((await client.query(`EXISTS TABLE ${table('ingest_commits')}`))[0]?.result)) {
    const rows = await client.query(`SELECT max(seq) AS seq FROM ${table('ingest_commits')} WHERE source_epoch={epoch:UUID}`, { epoch })
    high = Math.max(high, integer(rows[0]?.seq ?? 0))
  }
  if (high > watermark) excluded.push({ after: watermark, through: high })
  replicaTailSql(excluded)
  const state: RuntimeState = { epoch, startSeq: integer(high + 1), excluded, ttlGraceSeconds: Math.max(86400, integer(manifests[0]!.ttl_grace_seconds)) }
  for (const name of RETAINED_TABLES) await client.command(`ALTER TABLE ${table(versionTable(name))} MODIFY TTL physical_delete_at DELETE`)
  await client.insert('tracking_runtime', [{ payload: canonical(state) }])
  return state
}

/** One writer, published snapshots, and replayable multi-table commits. No schema/authority scans on ingestion. */
export class ClickHouseBackend {
  readonly client: ClickHouseHttpClient
  readonly reader: ClickHouseHttpClient
  private state!: RuntimeState
  private watermark = 0
  private pending: Pending | undefined
  private readonly pendingFile: string
  constructor(readonly directory: string, readonly config: AnalyticsConfig, private readonly now = Date.now) {
    this.client = new ClickHouseHttpClient(config.clickhouse)
    this.reader = new ClickHouseHttpClient(config.clickhouse, 'reader')
    this.pendingFile = path.join(directory, 'clickhouse-pending.json')
  }
  private table(name: string) { return qualified(this.client.database, name) }
  private get target() { return `${this.config.clickhouse.url}/${this.client.database}/${this.state.epoch}` }
  async open() {
    const records = await this.client.query(`SELECT DISTINCT payload FROM ${this.table('tracking_runtime')}`)
    if (records.length !== 1) throw new Error('ANALYTICS_NOT_INITIALIZED_RUN_TRACKING_INIT')
    this.state = JSON.parse(String(records[0]!.payload)) as RuntimeState
    integer(this.state.startSeq); replicaTailSql(this.state.excluded)
    this.watermark = integer((await this.client.query(`SELECT max(seq) AS seq FROM ${this.table('published_watermarks')} WHERE epoch={epoch:UUID}`, { epoch: this.state.epoch }))[0]?.seq)
    // The local record preserves the exact bytes of a request with an unknown network outcome.
    if (existsSync(this.pendingFile)) {
      this.pending = JSON.parse(readFileSync(this.pendingFile, 'utf8')) as Pending
      if (this.pending.target !== this.target || hashCanonical(this.pending.commit) !== this.pending.hash) throw new Error('ANALYTICS_PENDING_TARGET_MISMATCH')
      await this.recover()
    }
    for await (const row of this.client.iterate(`SELECT seq,payload,hash FROM ${this.table('tracking_commits')} WHERE source_epoch={epoch:UUID} AND seq>{watermark:UInt64} GROUP BY seq,payload,hash ORDER BY seq`, { epoch: this.state.epoch, watermark: this.watermark })) {
      const commit = JSON.parse(String(row.payload)) as Commit
      if (hashCanonical(commit) !== row.hash || commit.epoch !== this.state.epoch || commit.seq !== integer(row.seq)) throw new Error('ANALYTICS_COMMIT_INVALID')
      this.pending = { target: this.target, commit, hash: String(row.hash) }
      atomicJson(this.pendingFile, this.pending)
      await this.recover()
    }
  }
  async recover() {
    if (!this.pending) return
    const { commit, hash } = this.pending
    if (commit.seq > this.watermark) {
      if (commit.seq !== Math.max(this.state.startSeq, this.watermark + 1)) throw new Error('ANALYTICS_COMMIT_OUT_OF_ORDER')
      if (Date.now() - Date.parse(commit.createdAt) > 7 * DAY) throw new Error('ANALYTICS_PENDING_EXPIRED')
      await this.client.insert('tracking_commits', [{ source_epoch: commit.epoch, seq: String(commit.seq), created_at: commit.createdAt, payload: canonical(commit), hash }])
      // Identical versions are safe to replay if an INSERT or its response was interrupted.
      for (const name of TABLES) if (commit.versions[name]?.length) await this.client.insert(versionTable(name), commit.versions[name]!)
      await this.client.insert('published_watermarks', [{ epoch: commit.epoch, seq: String(commit.seq), hash, baseline: 0 }])
      this.watermark = commit.seq
    }
    if (existsSync(this.pendingFile)) { unlinkSync(this.pendingFile); syncDirectory(this.directory) }
    this.pending = undefined
  }
  async rows(table: TableName, filter: { keys?: string[]; predicate?: string; params?: QueryParams } = {}, at = this.now()): Promise<Row[]> {
    if (filter.keys?.length === 0) return []
    const sql = logicalTableSql(this.client.database, table, this.state.excluded, filter.keys !== undefined)
    const rows = await this.reader.query(`SELECT payload FROM (${sql}) WHERE ${filter.predicate ?? '1'}`, {
      ...snapshotParams(this.state.epoch, this.watermark, at), ...filter.params, ...(filter.keys ? { snapshotKeys: filter.keys } : {}),
    }, { timeoutMs: this.config.queryTimeoutMs, retryOnConnectionLoss: true })
    return rows.map(row => JSON.parse(String(row.payload)) as Row)
  }
  async query(kind: string, query: AnalyticsQuery) {
    const deadline = Date.now() + this.config.queryTimeoutMs
    const plan = analyticsSql(this.client.database, this.state.epoch, this.watermark, this.now(), kind, query, this.state.excluded)
    const results = await Promise.all(plan.queries.map(async sql => (await this.reader.query(sql, plan.params, { deadline, retryOnConnectionLoss: true })).map(normalizeQueryRow)))
    return plan.finish(results)
  }
  private async prior(table: TableName, keys: string[]) {
    if (!keys.length) return new Map<string, Version>()
    const rows = await this.client.query(`SELECT key,argMax(payload,commit_seq) AS payload,argMax(retention_day,commit_seq) AS retention_day,
      argMax(partition_date,commit_seq) AS partition_date,max(physical_delete_at) AS physical_delete_at
      FROM ${this.table(versionTable(table))} WHERE source_epoch={epoch:UUID} AND commit_seq<={watermark:UInt64}
      AND key IN {keys:Array(String)}${replicaTailSql(this.state.excluded)} GROUP BY key`, { epoch: this.state.epoch, watermark: this.watermark, keys })
    return new Map(rows.map(row => [String(row.key), row as unknown as Version]))
  }
  async commit(changes: Change[]) {
    await this.recover()
    if (!changes.length) return
    const seq = integer(Math.max(this.state.startSeq, this.watermark + 1))
    const prior = new Map<TableName, Map<string, Version>>()
    const facts = new Map(changes.filter(change => change.table === 'activity_facts').map(change => [change.key, change.row]))
    await Promise.all([...RETAINED_TABLES].map(async table => {
      const keys = changes.filter(change => change.table === table).map(change => change.key)
      if (table === 'activity_facts') for (const change of changes) if (change.table === 'runtime_facts' && !facts.has(change.key)) keys.push(change.key)
      prior.set(table, await this.prior(table, [...new Set(keys)]))
    }))
    for (const [key, previous] of prior.get('activity_facts') ?? []) if (!facts.has(key)) facts.set(key, JSON.parse(previous.payload) as Row | null)
    const versions: Commit['versions'] = {}
    for (const change of changes) {
      const { table, key, row } = change, previous = prior.get(table)?.get(key)
      const version: Version = { source_epoch: this.state.epoch, key, commit_seq: String(seq), deleted: row ? 0 : 1, payload: canonical(row), payload_hash: hashCanonical(row), retention_day: '', partition_date: '1970-01-01', physical_delete_at: FOREVER }
      if (row && rowKey(table, row) !== key) throw new Error('ANALYTICS_KEY_MISMATCH')
      if (RETAINED_TABLES.has(table)) {
        if (!row && previous) Object.assign(version, { retention_day: previous.retention_day, partition_date: previous.partition_date, physical_delete_at: previous.physical_delete_at })
        if (row) {
          let expires: number
          if (table === 'tracking_events' || table === 'event_dedup') {
            const received = Date.parse(String(row.received_at)); expires = received + (table === 'tracking_events' ? 90 : 120) * DAY
            version.partition_date = new Date(received).toISOString().slice(0, 10)
          } else if (table === 'identity_sessions') expires = Date.parse(String(row.expires_at)) + 120 * DAY
          else if (table === 'operations') {
            const times = [row.accepted, row.terminal].filter(Boolean).map(value => Date.parse(String(JSON.parse(String(value)).occurredAt)))
            expires = Math.max(...times) + 120 * DAY + 60000
          } else {
            const day = table === 'runtime_facts' ? facts.get(key)?.day : row.day
            if (typeof day !== 'string') throw new Error('ANALYTICS_RUNTIME_ORPHAN')
            version.retention_day = day; version.partition_date = day
            expires = Date.parse(`${day}T00:00:00+08:00`) + 401 * DAY
          }
          version.physical_delete_at = new Date(expires + this.state.ttlGraceSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
          if (previous && previous.physical_delete_at > version.physical_delete_at) version.physical_delete_at = previous.physical_delete_at
        }
      }
      ;(versions[table] ??= []).push(version)
    }
    const commit: Commit = { epoch: this.state.epoch, seq, createdAt: new Date().toISOString(), versions }
    this.pending = { target: this.target, commit, hash: hashCanonical(commit) }
    atomicJson(this.pendingFile, this.pending)
    await this.recover()
  }
  close() { this.client.close(); this.reader.close() }
}
