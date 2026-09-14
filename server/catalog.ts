import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  archiveUrl, CatalogSchema, compareVersions, isPrerelease, releaseNotesUrl,
  type Release, type ReleaseCatalog, type ReleasePlatform, type UpdateDecision,
} from '@dsh-ops/release-contract'

const MAX_CATALOG_BYTES = 2 * 1024 ** 2
export async function readCatalog(root: string): Promise<ReleaseCatalog> {
  try {
    const file = path.join(root, 'catalog.json')
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CATALOG_BYTES) throw new Error('Invalid release catalog file')
    const text = await readFile(file, 'utf8')
    if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error('Release catalog is too large')
    return CatalogSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, releases: [] }
    throw error
  }
}

export function rolloutBucket(installationId: string, version: string, platform: ReleasePlatform): number {
  return createHash('sha256').update(`${installationId.toLowerCase()}:${version}:${platform}`).digest().readUInt32BE(0) / 2 ** 32 * 100
}

export function visibleReleases(catalog: ReleaseCatalog, now = Date.now()): Release[] {
  return catalog.releases.filter(r => r.enabled && Date.parse(r.publishedAt) <= now)
    .sort((a, b) => compareVersions(b.version, a.version))
}

export function decideUpdate(catalog: ReleaseCatalog, query: { installationId: string; currentVersion: string; platform: ReleasePlatform }, websiteUrl: string, now = Date.now()): UpdateDecision {
  const release = visibleReleases(catalog, now).find(r => r.targets[query.platform] &&
    compareVersions(r.version, query.currentVersion) > 0 &&
    (isPrerelease(query.currentVersion) || !isPrerelease(r.version)) &&
    (!r.minimumVersion || compareVersions(query.currentVersion, r.minimumVersion) >= 0) &&
    rolloutBucket(query.installationId, r.version, query.platform) < r.rolloutPercentage)
  if (!release) return { schemaVersion: 1, updateAvailable: false }
  return { schemaVersion: 1, updateAvailable: true, version: release.version, platform: query.platform,
    feedUrl: archiveUrl(websiteUrl, release.version, query.platform), releaseNotesUrl: releaseNotesUrl(websiteUrl, release.version),
    artifact: release.targets[query.platform]!.artifact }
}
