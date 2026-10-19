import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ClickHouseHttpClient } from '../server/tracking/clickhouse.js'
import { ClickHouseHttpError, ClickHouseTransportError, transportFailure, type RequestContext } from '../server/tracking/clickhouse-errors.js'

test('CH HTTP distinguishes header/body timeouts from network failures and keeps diagnostics private', async t => {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = createServer((req, res) => {
    req.resume()
    const mode = new URL(req.url!, 'http://localhost').searchParams.get('param_mode')
    if (mode === 'network') { req.socket.destroy(); return }
    if (mode === 'failure') { res.writeHead(500, { 'X-ClickHouse-Exception-Code': '241' }); res.end('private SQL and row data'); return }
    if (mode === 'body') { res.writeHead(200); res.write('{"connected":1}\n') }
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!res.destroyed) res.end(mode === 'body' ? '' : '{"connected":1}\n')
    }, mode === 'headers' || mode === 'body' ? 1000 : 0)
    timers.add(timer)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const variable = 'CH_HTTP_FIXTURE_PASSWORD'
  process.env[variable] = 'fixture-password'
  const client = new ClickHouseHttpClient({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, database: 'fixture', writerUser: 'fixture', writerPasswordEnv: variable, readerUser: 'fixture', readerPasswordEnv: variable, requestTimeoutMs: 5000 })
  t.after(async () => {
    client.close(); delete process.env[variable]
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  })
  assert.deepEqual(await client.query('SELECT 1'), [{ connected: 1 }])
  await assert.rejects(client.query('SELECT 1', { mode: 'headers' }, { timeoutMs: 100 }), /^Error: ANALYTICS_QUERY_TIMEOUT$/)
  await assert.rejects(client.query('SELECT 1', { mode: 'body' }, { timeoutMs: 100 }), /^Error: ANALYTICS_QUERY_TIMEOUT$/)
  await assert.rejects(client.command('SELECT 1', { mode: 'body' }, { timeoutMs: 100 }), /^Error: ANALYTICS_QUERY_TIMEOUT$/)
  await assert.rejects(client.query('SELECT 1', {}, { deadline: Date.now() - 1 }), /^Error: ANALYTICS_QUERY_TIMEOUT$/)
  await assert.rejects(client.query('SELECT 1', { mode: 'network' }), error => error instanceof ClickHouseTransportError && ['ANALYTICS_SOCKET_CLOSED', 'ANALYTICS_CONNECTION_RESET'].includes(error.message) && error.diagnostics.phase === 'headers')
  await assert.rejects(client.query('SELECT 1', { mode: 'failure' }), error => {
    assert.ok(error instanceof ClickHouseHttpError)
    assert.equal(error.message, 'CLICKHOUSE_HTTP_500'); assert.equal(error.diagnostics.clickhouseCode, 241)
    assert.match(error.diagnostics.queryId, /^[0-9a-f-]{36}$/)
    assert.equal(JSON.stringify(error).includes('private'), false)
    return true
  })
  assert.deepEqual(await client.query('SELECT 1'), [{ connected: 1 }])
})

test('transport diagnostics allowlist nested error codes without retaining private messages', () => {
  const context: RequestContext = { phase: 'body', operation: 'api_result', queryId: 'fixture-query', requestElapsedMs: 12, attempt: 1 }
  for (const code of [null, 'private data', '241 SQL', '-1', '1.5', '999999999999999999999']) {
    const error = new ClickHouseHttpError(500, code, context)
    assert.equal(error.diagnostics.clickhouseCode, undefined)
    assert.equal(JSON.stringify(error).includes('private'), false)
  }
  for (const [network, code] of [['ECONNRESET', 'ANALYTICS_CONNECTION_RESET'], ['UND_ERR_SOCKET', 'ANALYTICS_SOCKET_CLOSED'], ['ECONNREFUSED', 'ANALYTICS_CONNECTION_REFUSED'], ['UND_ERR_CONNECT_TIMEOUT', 'ANALYTICS_CONNECT_TIMEOUT'], ['ENOTFOUND', 'ANALYTICS_DNS_FAILED'], ['CERT_HAS_EXPIRED', 'ANALYTICS_TLS_FAILED']]) {
    const error = transportFailure(new Error('private SQL and credentials', { cause: { code: network, message: 'private SQL and credentials' } }), new AbortController().signal, context)
    assert.equal(error.message, code)
    assert.equal(error.diagnostics.transportCode, network)
    assert.equal(error.diagnostics.phase, 'body')
    assert.equal(error.cause, undefined)
    assert.equal(JSON.stringify(error).includes('private'), false)
  }
  const unknown = transportFailure({ code: 'PRIVATE_CREDENTIAL', message: 'private' }, new AbortController().signal, context)
  assert.equal(unknown.message, 'ANALYTICS_TRANSPORT_ERROR'); assert.equal(unknown.diagnostics.transportCode, 'UNKNOWN')
  const truncated = transportFailure({ name: 'HTTPParserError', message: 'Response does not match the HTTP/1.1 protocol (Invalid EOF state)' }, new AbortController().signal, context)
  assert.equal(truncated.message, 'ANALYTICS_RESPONSE_TRUNCATED'); assert.equal(truncated.retryableRead, true)
})

test('only opted-in buffered reads retry a dropped connection once, with a fresh socket and no duplicate rows', async t => {
  const counts = new Map<string, number>(), requests: { mode: string; queryId: string | null; connection: string | undefined }[] = [], logs: string[] = []
  t.mock.method(console, 'warn', (line: string) => logs.push(line))
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const url = new URL(req.url!, 'http://localhost'), mode = body.startsWith('INSERT') ? 'insert' : url.searchParams.get('param_mode') ?? 'normal'
    const count = (counts.get(mode) ?? 0) + 1; counts.set(mode, count)
    requests.push({ mode, queryId: url.searchParams.get('query_id'), connection: req.headers.connection })
    if (mode === 'insert' || mode === 'always' || (mode === 'flaky' && count === 1)) { req.socket.destroy(); return }
    if ((mode === 'body_retry' || mode === 'body_stream') && count === 1) {
      res.write('{"ok":1}\n')
      const timer = setTimeout(() => { timers.delete(timer); res.destroy() }, 20)
      timers.add(timer); return
    }
    res.end('{"ok":1}\n{"ok":2}\n')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const variable = 'CH_HTTP_RETRY_FIXTURE_PASSWORD'; process.env[variable] = 'private-fixture-password'
  const client = new ClickHouseHttpClient({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, database: 'fixture', writerUser: 'fixture', writerPasswordEnv: variable, readerUser: 'fixture', readerPasswordEnv: variable, requestTimeoutMs: 5000 })
  t.after(async () => {
    client.close(); delete process.env[variable]
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  })
  assert.deepEqual(await client.query('SELECT private_column', { mode: 'flaky' }, { retryOnConnectionLoss: true, operation: 'api_result' }), [{ ok: 1 }, { ok: 2 }])
  assert.equal(counts.get('flaky'), 2)
  const flaky = requests.filter(request => request.mode === 'flaky')
  assert.ok(flaky.every(request => request.queryId))
  assert.equal(flaky[1]!.connection, 'close')
  assert.notEqual(flaky[0]!.queryId, flaky[1]!.queryId)
  assert.deepEqual(await client.query('SELECT private_column', { mode: 'body_retry' }, { retryOnConnectionLoss: true }), [{ ok: 1 }, { ok: 2 }])
  await assert.rejects(client.query('SELECT private_column', { mode: 'always' }, { retryOnConnectionLoss: true }), error => error instanceof ClickHouseTransportError && error.diagnostics.attempt === 2)
  assert.equal(counts.get('always'), 2)
  await assert.rejects(client.query('SELECT private_column', { mode: 'always' }), ClickHouseTransportError)
  assert.equal(counts.get('always'), 3)
  await assert.rejects(client.insert('fixture', [{ private_column: 'private-fixture-password' }], { retryOnConnectionLoss: true }), ClickHouseTransportError)
  assert.equal(counts.get('insert'), 1)
  const stream = client.iterate('SELECT private_column', { mode: 'body_stream' }, { retryOnConnectionLoss: true })
  assert.deepEqual((await stream.next()).value, { ok: 1 })
  await assert.rejects(stream.next(), error => error instanceof ClickHouseTransportError && error.diagnostics.phase === 'body')
  assert.equal(counts.get('body_stream'), 1)
  assert.ok(logs.length >= 3 && logs.every(line => !line.includes('private')))
  client.close()
  await assert.rejects(client.query('SELECT 1', {}, { retryOnConnectionLoss: true }), /^Error: ANALYTICS_CANCELLED$/)
})

test('a read retry shares its original deadline rather than receiving a new timeout budget', async t => {
  const variable = 'CH_HTTP_DEADLINE_FIXTURE_PASSWORD'; process.env[variable] = 'fixture-only'
  const client = new ClickHouseHttpClient({ url: 'http://127.0.0.1:8123', database: 'fixture', writerUser: 'fixture', writerPasswordEnv: variable, readerUser: 'fixture', readerPasswordEnv: variable, requestTimeoutMs: 100 })
  t.after(() => { client.close(); delete process.env[variable] })
  let clock = 1000, attempts = 0
  const budgets: number[] = [], nativeTimeout = AbortSignal.timeout
  t.mock.method(Date, 'now', () => clock)
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { budgets.push(milliseconds); return nativeTimeout(milliseconds) })
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    if (++attempts === 1) { clock += 60; throw new Error('fixture-only', { cause: { code: 'ECONNRESET' } }) }
    return new Response('{"ok":1}\n')
  })
  assert.deepEqual(await client.query('SELECT 1', {}, { retryOnConnectionLoss: true }), [{ ok: 1 }])
  assert.deepEqual(budgets, [100, 40])
})
