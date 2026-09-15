import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parse } from 'yaml'
import { CatalogSchema, validateUpdateDecision, type ReleaseCatalog } from '@dsh-ops/release-contract'
import { decideUpdate, readCatalog, rolloutBucket } from '../server/catalog.js'
import { createHandler } from '../server/app.js'
import { publishRelease } from '../server/publish.js'
import { loadConfig } from '../server/config.js'

const installationId = 'fa77c08d-abdf-4c98-a5ad-0820a38e1e81'
const artifact = { name: 'WiseOperation Assistant Setup 0.2.0.exe', size: 10, sha512: 'A'.repeat(86) + '==' }
const base = { version: '0.2.0', publishedAt: '2026-01-01T00:00:00.000Z', title: '新版本', notes: ['改进工作体验'], enabled: true, rolloutPercentage: 100, targets: { 'windows-x64': { artifact, downloads: [artifact] } } }
const query = { installationId, currentVersion: '0.1.0', platform: 'windows-x64' as const }
test('policy filters version, platform, stable/preview, release time and enablement', () => {
  for (const changes of [{ enabled: false }, { rolloutPercentage: 0 }, { minimumVersion: '0.1.1' }, { version: '0.0.9' }, { version: '0.3.0-rc.1' }, { publishedAt: '2100-01-01T00:00:00.000Z' }, { targets: {} }]) {
    const catalog = CatalogSchema.parse({ schemaVersion: 1, releases: [{ ...base, ...changes }] })
    assert.equal(decideUpdate(catalog, query, 'https://example.com').updateAvailable, false)
  }
  const catalog = CatalogSchema.parse({ schemaVersion: 1, releases: [base] })
  assert.equal(decideUpdate(catalog, query, 'https://example.com').updateAvailable, true)
  const bucket = rolloutBucket(installationId, '0.2.0', 'windows-x64')
  assert.equal(bucket, rolloutBucket(installationId.toUpperCase(), '0.2.0', 'windows-x64'))
  catalog.releases[0]!.rolloutPercentage = bucket
  assert.equal(decideUpdate(catalog, query, 'https://example.com').updateAvailable, false)
  catalog.releases[0]!.rolloutPercentage = bucket + 0.001
  assert.equal(decideUpdate(catalog, query, 'https://example.com').updateAvailable, true)
})

let root: string
let origin: string
let server: ReturnType<typeof createServer>
const bytes = Buffer.from('actual fixture installer bytes')
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ops-website-release-test-'))
  const input = path.join(root, 'input')
  await mkdir(input)
  await writeFile(path.join(input, artifact.name), bytes)
  await publishRelease({ root: path.join(root, 'releases'), input, version: '0.2.0', platform: 'windows-x64', notes: { title: base.title, notes: base.notes } })
  server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173, releaseDirectory: path.join(root, 'releases'), contentDirectory: path.join(root, 'content'), adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD', configPath: 'test' }, { clientRoot: root }))
})
after(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})
test('publication computes hashes, writes a complete catalog, rejects republishing and leaves no staging', async () => {
  const catalog = await readCatalog(path.join(root, 'releases'))
  assert.equal(catalog.releases[0]!.targets['windows-x64']!.artifact.size, bytes.length)
  await assert.rejects(publishRelease({ root: path.join(root, 'releases'), input: path.join(root, 'input'), version: '0.2.0', platform: 'windows-x64', notes: { title: base.title, notes: base.notes } }), /already published/)
  assert.equal((await readdir(path.join(root, 'releases'))).some(v => v.startsWith('.')), false)
})
test('check endpoint and generic metadata agree; downloads support HEAD, Range and unknown-file denial', async () => {
  const response = await fetch(`${origin}/api/releases/check?${new URLSearchParams(query)}`)
  assert.equal(response.status, 200)
  const decision = validateUpdateDecision(await response.json(), origin, '0.1.0', 'windows-x64')
  assert.ok(decision.updateAvailable)
  const manifest = parse(await (await fetch(`${decision.feedUrl}latest.yml`)).text())
  assert.equal(manifest.version, decision.version)
  assert.equal(manifest.files[0].sha512, decision.artifact.sha512)
  const file = `${decision.feedUrl}${encodeURIComponent(decision.artifact.name)}`
  const head = await fetch(file, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(bytes.length))
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const partial = await fetch(file, { headers: { Range: 'bytes=2-8' } })
  assert.equal(partial.status, 206)
  assert.equal(await partial.text(), bytes.subarray(2, 9).toString())
  assert.equal((await fetch(file, { headers: { Range: 'bytes=999-' } })).status, 416)
  assert.equal((await fetch(file, { headers: { Range: 'bytes=0-2,5-8' } })).status, 416)
  assert.equal((await fetch(`${decision.feedUrl}missing.exe`)).status, 404)
  assert.equal((await fetch(`${decision.feedUrl}%2e%2e%2fcatalog.json`)).status, 404)
  const actual = await fetch(file)
  assert.deepEqual(Buffer.from(await actual.arrayBuffer()), bytes)
})
test('HTTP rejects malformed queries/writes and never builds links from attacker Host', async () => {
  assert.equal((await fetch(`${origin}/api/releases/check?currentVersion=latest`)).status, 400)
  assert.equal((await fetch(`${origin}/api/releases/check?${new URLSearchParams(query)}&platform=macos-arm64`)).status, 400)
  assert.equal((await fetch(`${origin}/api/releases`, { method: 'POST' })).status, 405)
  const body = await (await fetch(`${origin}/api/releases`, { headers: { 'X-Forwarded-Host': 'evil.example' } })).json()
  assert.ok(body.releases[0].downloads[0].url.startsWith(origin))
})
test('configured internal HTTP origin serves release links, metadata and downloads', async t => {
  const websiteUrl = 'http://7.192.170.132:4173'
  const configPath = path.join(root, 'internal-http.json')
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, websiteUrl, host: '127.0.0.1', port: 4173, releaseDirectory: 'releases', contentDirectory: 'content', adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD' }))
  const internalServer = createServer(createHandler(await loadConfig(configPath), { clientRoot: root }))
  internalServer.listen(0, '127.0.0.1')
  await once(internalServer, 'listening')
  t.after(async () => { internalServer.closeAllConnections(); await new Promise<void>(resolve => internalServer.close(() => resolve())) })
  const transportOrigin = `http://127.0.0.1:${(internalServer.address() as { port: number }).port}`
  const list = await fetch(transportOrigin + '/api/releases', { headers: { Host: 'wrong.example', 'X-Forwarded-Host': 'wrong.example' } })
  assert.equal(list.status, 200)
  const download = (await list.json()).releases[0].downloads[0].url
  assert.equal(download, `${websiteUrl}/updates/archive/0.2.0/windows-x64/${encodeURIComponent(artifact.name)}`)
  assert.deepEqual(Buffer.from(await (await fetch(transportOrigin + new URL(download).pathname)).arrayBuffer()), bytes)
  const check = await fetch(`${transportOrigin}/api/releases/check?${new URLSearchParams(query)}`)
  assert.equal(check.status, 200)
  const decision = validateUpdateDecision(await check.json(), websiteUrl, query.currentVersion, query.platform)
  assert.ok(decision.updateAvailable)
  assert.equal(decision.feedUrl, `${websiteUrl}/updates/archive/0.2.0/windows-x64/`)
  assert.equal(decision.releaseNotesUrl, `${websiteUrl}/releases#v0.2.0`)
  const metadata = await fetch(transportOrigin + new URL(decision.feedUrl).pathname + 'latest.yml')
  assert.equal(metadata.status, 200)
  assert.equal(parse(await metadata.text()).files[0].sha512, decision.artifact.sha512)
})
test('product screenshots retain original JPEG bytes and MIME type in production', async () => {
  const directory = path.join(root, 'assets', 'product')
  await mkdir(directory, { recursive: true })
  for (const name of ['tools', 'skills', 'experts']) {
    const image = await readFile(new URL(`../public/assets/product/${name}.jpg`, import.meta.url))
    assert.deepEqual(image.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]))
    await writeFile(path.join(directory, `${name}.jpg`), image)
    const response = await fetch(`${origin}/assets/product/${name}.jpg`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
    const head = await fetch(`${origin}/assets/product/${name}.jpg`, { method: 'HEAD' })
    assert.equal(head.headers.get('content-length'), String(image.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  }
  assert.equal((await fetch(`${origin}/tools.jpg`)).status, 404)
  assert.equal((await fetch(`${origin}/assets/product/missing.jpg`)).status, 404)
})
test('invalid catalog fails closed and is preserved', async () => {
  const file = path.join(root, 'releases', 'catalog.json')
  const previous = await readFile(file, 'utf8')
  try {
    await writeFile(file, '{broken')
    assert.equal((await fetch(`${origin}/api/releases/check?${new URLSearchParams(query)}`)).status, 503)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await writeFile(file, previous) }
})

test('mixed platform artifacts stay separate and macOS policy points to the ARM64 ZIP', async () => {
  const input = path.join(root, 'mixed-input')
  await mkdir(input)
  const names = ['App Setup 0.3.0.exe', 'App-0.3.0-portable-x64.zip', 'App-0.3.0-arm64.zip', 'App-0.3.0-arm64.dmg']
  for (const name of names) await writeFile(path.join(input, name), bytes)
  const options = { root: path.join(root, 'releases'), input, version: '0.3.0', notes: { title: '跨平台发布', notes: ['两个平台共用版本说明'] } }
  const windows = await publishRelease({ ...options, platform: 'windows-x64' })
  assert.deepEqual(windows.targets['windows-x64']!.downloads.map(f => f.name).sort(), names.slice(0, 2).sort())
  await publishRelease({ ...options, platform: 'macos-arm64' })
  const response = await fetch(`${origin}/api/releases/check?${new URLSearchParams({ ...query, platform: 'macos-arm64' })}`)
  const decision = validateUpdateDecision(await response.json(), origin, query.currentVersion, 'macos-arm64')
  assert.ok(decision.updateAvailable)
  assert.equal(decision.artifact.name, 'App-0.3.0-arm64.zip')
  const metadata = parse(await (await fetch(`${decision.feedUrl}latest-mac.yml`)).text())
  assert.equal(metadata.files[0].sha512, decision.artifact.sha512)
  assert.equal(metadata.files[0].url, encodeURIComponent(decision.artifact.name))
  assert.equal((await fetch(`${decision.feedUrl}latest.yml`)).status, 404)
})
