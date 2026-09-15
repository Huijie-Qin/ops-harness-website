import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stringify } from 'yaml'
import { parseReleaseManifest } from '../server/release-manifest.js'
import { maxManifestBytes } from '../shared/admin.js'

const sha512 = createHash('sha512').update('installer').digest('base64')
const installer = { url: 'WiseOperation Assistant Setup 0.2.0.exe', size: 12345, sha512 }
const metadata = { version: '0.2.0', files: [installer], path: installer.url, sha512, releaseDate: '2026-09-15T00:00:00.000Z' }
const parse = (data: unknown) => parseReleaseManifest({ name: 'latest.yml', content: stringify(data) })
test('builder metadata derives version, platform, raw/encoded basenames and the checksum baseline', () => {
  const result = parse(metadata)
  assert.equal(result.version, '0.2.0'); assert.equal(result.platform, 'windows-x64')
  assert.deepEqual(result.files, [{ name: installer.url, size: installer.size, sha512 }])
  assert.equal(parse({ ...metadata, files: [{ ...installer, url: encodeURIComponent(installer.url) }] }).files[0]!.name, installer.url)
  assert.equal(parse({ version: '0.2.0-beta.1', files: [{ ...installer, url: 'Office-0.2.0-beta.1-x64.exe' }] }).version, '0.2.0-beta.1')
  const zip = { ...installer, url: 'WiseOperation Assistant-0.2.0-arm64.zip' }
  const dmg = { ...installer, url: 'WiseOperation Assistant-0.2.0-arm64.dmg' }
  assert.equal(parse({ version: '0.2.0', files: [zip, dmg], path: zip.url, sha512 }).platform, 'macos-arm64')
  assert.equal(parseReleaseManifest({ name: 'latest-mac.yml', content: '\uFEFF' + stringify({ version: '0.2.0', files: [zip, dmg] }) }).files.length, 2)
})
test('invalid or ambiguous metadata cannot define a release', () => {
  const bad = [
    {}, { ...metadata, version: 'latest' }, { ...metadata, version: '0.3.0' }, { ...metadata, files: [] },
    { ...metadata, files: [installer, installer] }, { ...metadata, files: Array(9).fill(installer) },
    { ...metadata, files: [{ ...installer, sha512: 'invalid' }] }, { ...metadata, files: [{ ...installer, size: 0 }] },
    { ...metadata, files: [{ ...installer, size: null }] }, { ...metadata, files: [{ ...installer, size: '12345' }] },
    { ...metadata, files: [{ ...installer, size: 1.5 }] }, { ...metadata, files: [{ url: installer.url }] },
    { ...metadata, files: [{ ...installer, size: 21 * 1024 ** 3 }] },
    { ...metadata, path: 'wrong.exe' }, { ...metadata, sha512: createHash('sha512').update('different').digest('base64') },
    { version: metadata.version, files: [installer], path: installer.url },
    { ...metadata, packages: { x64: { path: 'https://example.com/payload.7z' } } },
    { version: metadata.version, files: [{ ...installer, url: 'Office-0.2.0-arm64.exe' }] },
    { version: metadata.version, files: [{ ...installer, url: 'Office-0.2.0-ia32.exe' }] },
    { version: metadata.version, files: [{ ...installer, url: 'Office-0.2.0-x64.zip' }] },
    { version: metadata.version, files: [installer, { ...installer, url: 'Office-0.2.0-arm64.zip' }] },
    { version: metadata.version, files: [installer, { ...installer, url: 'Other-0.2.0-x64.exe' }] },
  ]
  for (const input of bad) assert.throws(() => parse(input), { code: 'INVALID_MANIFEST' }, JSON.stringify(input))
  for (const url of ['../Office-0.2.0.exe', '%2e%2e%2fOffice-0.2.0.exe', 'dir/Office-0.2.0.exe', 'C:\\Office-0.2.0.exe', 'https://example.com/Office-0.2.0.exe', 'Office-0.2.0.exe?download=1', '%zz.exe']) {
    assert.throws(() => parse({ version: metadata.version, files: [{ ...installer, url }] }), { code: 'INVALID_MANIFEST' })
  }
})
test('YAML parsing rejects duplicate keys, aliases, tags, excessive structure and oversized input', () => {
  for (const content of [
    stringify(metadata) + '\n---\nversion: 0.2.0',
    'a: &a [1, 2]\nb: *a', 'a: !!js/function "function() {}"', 'a: !!str data',
    'a: ' + '['.repeat(30) + '0' + ']'.repeat(30), 'a: [' + Array(600).fill('0').join(',') + ']',
    '#'.repeat(maxManifestBytes + 1), stringify(metadata) + 'notes: "' + '字'.repeat(maxManifestBytes / 2) + '"',
  ]) assert.throws(() => parseReleaseManifest({ name: 'latest.yml', content }), { code: 'INVALID_MANIFEST' })
  assert.throws(() => parseReleaseManifest({ name: 'latest.yml', content: stringify(metadata) + 'version: 0.2.1\n' }), { code: 'MANIFEST_DUPLICATE_KEY' })
  assert.throws(() => parseReleaseManifest(undefined), { code: 'MANIFEST_REQUIRED' })
  assert.throws(() => parseReleaseManifest({ name: '../latest.yml', content: stringify(metadata) }), { code: 'INVALID_MANIFEST' })
  assert.throws(() => parseReleaseManifest({ name: 'builder-debug.yml', content: 'publish:\n  provider: generic' }), { code: 'INVALID_MANIFEST' })
})

test('the reported 0.1.3 descriptor imports without size after fixing indentation; duplicates still fail explicitly', () => {
  const content = readFileSync(new URL('./fixtures/releases/latest-0.1.3.yml', import.meta.url), 'utf8')
  const result = parseReleaseManifest({ name: 'latest.yml', content })
  assert.equal(result.version, '0.1.3'); assert.equal(result.platform, 'windows-x64')
  assert.equal(result.files[0]!.name, 'WiseOperation Assistant Setup 0.1.3.exe')
  assert.equal(result.files[0]!.sha512, '08g86WS/4zUjTg5eT29GtCQIT4uIg+4jJ0nN+eh0io/zkmkO1ZVlUA21E+cKqilW89bDaZJrHzXMqj0IZn0xbA==')
  assert.equal(Object.hasOwn(result.files[0]!, 'size'), false)
  // Reproduce the reported indentation exactly: top-level legacy fields become file fields.
  const malformed = content.replace(/^(path|sha512|releaseDate):/gm, '  $1:')
  assert.throws(() => parseReleaseManifest({ name: 'latest.yml', content: malformed }), { code: 'MANIFEST_DUPLICATE_KEY' })
  const zip = { url: 'Office-0.2.0-arm64.zip', sha512 }, dmg = { url: 'Office-0.2.0-arm64.dmg', sha512, size: 12345 }
  const mixed = parse({ version: '0.2.0', files: [zip, dmg] })
  assert.equal(mixed.platform, 'macos-arm64'); assert.equal(mixed.files[0]!.size, undefined); assert.equal(mixed.files[1]!.size, 12345)
})
