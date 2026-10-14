import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { matchingArtifacts, publishRelease } from '../server/publish.js'
import { readCatalog } from '../server/catalog.js'
import { parseReleaseManifest } from '../server/release-manifest.js'

function names(version: string) {
  return [`WiseOperation Assistant Setup ${version}.exe`, `WiseOperation Assistant-${version}-portable-x64.zip`,
    `WiseOperation Assistant-${version}-arm64.zip`, `WiseOperation Assistant-${version}-arm64.dmg`,
    `WiseOperation Assistant-${version}-arm64.zip.blockmap`, `WiseOperation Assistant-${version}-arm64.dmg.blockmap`]
}
const versions = ['0.3.0', '0.3.0-beta.1', '0.3.0-beta.10', '0.3.0-rc.1']

test('artifact matching distinguishes complete stable/beta/rc versions while retaining actual builder names', () => {
  const mixed = versions.flatMap(names)
  for (const version of versions) {
    assert.deepEqual(matchingArtifacts(mixed, version, 'windows-x64'), names(version).slice(0, 2))
    assert.deepEqual(matchingArtifacts(mixed, version, 'macos-arm64'), names(version).slice(2))
  }
  assert.deepEqual(matchingArtifacts(['Office-0.3.0-x64.exe', 'Office_0.3.0_x64.zip', 'Office-0.3.0-arm64.exe', 'Office-0.3.0-ia32.exe'], '0.3.0', 'windows-x64'),
    ['Office-0.3.0-x64.exe', 'Office_0.3.0_x64.zip'])
  assert.deepEqual(matchingArtifacts(['Office-0.3.0-arm64.blockmap'], '0.3.0', 'macos-arm64'), ['Office-0.3.0-arm64.blockmap'])
  assert.deepEqual(matchingArtifacts(['Office-0.30.0-x64.exe', 'Office-0.3.0-beta.1-x64.exe', 'Office-0.3.0-x64.exe.bak'], '0.3.0', 'windows-x64'), [])
})

test('manifest parser accepts beta/rc for both platforms and refuses prefix-version mismatches', () => {
  const sha512 = createHash('sha512').update('installer').digest('base64')
  for (const version of versions) {
    for (const [file, manifest] of [[names(version)[0]!, 'latest.yml'], [names(version)[2]!, 'latest-mac.yml']] as const) {
      const result = parseReleaseManifest({ name: manifest, content: stringify({ version, files: [{ url: file, sha512, size: 9 }] }) })
      assert.equal(result.version, version)
    }
  }
  for (const [version, file] of [['0.3.0', names('0.3.0-beta.1')[0]!], ['0.3.0-beta.1', names('0.3.0-beta.10')[0]!]] as const) {
    assert.throws(() => parseReleaseManifest({ name: 'latest.yml', content: stringify({ version, files: [{ url: file, sha512 }] }) }), { code: 'INVALID_MANIFEST' })
  }
})

test('mixed release directories produce independent immutable beta/rc/stable archives with verified hashes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'website-release-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input'), releaseRoot = path.join(root, 'releases')
  await mkdir(input)
  const bytes = Buffer.from('versioned installer fixture'), sha512 = createHash('sha512').update(bytes).digest('base64')
  for (const file of versions.flatMap(names)) await writeFile(path.join(input, file), bytes)
  for (const version of versions) {
    const options = { root: releaseRoot, input, version, notes: { title: version, notes: ['版本隔离'] } }
    for (const platform of ['windows-x64', 'macos-arm64'] as const) {
      const result = await publishRelease({ ...options, platform })
      const expected = platform === 'windows-x64' ? names(version).slice(0, 2) : names(version).slice(2)
      assert.deepEqual(result.targets[platform]!.downloads.map(f => f.name).sort(), [...expected].sort())
      assert.ok(result.targets[platform]!.downloads.every(f => f.sha512 === sha512 && f.size === bytes.length))
      assert.deepEqual((await readdir(path.join(releaseRoot, 'archive', version, platform))).sort(), [...expected].sort())
      await assert.rejects(publishRelease({ ...options, platform }), /already published/)
    }
  }
  assert.equal((await readCatalog(releaseRoot)).releases.length, versions.length)
})

test('CLI cannot register a beta installer as its stable prefix version', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'website-release-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input'), releaseDirectory = path.join(root, 'releases')
  await mkdir(input)
  await writeFile(path.join(input, names('0.3.0-beta.1')[0]!), 'beta installer')
  const notes = path.join(root, 'notes.json'), config = path.join(root, 'website.json')
  await writeFile(notes, JSON.stringify({ title: 'Beta 测试', notes: ['仅允许完整版本'] }))
  await writeFile(config, JSON.stringify({ schemaVersion: 1, websiteUrl: 'http://127.0.0.1:4173', host: '127.0.0.1', port: 4173,
    releaseDirectory, contentDirectory: path.join(root, 'content'), adminPasswordEnv: 'TEST_ADMIN_PASSWORD' }))
  const run = promisify(execFile)
  const args = ['--import', 'tsx', 'scripts/publish-release.ts', '--platform', 'windows-x64', '--input', input, '--notes', notes, '--config', config]
  const options = { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15_000, maxBuffer: 1024 ** 2 }
  await assert.rejects(run(process.execPath, [...args, '--version', '0.3.0'], options), /Expected exactly one versioned installer/)
  assert.equal((await readCatalog(releaseDirectory)).releases.length, 0)
  await run(process.execPath, [...args, '--version', '0.3.0-beta.1'], options)
  assert.equal((await readCatalog(releaseDirectory)).releases[0]!.version, '0.3.0-beta.1')
})
