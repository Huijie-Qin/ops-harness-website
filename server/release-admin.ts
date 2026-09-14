import { randomUUID } from 'node:crypto'
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { ArtifactSchema, CatalogSchema, FileNameSchema, PlatformSchema, ReleaseNotesSchema, ReleaseSchema, VersionSchema } from '@dsh-ops/release-contract'
import { maxPackageBytes, type ReleaseDraft } from '../shared/admin.js'
import { GuideError, revisionOf } from './guide-store.js'
import { atomicJson, missing, readJson, receiveFile, safeDirectory, withLock } from './admin-files.js'
import { readCatalog } from './catalog.js'
import { matchingArtifacts, publishRelease } from './publish.js'

const DraftInput = ReleaseNotesSchema.extend({ version: VersionSchema, platform: PlatformSchema }).strict()
const DraftSchema = DraftInput.extend({ id: z.string().uuid(), published: z.boolean(), files: z.array(ArtifactSchema).max(8), createdAt: z.string().datetime() }).strict()
const revision = (v: unknown) => revisionOf(JSON.stringify(v))
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new GuideError('INVALID_RELEASE')
  return result.data
}
export class ReleaseAdmin {
  readonly drafts: string
  constructor(readonly root: string) { this.drafts = path.join(root, '.admin-drafts') }
  private directory(id: string) { if (!z.string().uuid().safeParse(id).success) throw new GuideError('INVALID_RELEASE'); return path.join(this.drafts, id) }
  async get(id: string): Promise<ReleaseDraft> {
    this.directory(id)
    try { const v = parse(DraftSchema, await readJson(this.drafts, [id, 'draft.json'])); if (v.id !== id) throw new GuideError('INVALID_RELEASE'); return { ...v, revision: revision(v) } }
    catch (e) { if (missing(e)) throw new GuideError('DRAFT_NOT_FOUND', 404); throw e }
  }
  async list() {
    await safeDirectory(this.root); await safeDirectory(this.drafts)
    const drafts: ReleaseDraft[] = []
    for (const id of await readdir(this.drafts)) if (z.string().uuid().safeParse(id).success) drafts.push(await this.get(id))
    const releases = (await readCatalog(this.root)).releases.map(r => ({ ...r, revision: revision(r) }))
    return { drafts: drafts.sort((a,b) => b.createdAt.localeCompare(a.createdAt)), releases }
  }
  async create(input: unknown) {
    const value = parse(DraftInput, input)
    return withLock(this.drafts, '.create-lock', async () => {
      if ((await this.list()).drafts.length >= 100) throw new GuideError('DRAFT_LIMIT', 409)
      const id = randomUUID()
      await atomicJson(this.directory(id), 'draft.json', { ...value, id, published: false, files: [], createdAt: new Date().toISOString() })
      return this.get(id)
    })
  }
  private async change<T>(id: string, expected: unknown, action: (value: ReleaseDraft) => Promise<T>, allowPublished = false) {
    // Check existence before locking; malformed or missing IDs must not create directories.
    await this.get(id)
    return withLock(this.directory(id), '.draft-lock', async () => {
      const current = await this.get(id)
      if (current.revision !== expected) throw new GuideError('REVISION_CONFLICT', 409)
      if (current.published && !allowPublished) throw new GuideError('ALREADY_PUBLISHED', 409)
      return action(current)
    })
  }
  private async write(value: ReleaseDraft) {
    const { revision: ignored, ...raw } = value
    await atomicJson(this.directory(value.id), 'draft.json', parse(DraftSchema, raw))
    return this.get(value.id)
  }
  async save(id: string, input: unknown, expected: unknown) {
    const value = parse(DraftInput, input)
    return this.change(id, expected, async current => {
      if (current.files.length && (value.version !== current.version || value.platform !== current.platform)) throw new GuideError('RELEASE_ID_LOCKED', 409)
      return this.write({ ...current, ...value })
    })
  }
  async upload(id: string, name: string, req: IncomingMessage, expected: unknown) {
    return this.change(id, expected, async current => {
      if (!FileNameSchema.safeParse(name).success || matchingArtifacts([name], current.version, current.platform).length !== 1) throw new GuideError('INVALID_PACKAGE_NAME')
      if (current.files.some(f => f.name === name)) throw new GuideError('FILE_EXISTS', 409)
      if (current.files.length >= 8) throw new GuideError('FILE_LIMIT', 409)
      const directory = path.join(this.directory(id), 'files')
      const file = await receiveFile(req, directory, maxPackageBytes)
      let moved = false, committed = false
      try {
        try { await lstat(path.join(directory, name)); throw new GuideError('FILE_EXISTS', 409) } catch (e) { if (!missing(e)) throw e }
        await rename(file.temp, path.join(directory, name)); moved = true
        const result = await this.write({ ...current, files: [...current.files, { name, size: file.size, sha512: file.sha512 }] })
        committed = true; return result
      } finally { await unlink(file.temp).catch(() => {}); if (moved && !committed) await unlink(path.join(directory, name)) }
    })
  }
  async removeFile(id: string, name: string, expected: unknown) {
    return this.change(id, expected, async current => {
      if (!current.files.some(f => f.name === name)) throw new GuideError('FILE_NOT_FOUND', 404)
      const trash = path.join(this.root, '.trash'); await safeDirectory(trash)
      const source = path.join(this.directory(id), 'files', name), destination = path.join(trash, `${randomUUID()}-${name}`)
      await rename(source, destination)
      try { return await this.write({ ...current, files: current.files.filter(f => f.name !== name) }) }
      catch (e) { await rename(destination, source); throw e }
    })
  }
  async discard(id: string, expected: unknown) {
    await this.get(id)
    const directory = this.directory(id), lockPath = path.join(directory, '.draft-lock')
    let lock, moved: string | undefined
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new GuideError('CONTENT_BUSY', 409); throw e }
    try {
      if ((await this.get(id)).revision !== expected) throw new GuideError('REVISION_CONFLICT', 409)
      const trash = path.join(this.root, '.trash'); await safeDirectory(trash)
      const destination = path.join(trash, `draft-${id}-${randomUUID()}`)
      await rename(directory, destination); moved = destination
    } finally { await lock.close(); await unlink(moved ? path.join(moved, '.draft-lock') : lockPath) }
  }
  async publish(id: string, expected: unknown, signal: AbortSignal) {
    return this.change(id, expected, async current => {
      if (!current.files.length || current.files.filter(f => f.name.endsWith(current.platform === 'windows-x64' ? '.exe' : '.zip')).length !== 1) throw new GuideError('MAIN_PACKAGE_REQUIRED')
      const existing = (await readCatalog(this.root)).releases.find(r => r.version === current.version)
      if (existing?.targets[current.platform]) {
        const files = existing.targets[current.platform]!.downloads
        if (files.length === current.files.length && current.files.every(f => files.some(x => x.name === f.name && x.sha512 === f.sha512 && x.size === f.size))) {
          await this.write({ ...current, published: true }); return existing
        }
        throw new GuideError('ALREADY_PUBLISHED', 409)
      }
      if (existing && (existing.title !== current.title || JSON.stringify(existing.notes) !== JSON.stringify(current.notes))) throw new GuideError('RELEASE_NOTES_MISMATCH', 409)
      try {
        const result = await publishRelease({ root: this.root, input: path.join(this.directory(id), 'files'), version: current.version, platform: current.platform, notes: { title: current.title, notes: current.notes }, signal, expectedArtifacts: current.files })
        await this.write({ ...current, published: true }); return result
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new GuideError('CONTENT_BUSY', 409)
        if (e instanceof GuideError) throw e
        throw new GuideError('PUBLICATION_FAILED', 409)
      }
    }, true)
  }
  async update(version: string, input: unknown, expected: unknown) {
    parse(VersionSchema, version)
    const value = parse(ReleaseNotesSchema.extend({ enabled: z.boolean() }).strict(), input)
    return withLock(this.root, '.publish.lock', async () => {
      const catalog = await readCatalog(this.root), current = catalog.releases.find(r => r.version === version)
      if (!current) throw new GuideError('RELEASE_NOT_FOUND', 404)
      if (revision(current) !== expected) throw new GuideError('REVISION_CONFLICT', 409)
      const next = ReleaseSchema.parse({ ...current, ...value })
      const all = CatalogSchema.parse({ ...catalog, releases: catalog.releases.map(r => r.version === version ? next : r) })
      if (Buffer.byteLength(JSON.stringify(all, null, 2) + '\n') > 2 * 1024 ** 2) throw new GuideError('CATALOG_LIMIT', 409)
      await atomicJson(this.root, 'catalog.json', all)
      return { ...next, revision: revision(next) }
    })
  }
}
