import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseTrackingTimeout, trackingAnalyticsConfig } from '../scripts/tracking/resources.js'
import { AnalyticsConfigSchema } from '../server/tracking/config.js'
import { ClickHouseBackend, ClickHouseHttpClient, initializeClickHouse } from '../server/tracking/clickhouse.js'
import { rowKey } from '../server/tracking/canonical.js'

test('offline timeout has a bounded five-minute default and does not mutate website settings', () => {
  assert.equal(parseTrackingTimeout(undefined), 300000)
  assert.equal(parseTrackingTimeout('45000'), 45000)
  for (const value of ['0', '999', '300001', 'Infinity', 'invalid', '1000.5']) assert.throws(() => parseTrackingTimeout(value), /TRACKING_TIMEOUT_MUST_BE_1000_TO_300000_MS/)
  const online = AnalyticsConfigSchema.parse({}), original = structuredClone(online)
  const offline = trackingAnalyticsConfig(online, parseTrackingTimeout(undefined))
  assert.equal(offline.clickhouse.requestTimeoutMs, 300000)
  assert.equal(offline.queryTimeoutMs, 300000)
  assert.deepEqual(online, original)
  assert.equal(online.clickhouse.requestTimeoutMs, 30000)
  assert.equal(online.queryTimeoutMs, 60000)
  assert.equal(offline.writeTimeoutMs, online.writeTimeoutMs)
})

test('offline request budget reaches DDL, startup, reads, prior versions, INSERTs and recovery', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-resources-'))
  const variable = 'CH_RESOURCE_TEST_PASSWORD'; process.env[variable] = 'fixture-only'
  const config = AnalyticsConfigSchema.parse({ clickhouse: { writerPasswordEnv: variable, readerPasswordEnv: variable } })
  const nativeTimeout = AbortSignal.timeout, budgets: number[] = [], requests: string[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { budgets.push(milliseconds); return nativeTimeout(milliseconds) })
  const state = { epoch: 'a0623ae2-5093-4bb2-8aef-bc85e6617ab7', startSeq: 1, excluded: [], ttlGraceSeconds: 86400 }
  let interrupt = true
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const sql = String(options.body); requests.push(sql)
    if (sql.includes('SELECT DISTINCT payload')) return new Response(JSON.stringify({ payload: JSON.stringify(state) }) + '\n')
    if (sql.includes('SELECT max(seq)')) return new Response('{"seq":"0"}\n')
    if (sql.startsWith('INSERT') && sql.includes('`event_dedup_versions`') && interrupt) {
      interrupt = false; throw new Error('fixture-only', { cause: { code: 'ECONNRESET' } })
    }
    return new Response('')
  })
  try {
    for (const timeout of [300000, 45000]) {
      budgets.length = 0; requests.length = 0; interrupt = true
      const offline = trackingAnalyticsConfig(config, timeout), client = new ClickHouseHttpClient(offline.clickhouse)
      const backend = new ClickHouseBackend(root, offline)
      try {
        await initializeClickHouse(client)
        await backend.open()
        await backend.rows('users', { keys: ['["user"]'] })
        const row = { tenant: 't', id: 'event', digest: 'fixture', received_at: new Date().toISOString() }
        await assert.rejects(backend.commit([{ table: 'event_dedup', key: rowKey('event_dedup', row), row }]), /ANALYTICS_CONNECTION_RESET/)
        await backend.recover()
        assert.ok(requests.some(sql => sql.startsWith('CREATE')))
        assert.ok(requests.some(sql => sql.startsWith('SELECT payload')))
        assert.ok(requests.some(sql => sql.includes('argMax(payload,commit_seq)')))
        assert.equal(requests.filter(sql => sql.startsWith('INSERT') && sql.includes('`tracking_commits`')).length, 2)
        assert.equal(requests.filter(sql => sql.startsWith('INSERT') && sql.includes('`event_dedup_versions`')).length, 2)
        assert.ok(requests.some(sql => sql.startsWith('INSERT') && sql.includes('`published_watermarks`')))
        assert.ok(budgets.length > 20 && budgets.every(value => value > timeout - 1000 && value <= timeout))
      } finally { backend.close(); client.close() }
    }
  } finally { delete process.env[variable]; await rm(root, { recursive: true, force: true }) }
})

test('the package tracking command runs with a 16 GiB heap and reports the effective offline budgets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-cli-resources-'))
  try {
    const config = path.join(root, 'website.json'), variable = 'CH_UNSET_RESOURCE_FIXTURE_PASSWORD'
    await writeFile(config, JSON.stringify({ schemaVersion: 1, websiteUrl: 'http://127.0.0.1:4173', host: '127.0.0.1', port: 4173, releaseDirectory: './releases', contentDirectory: './content', analyticsDirectory: './analytics', adminPasswordEnv: 'WEBSITE_RESOURCE_FIXTURE_PASSWORD', analytics: { clickhouse: { adminPasswordEnv: variable } } }))
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const args: string[] = pkg.scripts.tracking.split(' ').slice(1)
    const env = { ...process.env }; delete env[variable]; delete env.NODE_OPTIONS
    for (const [extra, timeout] of [[[], 300000], [['--timeout-ms', '150000'], 150000]] as const) {
      const result = spawnSync(process.execPath, [...args, 'init', '--config', config, ...extra], { env, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /CLICKHOUSE_PASSWORD_NOT_CONFIGURED/)
      const start = JSON.parse(result.stdout.trim())
      assert.equal(start.step, 'starting')
      assert.ok(start.heapLimitMiB >= 16384)
      assert.equal(start.requestTimeoutMs, timeout)
      assert.equal(start.queryTimeoutMs, timeout)
    }
    const invalid = spawnSync(process.execPath, [...args, 'init', '--config', 'missing-config.json', '--timeout-ms', '0'], { env, encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stdout, '')
    assert.match(invalid.stderr, /TRACKING_TIMEOUT_MUST_BE_1000_TO_300000_MS/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
