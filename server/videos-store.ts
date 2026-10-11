import { createHash, randomUUID } from 'node:crypto'
import { rename, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { z } from 'zod'
import {
  maxVideoDescription, maxVideoDurationSeconds, maxVideoEntries, maxVideoFileBytes, maxVideoTitle,
  validVideoCoverUrl, type VideoCatalog, type VideoEntry, type VideoFile, type PublicVideoCatalog,
} from '../shared/videos.js'
import { atomicJson, missing, readJson, receiveFile, safeDirectory, withLock } from './admin-files.js'
import { openContainedFile, serveFile } from './files.js'
import { GuideError, revisionOf } from './guide-store.js'
import { validateMp4 } from './videos-mp4.js'

const idPattern = /^video-[a-f0-9-]{36}$/
const fileNameSchema = z.string().trim().min(5).max(200).regex(/^[^/\\\x00-\x1f\x7f:*?"<>|]+\.mp4$/i)
const durationSchema = z.number().finite().min(0).max(maxVideoDurationSeconds)
const inputSchema = z.object({
  title: z.string().trim().min(1).max(maxVideoTitle), description: z.string().trim().max(maxVideoDescription),
  category: z.enum(['product', 'feature', 'practice']), status: z.enum(['draft', 'published']),
  featured: z.boolean(), coverUrl: z.string().trim().max(2048).refine(validVideoCoverUrl), durationSeconds: durationSchema,
}).strict()
const fileSchema = z.object({
  fileName: fileNameSchema, url: z.string(), size: z.number().int().positive().max(maxVideoFileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.literal('video/mp4'),
}).strict().refine(file => file.url === `/videos/${file.sha256}.mp4`)
const entrySchema = inputSchema.extend({
  id: z.string().regex(idPattern), video: fileSchema.optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().refine(entry => entry.status === 'published' ? Boolean(entry.video) && entry.durationSeconds > 0 : !entry.featured)
const documentSchema = z.object({ schemaVersion: z.literal(1), items: z.array(entrySchema).max(maxVideoEntries) }).strict()
  .refine(document => new Set(document.items.map(entry => entry.id)).size === document.items.length && document.items.filter(entry => entry.featured).length <= 1)
type Document = z.infer<typeof documentSchema>
const empty: Document = { schemaVersion: 1, items: [] }
const catalog = (document: Document): VideoCatalog => ({ ...document, revision: revisionOf(JSON.stringify(document)) })
function fail(code: string, status = 400): never { throw new GuideError(code, status) }
const timestamp = (previous = '') => new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString()
async function fileDigest(root: string, name: string, size: number) {
  const { handle, info } = await openContainedFile(root, [name])
  const hash = createHash('sha256')
  try {
    if (info.size !== size) fail('CONTENT_UNAVAILABLE', 503)
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    return hash.digest('hex')
  } finally { await handle.close() }
}
function input(value: unknown) {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) return fail('INVALID_VIDEO')
  return { ...parsed.data, featured: parsed.data.status === 'published' && parsed.data.featured }
}

/** Runtime content only. Draft files are never exposed by the public file route. */
export class VideoStore {
  readonly root: string
  readonly files: string
  constructor(directory: string) { this.root = path.join(directory, 'videos'); this.files = path.join(this.root, 'files') }

  private async load(): Promise<Document> {
    let value: unknown
    try { value = await readJson(this.root, ['catalog.json'], 4 * 1024 ** 2) }
    catch (error) { if (missing(error)) return structuredClone(empty); throw new GuideError('CONTENT_UNAVAILABLE', 503) }
    const parsed = documentSchema.safeParse(value)
    if (!parsed.success) return fail('CONTENT_UNAVAILABLE', 503)
    return parsed.data
  }
  list(): Promise<VideoCatalog> { return this.load().then(catalog) }
  async published(): Promise<PublicVideoCatalog> {
    const document = await this.load()
    return { schemaVersion: 1, items: document.items.filter(entry => entry.status === 'published') }
  }
  private checkRevision(document: Document, revision: unknown) {
    if (typeof revision !== 'string' || revision !== catalog(document).revision) fail('REVISION_CONFLICT', 409)
  }
  private entry(document: Document, id: string) {
    const entry = document.items.find(item => item.id === id)
    if (!entry) return fail('VIDEO_NOT_FOUND', 404)
    return entry
  }
  private async change(revision: unknown, action: (document: Document) => Promise<void> | void, backup = true) {
    return withLock(this.root, '.videos-lock', async () => {
      const document = await this.load()
      this.checkRevision(document, revision)
      const previous = structuredClone(document)
      await action(document)
      const parsed = documentSchema.safeParse(document)
      if (!parsed.success) return fail('INVALID_VIDEO')
      if (backup && previous.items.length) await atomicJson(path.join(this.root, '.trash'), `catalog-${randomUUID()}.json`, previous)
      await atomicJson(this.root, 'catalog.json', parsed.data)
      return catalog(parsed.data)
    })
  }
  private async checkPublished(entry: VideoEntry) {
    if (entry.status !== 'published') return
    if (!entry.video) fail('VIDEO_FILE_REQUIRED', 409)
    if (entry.durationSeconds <= 0) fail('INVALID_VIDEO')
    try {
      if (await fileDigest(this.files, `${entry.video.sha256}.mp4`, entry.video.size) !== entry.video.sha256) fail('CONTENT_UNAVAILABLE', 503)
    } catch (error) { if (error instanceof GuideError) throw error; fail('CONTENT_UNAVAILABLE', 503) }
  }
  private selectFeatured(document: Document, entry: VideoEntry) {
    if (entry.featured) for (const item of document.items) {
      if (item.id !== entry.id && item.featured) { item.featured = false; item.updatedAt = timestamp(item.updatedAt) }
    }
  }
  async create(value: unknown, revision: unknown) {
    const data = input(value)
    return this.change(revision, async document => {
      if (document.items.length >= maxVideoEntries) fail('VIDEO_LIMIT_REACHED', 409)
      const now = timestamp()
      const entry: VideoEntry = { ...data, id: `video-${randomUUID()}`, createdAt: now, updatedAt: now }
      await this.checkPublished(entry)
      this.selectFeatured(document, entry)
      document.items.push(entry)
    }, false)
  }
  async update(id: string, value: unknown, revision: unknown) {
    const data = input(value)
    return this.change(revision, async document => {
      const old = this.entry(document, id)
      const entry = { ...old, ...data, updatedAt: timestamp(old.updatedAt) }
      await this.checkPublished(entry)
      this.selectFeatured(document, entry)
      document.items[document.items.indexOf(old)] = entry
    })
  }
  async remove(id: string, revision: unknown) {
    return this.change(revision, async document => {
      const entry = this.entry(document, id)
      await atomicJson(path.join(this.root, '.trash'), `${id}-${randomUUID()}.json`, entry)
      document.items = document.items.filter(item => item.id !== id)
    })
  }
  async upload(id: string, name: unknown, req: IncomingMessage, revision: unknown, duration?: unknown) {
    const parsedName = fileNameSchema.safeParse(name)
    if (!parsedName.success) fail('INVALID_VIDEO')
    let durationSeconds: number | undefined
    if (duration !== undefined) {
      if (typeof duration !== 'string' || !duration.trim()) fail('INVALID_VIDEO')
      const parsed = durationSchema.safeParse(Number(duration))
      if (!parsed.success || parsed.data <= 0) fail('INVALID_VIDEO')
      durationSeconds = parsed.data
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail('INVALID_REQUEST', 415)
    // Reject stale or published requests before receiving a potentially large body; repeat under the commit lock.
    const current = await this.load()
    this.checkRevision(current, revision)
    if (this.entry(current, id).status !== 'draft') fail('VIDEO_MUST_BE_DRAFT', 409)
    await safeDirectory(this.root)
    const received = await receiveFile(req, path.join(this.root, '.uploads'), maxVideoFileBytes)
    try {
      await validateMp4(received.temp)
      const sha256 = await fileDigest(path.dirname(received.temp), path.basename(received.temp), received.size)
      const video: VideoFile = { fileName: parsedName.data!, url: `/videos/${sha256}.mp4`, sha256, size: received.size, contentType: 'video/mp4' }
      return await this.change(revision, async document => {
        const entry = this.entry(document, id)
        if (entry.status !== 'draft') fail('VIDEO_MUST_BE_DRAFT', 409)
        await safeDirectory(this.files)
        const file = `${sha256}.mp4`
        try {
          if (await fileDigest(this.files, file, received.size) !== sha256) fail('CONTENT_UNAVAILABLE', 503)
        } catch (error) { if (!missing(error)) throw error; await rename(received.temp, path.join(this.files, file)) }
        entry.video = video
        if (durationSeconds !== undefined) entry.durationSeconds = durationSeconds
        entry.updatedAt = timestamp(entry.updatedAt)
      })
    } finally { await unlink(received.temp).catch(error => { if (!missing(error)) throw error }) }
  }
  private async stream(req: IncomingMessage, res: ServerResponse, video: VideoFile) {
    // Recheck publication on each request; a cache must not keep serving a withdrawn film.
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    await serveFile(req, res, this.files, [`${video.sha256}.mp4`], { type: 'video/mp4', expectedSize: video.size, etag: `"${video.sha256}"` })
  }
  async preview(id: string, req: IncomingMessage, res: ServerResponse) {
    const entry = this.entry(await this.load(), id)
    if (!entry.video) fail('VIDEO_FILE_REQUIRED', 404)
    await this.stream(req, res, entry.video)
  }
  async servePublished(file: string, req: IncomingMessage, res: ServerResponse) {
    const entry = (await this.load()).items.find(item => item.status === 'published' && item.video?.url === `/videos/${file}`)
    if (!entry?.video) fail('VIDEO_NOT_FOUND', 404)
    await this.stream(req, res, entry.video)
  }
}
