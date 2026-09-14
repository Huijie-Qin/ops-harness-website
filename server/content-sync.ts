import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { GuideError, GuideStore, decodeChapter } from './guide-store.js'
import { MediaStore, readMediaBytes, readMediaIndex } from './media-store.js'
import { atomicJson, missing, safeDirectory, withLock } from './admin-files.js'
import { openContainedFile } from './files.js'
import { maxChapterBytes, validChapterId } from '../shared/guide.js'
import { maxImageBytes, type ContentSyncPreview, type MediaImage } from '../shared/admin.js'

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
type Input = { path: string; hash: string; targetHash: string | null; bytes?: Buffer; image?: { root: string; value: MediaImage } }
async function read(root: string, relative: string, max: number): Promise<Buffer | undefined> {
  try {
    const { handle, info } = await openContainedFile(root, relative.split('/'))
    try { if (info.size > max) throw new GuideError('CONTENT_UNAVAILABLE', 503); return await handle.readFile() }
    finally { await handle.close() }
  } catch (error) { if (missing(error)) return; throw error }
}
async function directories(root: string, relative: string) {
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new GuideError('UNSAFE_CONTENT_PATH', 503)
  let current = root
  for (const part of relative.split('/').slice(0, -1)) { current = path.join(current, part); await safeDirectory(current) }
}
async function atomicFile(root: string, relative: string, bytes: Buffer) {
  await directories(root, relative)
  const target = path.join(root, relative), temp = path.join(path.dirname(target), `.${randomUUID()}.sync-tmp`)
  try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new GuideError('UNSAFE_CONTENT_PATH', 503) }
  catch (error) { if (!missing(error)) throw error }
  const handle = await open(temp, 'wx', 0o644)
  try {
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(temp, target)
  } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error }) }
}

// Only these validated content files can be written. No request supplies a path.
export class ContentSync {
  constructor(private guides: GuideStore, private media: MediaStore, readonly target: string) {}
  private async locked<T>(action: () => Promise<T>) {
    // The source tree must never contain (or live inside) mutable state.
    const inside = (parent: string, child: string) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) }
    const runtime = path.dirname(this.guides.root)
    if (inside(this.target, runtime) || inside(runtime, this.target) || inside(this.target, this.media.root) || inside(this.media.root, this.target)) throw new GuideError('UNSAFE_CONTENT_PATH', 503)
    return this.guides.withWriteLock(() => withLock(this.media.root, '.media-lock', () => withLock(runtime, '.content-sync-lock', async () => {
      if (await read(runtime, 'content-sync-review.json', 4096)) throw new GuideError('CONTENT_SYNC_REVIEW', 409)
      return action()
    })))
  }
  private async plan() {
    const targetInfo = await lstat(this.target).catch(error => { if (missing(error)) throw new GuideError('CONTENT_SYNC_UNAVAILABLE', 503); throw error })
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new GuideError('UNSAFE_CONTENT_PATH', 503)
    const inputs: Input[] = []
    const add = async (relative: string, bytes: Buffer, image?: Input['image']) => {
      const previous = await read(this.target, relative, maxImageBytes)
      inputs.push({ path: relative, hash: hash(bytes), targetHash: previous ? hash(previous) : null, ...(image ? { image } : { bytes }) })
    }
    for (const file of (await readdir(path.join(this.guides.root, 'current'))).sort()) {
      if (!file.endsWith('.md')) continue
      const id = file.slice(0, -3)
      if (!validChapterId(id)) throw new GuideError('INVALID_CHAPTER_ID')
      const bytes = (await read(this.guides.root, `current/${file}`, maxChapterBytes))!
      if (decodeChapter(bytes.toString('utf8')).id !== id) throw new GuideError('INVALID_CHAPTER_ID')
      // Keep source Markdown bytes and formatting exactly as published.
      await add(`guide/${file}`, bytes)
    }
    const onlineNavigation = await read(this.guides.root, 'navigation.json', maxChapterBytes)
    if (onlineNavigation) {
      const { revision, ...navigation } = await this.guides.navigation()
      await add('guide/navigation.json', Buffer.from(JSON.stringify(navigation, null, 2) + '\n'))
    }
    const onlineImages = await this.media.onlineList()
    if (onlineImages.length) {
      const existing = await readMediaIndex(path.join(this.target, 'media'))
      for (const image of onlineImages) {
        const source = await this.media.resolveImage(image)
        await add(image.url.slice(1), source.bytes, { root: source.root, value: image })
      }
      const merged = [...onlineImages, ...existing.filter(image => !onlineImages.some(v => v.url === image.url))]
      if (merged.length > 4000) throw new GuideError('IMAGE_LIMIT', 409)
      await add('media/index.json', Buffer.from(JSON.stringify(merged, null, 2) + '\n'))
    }
    inputs.sort((a, b) => a.path.localeCompare(b.path))
    const revision = hash(JSON.stringify(inputs.map(({ path, hash, targetHash }) => ({ path, hash, targetHash }))))
    const changed = inputs.filter(item => item.hash !== item.targetHash)
    const preview: ContentSyncPreview = { revision, files: changed.map(item => ({ path: `content/${item.path}`, action: item.targetHash === null ? '新增' : '覆盖' })) }
    return { inputs: changed, preview }
  }
  async preview() { return this.locked(async () => (await this.plan()).preview) }
  async apply(expectedRevision: unknown) {
    return this.locked(async () => {
      const { inputs, preview } = await this.plan()
      if (preview.revision !== expectedRevision) throw new GuideError('REVISION_CONFLICT', 409)
      if (!inputs.length) return { files: 0 }
      const backupId = randomUUID(), backup = path.join(path.dirname(this.guides.root), 'sync-backups', backupId)
      await safeDirectory(path.dirname(backup))
      await safeDirectory(backup)
      const journal = { status: 'prepared', files: inputs.map(({ path, hash, targetHash }) => ({ path, hash, targetHash })) }
      for (const item of inputs) {
        const bytes = item.image ? await readMediaBytes(item.image.root, item.image.value) : item.bytes!
        if (hash(bytes) !== item.hash) throw new GuideError('REVISION_CONFLICT', 409)
        await atomicFile(backup, `new/${item.path}`, bytes)
        const old = await read(this.target, item.path, maxImageBytes)
        if ((old ? hash(old) : null) !== item.targetHash) throw new GuideError('REVISION_CONFLICT', 409)
        if (old) await atomicFile(backup, `old/${item.path}`, old)
      }
      await atomicJson(backup, 'manifest.json', journal)
      const runtime = path.dirname(this.guides.root)
      await atomicJson(runtime, 'content-sync-review.json', { backupId })
      const written: Input[] = []
      try {
        for (const item of inputs) {
          const current = await read(this.target, item.path, maxImageBytes)
          if ((current ? hash(current) : null) !== item.targetHash) throw new GuideError('REVISION_CONFLICT', 409)
          await atomicFile(this.target, item.path, (await read(backup, `new/${item.path}`, maxImageBytes))!)
          written.push(item)
        }
        await atomicJson(backup, 'manifest.json', { ...journal, status: 'complete' })
        await unlink(path.join(runtime, 'content-sync-review.json'))
      } catch (error) {
        let rolledBack = true
        for (const item of written.reverse()) try {
          const current = await read(this.target, item.path, maxImageBytes)
          if (!current || hash(current) !== item.hash) { rolledBack = false; continue }
          const old = await read(backup, `old/${item.path}`, maxImageBytes)
          if (old) await atomicFile(this.target, item.path, old); else await unlink(path.join(this.target, item.path))
        } catch { rolledBack = false }
        await atomicJson(backup, 'manifest.json', { ...journal, status: rolledBack ? 'rolled-back' : 'needs-review' })
        if (rolledBack) await unlink(path.join(runtime, 'content-sync-review.json'))
        throw new GuideError(rolledBack && error instanceof GuideError ? error.code : 'CONTENT_SYNC_FAILED', rolledBack && error instanceof GuideError ? error.status : 503)
      }
      return { files: inputs.length, backupId }
    })
  }
}
