import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { trackingCommandFailure } from '../scripts/tracking/errors.js'
import { ClickHouseHttpError } from '../server/tracking/clickhouse-errors.js'

test('init identifies configuration failures before connecting, without exposing values', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-cli-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'website.json'), missing = path.join(root, 'missing.json')
  const secret = 'private-fixture-secret'
  const valid = {
    schemaVersion: 1, websiteUrl: 'http://127.0.0.1:4173', host: '127.0.0.1', port: 4173,
    releaseDirectory: './releases', contentDirectory: './content', analyticsDirectory: './analytics',
    adminPasswordEnv: 'WEBSITE_CLI_TEST_PASSWORD',
  }
  const env = { ...process.env, DSH_OPS_WEBSITE_CONFIG: missing }
  delete env.NODE_OPTIONS; delete env.DSH_OPS_RELEASE_CONFIG; delete env.DSH_OPS_WEBSITE_CONTENT_CONFIG
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/tracking/cli.ts', 'init', ...args], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes(secret), false)
    return JSON.parse(result.stderr.trim())
  }
  assert.deepEqual(run([]), { error: 'WEBSITE_CONFIG_ENOENT', stage: 'config', configPath: missing })
  assert.deepEqual(run(['--config', root]), { error: 'WEBSITE_CONFIG_EISDIR', stage: 'config', configPath: root })
  await writeFile(config, `{"password":"${secret}",`)
  assert.deepEqual(run(['--config', config]), { error: 'WEBSITE_CONFIG_INVALID_JSON', stage: 'config', configPath: config })
  await writeFile(config, JSON.stringify({ ...valid, analytics: { writeBackend: 'sqlite', query: { fallbackToSqlite: true }, clickhouse: { url: `http://user:${secret}@localhost:8123`, requestTimeoutMs: '300000', password: secret } } }))
  const invalid = run(['--config', config])
  assert.equal(invalid.error, 'WEBSITE_CONFIG_INVALID'); assert.equal(invalid.stage, 'config'); assert.equal(invalid.configPath, config)
  assert.ok(invalid.issues.some((issue: { field: string }) => issue.field === 'analytics.clickhouse.url'))
  assert.ok(invalid.issues.some((issue: { field: string; code: string }) => issue.field === 'analytics.clickhouse.requestTimeoutMs' && issue.code === 'invalid_type'))
  assert.ok(invalid.issues.some((issue: { field: string; keys?: string[] }) => issue.field === 'analytics' && issue.keys?.includes('writeBackend')))
  assert.ok(invalid.issues.some((issue: { field: string; keys?: string[] }) => issue.field === 'analytics.clickhouse' && issue.keys?.includes('password')))
  await assert.rejects(access(path.join(root, 'analytics')), { code: 'ENOENT' })
  assert.deepEqual(run(['--unknown', secret]), { error: 'ERR_PARSE_ARGS_UNKNOWN_OPTION', stage: 'arguments' })
  await writeFile(config, JSON.stringify({ ...valid, port: 0 }))
  env.DSH_OPS_WEBSITE_CONFIG = config
  assert.ok(run([]).issues.some((issue: { field: string }) => issue.field === 'port'))
  delete env.DSH_OPS_WEBSITE_CONFIG
  env.DSH_OPS_RELEASE_CONFIG = 'legacy.json'
  assert.equal(run([]).error, 'WEBSITE_CONFIG_LEGACY_ENV')
  assert.equal(run(['--config', missing]).error, 'WEBSITE_CONFIG_ENOENT')
})

test('CLI diagnostics retain HTTP metadata and filesystem codes without raw errors or arbitrary diagnostics', () => {
  const context = { stage: 'config' as const, configPath: '/isolated/website.json' }
  const denied = Object.assign(new Error('private-fixture-secret'), { code: 'EACCES', path: 'private-fixture-secret' })
  assert.deepEqual(trackingCommandFailure(denied, context), { error: 'WEBSITE_CONFIG_EACCES', ...context })
  const unknown = Object.assign(new Error('private-fixture-secret'), { diagnostics: { password: 'private-fixture-secret' } })
  assert.deepEqual(trackingCommandFailure(unknown, context), { error: 'WEBSITE_CONFIG_LOAD_FAILED', ...context })
  const http = new ClickHouseHttpError(403, '497', { operation: 'command', phase: 'headers', queryId: 'fixture-query-id', requestElapsedMs: 10, attempt: 1 })
  assert.deepEqual(trackingCommandFailure(http, { stage: 'init' }), { error: 'CLICKHOUSE_HTTP_403', stage: 'init', diagnostics: http.diagnostics })
})
