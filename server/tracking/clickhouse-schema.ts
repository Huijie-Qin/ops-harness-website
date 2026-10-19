import type { TableName } from './canonical.js'

export const ENTITY_TABLES: Record<TableName, string> = {
  installations: 'installation_versions', users: 'user_versions', user_identities: 'user_identity_versions',
  identity_sessions: 'identity_session_versions', event_dedup: 'event_dedup_versions', tracking_events: 'tracking_event_versions',
  operations: 'operation_versions', activity_facts: 'activity_fact_versions', runtime_facts: 'runtime_fact_versions',
  user_day: 'user_day_versions', ingestion_health: 'ingestion_health_versions',
}
export const RETAINED_TABLES = new Set<TableName>(['identity_sessions', 'event_dedup', 'tracking_events', 'operations', 'activity_facts', 'runtime_facts', 'user_day'])
export const PARTITIONED_TABLES = new Set<TableName>(['event_dedup', 'tracking_events', 'activity_facts', 'runtime_facts', 'user_day'])
export type AppendOnlySchema = { columns: readonly (readonly [string, string])[]; orderBy: string; partitionBy?: string }
export const CONTROL_SCHEMAS: Record<string, AppendOnlySchema> = {
  projection_manifest: { columns: [['epoch', 'UUID'], ['projection_id', 'String'], ['baseline_seq', 'UInt64'], ['manifest_hash', 'String'], ['ttl_grace_seconds', 'UInt64']], orderBy: 'epoch,projection_id' },
  delivery_receipts: { columns: [['epoch', 'UUID'], ['seq', 'UInt64'], ['hash', 'FixedString(64)'], ['previous_hash', 'String']], orderBy: 'epoch,seq' },
  delivery_intents: { columns: [['epoch', 'UUID'], ['seq', 'UInt64'], ['hash', 'FixedString(64)'], ['previous_hash', 'String']], orderBy: 'epoch,seq' },
  published_watermarks: { columns: [['epoch', 'UUID'], ['seq', 'UInt64'], ['hash', 'FixedString(64)'], ['baseline', 'UInt8']], orderBy: 'epoch,seq' },
}
export function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error('INVALID_CLICKHOUSE_IDENTIFIER')
  return `\`${value}\``
}
export function versionTable(table: TableName) { return ENTITY_TABLES[table] }
export function qualified(database: string, table: string) { return `${identifier(database)}.${identifier(table)}` }

/** Preserve the origin/main entity schema; offline initialization installs TTL. */
export function entityDdl(database: string, table: TableName): string {
  return `CREATE TABLE IF NOT EXISTS ${qualified(database, versionTable(table))} (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()
  ${PARTITIONED_TABLES.has(table) ? 'PARTITION BY toYYYYMM(partition_date)' : ''}
  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1`
}

export function controlDdls(database: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(database, 'projection_manifest')} (
      epoch UUID, projection_id String, baseline_seq UInt64, manifest_hash String, ttl_grace_seconds UInt64
    ) ENGINE=MergeTree() ORDER BY (epoch,projection_id) SETTINGS fsync_after_insert=1,fsync_part_directory=1`,
    `CREATE TABLE IF NOT EXISTS ${qualified(database, 'delivery_receipts')} (
      epoch UUID, seq UInt64, hash FixedString(64), previous_hash String
    ) ENGINE=MergeTree() ORDER BY (epoch,seq) SETTINGS fsync_after_insert=1,fsync_part_directory=1`,
    `CREATE TABLE IF NOT EXISTS ${qualified(database, 'delivery_intents')} (
      epoch UUID, seq UInt64, hash FixedString(64), previous_hash String
    ) ENGINE=MergeTree() ORDER BY (epoch,seq) SETTINGS fsync_after_insert=1,fsync_part_directory=1`,
    `CREATE TABLE IF NOT EXISTS ${qualified(database, 'published_watermarks')} (
      epoch UUID, seq UInt64, hash FixedString(64), baseline UInt8
    ) ENGINE=MergeTree() ORDER BY (epoch,seq) SETTINGS fsync_after_insert=1,fsync_part_directory=1`,
  ]
}

export const INTEGER_COLUMNS = new Set(['turn', 'step', 'usage_reported', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'active', 'success', 'pending', 'logins', 'interactions', 'successes', 'count'])
export const NULLABLE_COLUMNS = new Set(['user_id', 'accepted', 'terminal', 'terminal_digest', 'chinese_name', 'department_name', 'dept_l1_name', 'dept_name', 'profile_updated_at'])

export function extractColumn(column: string): string {
  identifier(column)
  if (INTEGER_COLUMNS.has(column)) return `toUInt64(replaceAll(JSONExtractRaw(payload,'${column}'),'"','')) AS ${identifier(column)}`
  if (NULLABLE_COLUMNS.has(column)) return `JSONExtract(payload,'${column}','Nullable(String)') AS ${identifier(column)}`
  return `JSONExtractString(payload,'${column}') AS ${identifier(column)}`
}
