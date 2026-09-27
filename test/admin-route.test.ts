import test from 'node:test'
import assert from 'node:assert/strict'
import { adminHash, parseAdminHash } from '../client/admin-route.js'
import { analyticsQuery, readAnalyticsState } from '../client/analytics/state.js'

test('admin fragments round-trip sections, document selection and analytics context', () => {
  for (const hash of ['#guides/installation','#documents','#releases','#media','#knowledge','#experts','#analytics/conversations?from=2026-08-23&to=2026-09-20&environment=all&page=3&limit=25']) {
    assert.equal(adminHash(parseAdminHash(hash)),hash)
  }
  const source=readAnalyticsState('from=2026-08-23&to=2026-09-20&environment=development&page=3&limit=25&search=%E6%9E%97&sort=totalTokens&direction=asc&user=12345678-1234-4234-9234-123456789abc')
  assert.deepEqual(readAnalyticsState(analyticsQuery(source)),source)
  assert.equal(source.search,'林')
  assert.equal(source.page,3)
})

test('invalid fragments and untrusted query values fall back to bounded valid navigation', () => {
  assert.equal(adminHash(parseAdminHash('#unknown/path')),'#guides')
  assert.equal(adminHash(parseAdminHash('#analytics/unknown')),'#analytics/overview')
  assert.equal(adminHash(parseAdminHash('#guides/../../outside')),'#guides')
  assert.equal(adminHash(parseAdminHash('#analytics/users?password=secret&environment=test')),'#analytics/users?environment=test')
  const state=readAnalyticsState('from=2026-02-31&to=wrong&environment=evil&page=999999999&limit=100&sort=drop+table+users&user=not-a-user&appVersion=../bad')
  assert.equal(state.environment,'');assert.equal(state.user,'');assert.equal(state.sort,'');assert.equal(state.appVersion,'')
  assert.equal(state.page,1001)
  assert.ok(Number.isFinite(Date.parse(state.from)))
})
