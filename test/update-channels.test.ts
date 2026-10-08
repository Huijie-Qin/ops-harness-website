import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parse } from 'yaml'
import { CatalogSchema, validateUpdateDecision, type UpdateChannel, type Release } from '@dsh-ops/release-contract'
import { createHandler } from '../server/app.js'
import { decideUpdate, rolloutBucket } from '../server/catalog.js'

const query = { installationId: 'fa77c08d-abdf-4c98-a5ad-0820a38e1e81', currentVersion: '0.1.0', platform: 'windows-x64' as const }
function release(version: string, changes: Partial<Release> = {}): Release {
  const artifact = { name: `Office Setup ${version}.exe`, size: 10, sha512: 'A'.repeat(86) + '==' }
  return { version, title: version, notes: ['测试更新'], publishedAt: '2026-01-01T00:00:00.000Z', enabled: true, rolloutPercentage: 100,
    targets: { 'windows-x64': { artifact, downloads: [artifact] } }, ...changes }
}
function catalog(releases: Release[]) { return CatalogSchema.parse({ schemaVersion: 1, releases }) }
function selected(releases: Release[], currentVersion: string, channel?: UpdateChannel) {
  const decision = decideUpdate(catalog(releases), { ...query, currentVersion, ...(channel ? { channel } : {}) }, 'https://example.com')
  return decision.updateAvailable ? decision.version : undefined
}

test('explicit channels filter candidates while absent channel always selects stable regardless of installed version', () => {
  const versions = ['0.2.0', '0.3.0-beta.1', '0.3.0-rc.1', '0.4.0-alpha.1', '0.5.0-dev.1', '0.6.0-betamax.1'].map(v => release(v))
  assert.equal(selected(versions, '0.1.0', 'stable'), '0.2.0')
  assert.equal(selected(versions, '0.1.0', 'beta'), '0.3.0-rc.1')
  assert.equal(selected(versions, '0.1.0'), '0.2.0')
  for (const current of ['0.1.0-beta.1', '0.1.0-rc.1', '0.1.0-alpha.1']) {
    assert.equal(selected(versions, current), '0.2.0')
    assert.equal(selected(versions, current, 'beta'), '0.3.0-rc.1')
  }
  assert.equal(selected(versions, '0.1.0-beta.1', 'stable'), '0.2.0')
  assert.equal(selected([release('0.3.0-beta.1'), release('0.3.0-rc.1'), release('0.3.0')], '0.2.0', 'beta'), '0.3.0')
})

test('turning beta off waits for a higher stable version without downgrading or building a multi-step plan', () => {
  const current = '0.3.0-beta.2'
  assert.equal(selected([release('0.2.9'), release('0.3.0-beta.3'), release('0.3.0-rc.1')], current, 'stable'), undefined)
  assert.equal(selected([release('0.2.9'), release('0.3.0')], current, 'stable'), '0.3.0')
  assert.equal(selected([release('0.2.9'), release('0.3.0-beta.3'), release('0.3.0-rc.1')], current), undefined)
  assert.equal(selected([release('0.2.9'), release('0.3.0')], current), '0.3.0')
  const staged = [release('0.2.0'), release('0.3.0-beta.1', { minimumVersion: '0.2.0' })]
  assert.equal(selected(staged, '0.1.0', 'beta'), '0.2.0')
  assert.equal(selected(staged, '0.2.0', 'beta'), '0.3.0-beta.1')
  assert.equal(selected([release('0.4.0', { minimumVersion: '0.3.0' })], '0.3.0-rc.1', 'beta'), undefined)
})

test('channel filtering retains platform, rollout, minimum version, time and enablement guards', () => {
  for (const changes of [{ enabled: false }, { rolloutPercentage: 0 }, { minimumVersion: '0.1.1' },
    { publishedAt: '2100-01-01T00:00:00.000Z' }, { targets: {} }] as Partial<Release>[]) {
    assert.equal(selected([release('0.2.0'), release('0.3.0-beta.1', changes)], '0.1.0', 'beta'), '0.2.0')
  }
  const version = '0.3.0-beta.1', bucket = rolloutBucket(query.installationId, version, query.platform)
  assert.equal(selected([release(version, { rolloutPercentage: bucket })], '0.1.0', 'beta'), undefined)
  assert.equal(selected([release(version, { rolloutPercentage: bucket + 0.001 })], '0.1.0', 'beta'), version)
  assert.equal(rolloutBucket(query.installationId.toUpperCase(), version, query.platform), bucket)
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-update-channels-'))
  const releaseDirectory = path.join(root, 'releases')
  await mkdir(releaseDirectory)
  await writeFile(path.join(releaseDirectory, 'catalog.json'), JSON.stringify(catalog([
    release('0.2.0'), release('0.3.0-beta.1'), release('0.3.0-rc.1'), release('0.4.0-alpha.1'), release('0.5.0-dev.1'),
  ])))
  const server = createServer()
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173,
    releaseDirectory, contentDirectory: path.join(root, 'content'), adminPasswordEnv: 'TEST_ADMIN_PASSWORD', configPath: 'test' }, { clientRoot: root }))
  return origin
}

test('HTTP accepts legacy and explicit channels, rejects duplicate/invalid parameters and retains strict response shape', async t => {
  const origin = await fixture(t)
  for (const [extra, currentVersion, expected] of [
    ['', '0.1.0', '0.2.0'], ['', '0.1.0-beta.1', '0.2.0'], ['', '0.1.0-rc.1', '0.2.0'], ['', '0.1.0-alpha.1', '0.2.0'],
    ['&channel=stable', '0.1.0-beta.1', '0.2.0'], ['&channel=beta', '0.1.0', '0.3.0-rc.1'],
  ] as const) {
    const response = await fetch(`${origin}/api/releases/check?${new URLSearchParams({ ...query, currentVersion })}${extra}`)
    assert.equal(response.status, 200)
    const raw = await response.json()
    const channel = extra === '&channel=beta' ? 'beta' : extra === '&channel=stable' ? 'stable' : undefined
    const decision = validateUpdateDecision(raw, origin, currentVersion, query.platform, channel)
    assert.ok(decision.updateAvailable)
    assert.equal(decision.version, expected)
    assert.deepEqual(Object.keys(raw).sort(), ['schemaVersion', 'updateAvailable', 'version', 'platform', 'feedUrl', 'releaseNotesUrl', 'artifact'].sort())
  }
  for (const suffix of ['&channel=', '&channel=alpha', '&channel=Beta', '&extra=1', '&channel=beta&channel=stable', '&platform=macos-arm64']) {
    const response = await fetch(`${origin}/api/releases/check?${new URLSearchParams(query)}${suffix}`)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'INVALID_UPDATE_QUERY' })
  }
})

test('public releases and fixed-version metadata remain accessible for previews outside the selected update channel', async t => {
  const origin = await fixture(t)
  const response = await fetch(`${origin}/api/releases`)
  const data = await response.json()
  assert.deepEqual(data.releases.map((r: { version: string }) => r.version), ['0.5.0-dev.1', '0.4.0-alpha.1', '0.3.0-rc.1', '0.3.0-beta.1', '0.2.0'])
  const feed = await fetch(`${origin}/updates/archive/0.3.0-beta.1/windows-x64/latest.yml`)
  assert.equal(feed.status, 200)
  assert.equal(parse(await feed.text()).version, '0.3.0-beta.1')
})
