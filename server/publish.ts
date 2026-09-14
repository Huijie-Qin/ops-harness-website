import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { CatalogSchema, FileNameSchema, ReleaseNotesSchema, ReleaseSchema, VersionSchema, type ReleasePlatform, type ReleaseArtifact } from '@dsh-ops/release-contract'
import { readCatalog } from './catalog.js'

export async function inspectArtifact(file: string) {
  const name = FileNameSchema.parse(path.basename(file))
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 20 * 1024 ** 3) throw new Error('Invalid release artifact')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const after = await lstat(file)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Artifact changed while hashing')
  return { name, size: after.size, sha512: hash.digest('base64') }
}

export function matchingArtifacts(entries: string[], version: string, platform: ReleasePlatform) {
  const versionToken = new RegExp(`(?:^|[ _-])${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[ _-]|\\.(?:exe|zip|dmg|blockmap)$)`)
  return entries.filter(name => FileNameSchema.safeParse(name).success && versionToken.test(name) &&
    (platform === 'windows-x64'
      ? !name.includes('arm64') && (name.endsWith('.exe') || name.endsWith('.zip') && /[ _-]x64\./.test(name))
      : /\.(zip|dmg|blockmap)$/.test(name) && /[ _-]arm64\./.test(name)))
}

export async function publishRelease(options: {
  root: string; input: string; version: string; platform: ReleasePlatform; notes: unknown;
  rolloutPercentage?: number; publishedAt?: string; minimumVersion?: string; signal?: AbortSignal; expectedArtifacts?: ReleaseArtifact[];
}) {
  options.signal?.throwIfAborted()
  const version = VersionSchema.parse(options.version)
  const notes = ReleaseNotesSchema.parse(options.notes)
  const root = path.resolve(options.root)
  const inputInfo = await lstat(options.input)
  if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) throw new Error('Input must be a real artifact directory')
  const entries = await readdir(options.input)
  const candidates = matchingArtifacts(entries, version, options.platform)
  const mainFiles = candidates.filter(name => name.endsWith(options.platform === 'windows-x64' ? '.exe' : '.zip'))
  if (mainFiles.length !== 1) throw new Error('Expected exactly one versioned installer/update ZIP for this platform')
  if (candidates.length > 8) throw new Error('Too many release artifacts')
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Release root must not be a symbolic link')
  const lock = await open(path.join(root, '.publish.lock'), 'wx', 0o600)
  const staging = path.join(root, `.staging-${randomUUID()}`)
  let committedDirectory: string | undefined
  let catalogCommitted = false
  try {
    const catalog = await readCatalog(root)
    const existing = catalog.releases.find(r => r.version === version)
    if (existing?.targets[options.platform]) throw new Error('This version/platform is already published; use a new version')
    await mkdir(staging)
    for (const name of candidates) {
      const source = path.join(options.input, name)
      const sourceInfo = await lstat(source)
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Artifact must be a regular file')
      options.signal?.throwIfAborted()
      await copyFile(source, path.join(staging, name), constants.COPYFILE_EXCL)
    }
    const downloads = await Promise.all(candidates.map(name => inspectArtifact(path.join(staging, name))))
    if (options.expectedArtifacts && (options.expectedArtifacts.length !== downloads.length || options.expectedArtifacts.some(f => !downloads.some(d => d.name === f.name && d.size === f.size && d.sha512 === f.sha512)))) throw new Error('Artifact no longer matches the reviewed upload')
    const artifact = downloads.find(f => f.name === mainFiles[0])!
    const release = ReleaseSchema.parse({
      ...notes, version, publishedAt: existing?.publishedAt ?? options.publishedAt ?? new Date().toISOString(),
      enabled: existing?.enabled ?? true, rolloutPercentage: existing?.rolloutPercentage ?? options.rolloutPercentage ?? 100,
      ...(existing?.minimumVersion || options.minimumVersion ? { minimumVersion: existing?.minimumVersion ?? options.minimumVersion } : {}),
      targets: { ...existing?.targets, [options.platform]: { artifact, downloads } },
    })
    if (existing && (existing.title !== notes.title || JSON.stringify(existing.notes) !== JSON.stringify(notes.notes))) throw new Error('Release notes must match the other platform of this version')
    const next = CatalogSchema.parse({ schemaVersion: 1, releases: [...catalog.releases.filter(r => r.version !== version), release] })
    options.signal?.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > 2 * 1024 ** 2) throw new Error('Release catalog is too large')
    const versionDir = path.join(root, 'archive', version)
    for (const dir of [path.join(root, 'archive'), versionDir]) {
      try { await mkdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const info = await lstat(dir)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Archive must contain only real directories')
    }
    const destination = path.join(versionDir, options.platform)
    try { await lstat(destination); throw new Error('Archive already exists; inspect the previous interrupted publication') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(staging, destination)
    committedDirectory = destination
    const temp = path.join(root, `.catalog-${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(temp, path.join(root, 'catalog.json'))
      catalogCommitted = true
    } finally { await rm(temp, { force: true }) }
    return release
  } finally {
    await rm(staging, { recursive: true, force: true })
    // Only remove the exact directory created by this uncommitted transaction.
    if (committedDirectory && !catalogCommitted) await rm(committedDirectory, { recursive: true, force: true })
    await lock.close()
    await unlink(path.join(root, '.publish.lock'))
  }
}
