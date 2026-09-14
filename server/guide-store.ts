import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, readdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument, stringify } from 'yaml'
import type { Navigation, NavigationDocument } from '../shared/admin.js'
import { openContainedFile } from './files.js'
import { validChapterId, maxChapterBytes, type Chapter, type ChapterDraft, type ChapterSummary, type HistoryEntry } from '../shared/guide.js'

export class GuideError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}
const fail = (code = 'INVALID_CHAPTER', status = 400): never => { throw new GuideError(code, status) }
export function validateDraft(value: unknown): ChapterDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const v = value as Record<string, unknown>
  if (!validChapterId(v.id) || !Number.isSafeInteger(v.order) || Number(v.order) < 0 || Number(v.order) > 100000 ||
      typeof v.archived !== 'boolean' || typeof v.markdown !== 'string' || !v.markdown.trim() ||
      !['title','group','summary'].every(key => typeof v[key] === 'string') ||
      !(v.title as string).trim() || (v.title as string).length > 100 || !(v.group as string).trim() || (v.group as string).length > 60 ||
      (v.summary as string).length > 500 || Object.keys(v).some(key => !['id','title','group','order','summary','archived','markdown'].includes(key))) return fail()
  const result = { id: v.id, title: (v.title as string).trim(), group: (v.group as string).trim(), order: Number(v.order), summary: (v.summary as string).trim(), archived: v.archived, markdown: v.markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') }
  if (Buffer.byteLength(result.markdown) > maxChapterBytes) return fail('CHAPTER_TOO_LARGE', 413)
  return result
}
export function encodeChapter(draft: ChapterDraft): string {
  const { markdown, ...meta } = validateDraft(draft)
  const raw = `---\n${stringify(meta)}---\n\n${markdown.trimEnd()}\n`
  if (Buffer.byteLength(raw) > maxChapterBytes) return fail('CHAPTER_TOO_LARGE', 413)
  return raw
}
export function decodeChapter(raw: string): ChapterDraft {
  if (Buffer.byteLength(raw) > maxChapterBytes) return fail('CHAPTER_TOO_LARGE', 413)
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized)
  if (!match || match[1]!.length > 4096) return fail()
  try {
    const parsed = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' })
    if (parsed.errors.length) return fail()
    const meta = parsed.toJS({ maxAliasCount: 0 })
    return validateDraft({ ...meta, archived: meta.archived ?? false, markdown: match[2]!.replace(/^\n/, '') })
  } catch { return fail() }
}
export const revisionOf = (raw: string) => createHash('sha256').update(raw).digest('hex')
const validRevision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export class GuideStore {
  private queue: Promise<unknown> = Promise.resolve()
  readonly root: string
  constructor(readonly seedRoot: string, directory: string) { this.root = path.join(directory, 'guide') }
  async initialize() {
    await this.directory(this.root)
    await this.directory(path.join(this.root, 'current'))
    await this.directory(path.join(this.root, 'history'))
  }
  private async directory(location: string) {
    await mkdir(location, { recursive: true })
    const info = await lstat(location)
    if (!info.isDirectory() || info.isSymbolicLink()) return fail('UNSAFE_CONTENT_PATH', 503)
  }
  private async read(root: string, segments: string[]) {
    const { handle, info } = await openContainedFile(root, segments)
    try {
      if (info.size > maxChapterBytes) return fail('CHAPTER_TOO_LARGE', 413)
      const raw = await handle.readFile('utf8')
      const draft = decodeChapter(raw)
      return { raw, draft, updatedAt: info.mtime.toISOString(), revision: revisionOf(raw) }
    } finally { await handle.close() }
  }
  async get(id: string): Promise<Chapter> {
    if (!validChapterId(id)) return fail('INVALID_CHAPTER_ID')
    let content, source: 'repository' | 'online' = 'online'
    try { content = await this.read(this.root, ['current', `${id}.md`]) }
    catch (error) {
      if (!missing(error)) throw error
      source = 'repository'
      try { content = await this.read(this.seedRoot, [`${id}.md`]) }
      catch (error) { if (missing(error)) return fail('CHAPTER_NOT_FOUND', 404); throw error }
    }
    if (content.draft.id !== id) return fail('INVALID_CHAPTER_ID', 503)
    return { ...content.draft, revision: content.revision, updatedAt: content.updatedAt, source }
  }
  async list(includeArchived = false, query = ''): Promise<ChapterSummary[]> {
    const ids = new Set<string>()
    for (const directory of [this.seedRoot, path.join(this.root, 'current')]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) return fail('UNSAFE_CONTENT_PATH', 503)
      for (const file of await readdir(directory)) {
        if (file.endsWith('.md')) { const id = file.slice(0, -3); if (!validChapterId(id)) return fail('INVALID_CHAPTER_ID', 503); ids.add(id) }
      }
    }
    if (ids.size > 200) return fail('CHAPTER_LIMIT', 409)
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const result: ChapterSummary[] = []
    for (const id of ids) {
      const { markdown, ...chapter } = await this.get(id)
      const text = `${chapter.title} ${chapter.group} ${chapter.summary} ${markdown}`.toLocaleLowerCase()
      if ((includeArchived || !chapter.archived) && terms.every(term => text.includes(term))) result.push(chapter)
    }
    return result.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }
  private async atomicWrite(directory: string, name: string, raw: string) {
    await this.directory(directory)
    const target = path.join(directory, name)
    try { if ((await lstat(target)).isSymbolicLink()) return fail('UNSAFE_CONTENT_PATH', 503) } catch (error) { if (!missing(error)) throw error }
    const temp = path.join(directory, `.${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx', 0o600)
    try {
      try { await handle.writeFile(raw); await handle.sync() }
      finally { await handle.close() }
      await rename(temp, target)
    } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error }) }
  }
  withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      await this.initialize()
      let lock
      try { lock = await open(path.join(this.root, '.write-lock'), 'wx', 0o600) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('CONTENT_BUSY', 409); throw error }
      try { return await action() } finally { await lock.close(); await unlink(path.join(this.root, '.write-lock')) }
    })
    this.queue = pending.catch(() => {})
    return pending
  }
  private async saveLocked(draft: ChapterDraft, expectedRevision: unknown) {
    let previous: Chapter | undefined
    try { previous = await this.get(draft.id) } catch (error) { if (!(error instanceof GuideError && error.status === 404)) throw error }
    if (previous ? !validRevision(expectedRevision) || previous.revision !== expectedRevision : expectedRevision !== null) return fail('REVISION_CONFLICT', 409)
    if (!previous && (await this.list(true)).length >= 200) return fail('CHAPTER_LIMIT', 409)
    if (previous) {
      // Preserve the exact bytes represented by the revision, including hand-edited source formatting.
      const raw = await this.read(previous.source === 'online' ? this.root : this.seedRoot, previous.source === 'online' ? ['current', `${draft.id}.md`] : [`${draft.id}.md`])
      if (raw.revision !== previous.revision) return fail('REVISION_CONFLICT', 409)
      await this.atomicWrite(path.join(this.root, 'history', draft.id), `${previous.revision}.md`, raw.raw)
    }
    await this.atomicWrite(path.join(this.root, 'current'), `${draft.id}.md`, encodeChapter(draft))
    return this.get(draft.id)
  }
  async save(value: unknown, expectedRevision: unknown, placement?: { groupId: unknown; navigationRevision: unknown }) {
    const draft = validateDraft(value)
    return this.withWriteLock(async () => {
      if (!placement) return this.saveLocked(draft, expectedRevision)
      if (expectedRevision !== null) return fail('INVALID_REQUEST')
      const { revision, ...navigation } = await this.navigation()
      if (revision !== placement.navigationRevision) return fail('REVISION_CONFLICT', 409)
      const group = navigation.groups.find(g => g.id === placement.groupId)
      if (!group) return fail('INVALID_NAVIGATION')
      const chapter = await this.saveLocked({ ...draft, group: group.title }, null)
      group.chapters.push(chapter.id)
      try { await this.atomicWrite(this.root, 'navigation.json', JSON.stringify(navigation, null, 2) + '\n') }
      catch (error) { await unlink(path.join(this.root, 'current', `${chapter.id}.md`)); throw error }
      return chapter
    })
  }
  async navigation(): Promise<NavigationDocument> {
    const chapters = await this.list(true)
    let value: Navigation = { groups: [], hidden: [] }, revision = revisionOf('initial')
    for (const root of [this.root, this.seedRoot]) try {
      const { handle, info } = await openContainedFile(root, ['navigation.json'])
      try {
        if (info.size > maxChapterBytes) return fail('INVALID_NAVIGATION', 503)
        const raw = await handle.readFile('utf8'); value = this.validateNavigation(JSON.parse(raw.replace(/^\uFEFF/, '')), chapters.map(c => c.id)); revision = revisionOf(raw)
      } finally { await handle.close() }
      break
    } catch (e) { if (!missing(e)) throw e }
    const assigned = new Set(value.groups.flatMap(g => g.chapters))
    for (const chapter of chapters) if (!assigned.has(chapter.id)) {
      let group = value.groups.find(g => g.title === chapter.group)
      if (!group) { const base = `group-${revisionOf(chapter.group).slice(0,16)}`; let id = base, suffix = 1; while(value.groups.some(g => g.id === id)) id = `${base}-${suffix++}`; group = { id, title: chapter.group, chapters: [] }; value.groups.push(group) }
      group.chapters.push(chapter.id)
    }
    // Include the current chapter set in CAS, so a concurrent chapter creation cannot get lost.
    return { ...value, revision: revisionOf(revision + chapters.map(c => c.id).sort().join(',')) }
  }
  private validateNavigation(input: unknown, ids: string[]): Navigation {
    if (!input || typeof input !== 'object') return fail('INVALID_NAVIGATION')
    const v = input as Navigation
    if (!Array.isArray(v.groups) || v.groups.length > 200 || !Array.isArray(v.hidden) || v.hidden.length > 200 || Object.keys(v).some(k => !['groups','hidden'].includes(k))) return fail('INVALID_NAVIGATION')
    const assigned = new Set<string>(), groups = new Set<string>()
    for (const g of v.groups) {
      if (!g || typeof g.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(g.id) || groups.has(g.id) || typeof g.title !== 'string' || !g.title.trim() || g.title.length > 60 || !Array.isArray(g.chapters) || Object.keys(g).some(k => !['id','title','chapters'].includes(k))) return fail('INVALID_NAVIGATION')
      groups.add(g.id)
      for (const id of g.chapters) { if (!ids.includes(id) || assigned.has(id)) return fail('INVALID_NAVIGATION'); assigned.add(id) }
    }
    if (new Set(v.hidden).size !== v.hidden.length || v.hidden.some(id => !ids.includes(id))) return fail('INVALID_NAVIGATION')
    return { groups: v.groups.map(g => ({ ...g, title: g.title.trim(), chapters: [...g.chapters] })), hidden: [...v.hidden] }
  }
  async saveNavigation(input: unknown, revision: unknown) {
    return this.withWriteLock(async () => {
      const current = await this.navigation()
      if (current.revision !== revision) return fail('REVISION_CONFLICT', 409)
      const chapters = await this.list(true), next = this.validateNavigation(input, chapters.map(c => c.id))
      if (next.groups.flatMap(g => g.chapters).length !== chapters.length) return fail('INVALID_NAVIGATION')
      await this.atomicWrite(this.root, 'navigation.json', JSON.stringify(next, null, 2) + '\n')
      return this.navigation()
    })
  }
  async readerList(query: string) {
    const navigation = await this.navigation(), chapters = await this.list(false, query)
    return navigation.groups.flatMap(group => group.chapters.flatMap(id => {
      const chapter = chapters.find(c => c.id === id)
      return chapter && !navigation.hidden.includes(id) ? [{ ...chapter, group: group.title, navigationGroup: group.id }] : []
    }))
  }
  async history(id: string): Promise<HistoryEntry[]> {
    await this.get(id)
    const directory = path.join(this.root, 'history', id)
    let entries: string[]
    try { const info = await lstat(directory); if (info.isSymbolicLink() || !info.isDirectory()) return fail('UNSAFE_CONTENT_PATH', 503); entries = await readdir(directory) }
    catch (error) { if (missing(error)) return []; throw error }
    const result: HistoryEntry[] = []
    for (const file of entries) {
      if (!file.endsWith('.md') || !validRevision(file.slice(0,-3))) continue
      const item = await this.read(this.root, ['history', id, file])
      if (item.revision !== file.slice(0,-3) || item.draft.id !== id) return fail('INVALID_HISTORY', 503)
      result.push({ revision: item.revision, savedAt: item.updatedAt, title: item.draft.title })
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }
  async historical(id: string, revision: string) {
    if (!validChapterId(id) || !validRevision(revision)) return fail('INVALID_HISTORY')
    try {
      const item = await this.read(this.root, ['history', id, `${revision}.md`])
      if (item.revision !== revision || item.draft.id !== id) return fail('INVALID_HISTORY', 503)
      return item.draft
    } catch (error) { if (missing(error)) return fail('HISTORY_NOT_FOUND',404); throw error }
  }
  async restore(id: string, revision: string, expectedRevision: unknown) {
    return this.withWriteLock(async () => this.saveLocked(await this.historical(id, revision), expectedRevision))
  }
  async archive(id: string, archived: boolean, expectedRevision: unknown) {
    return this.withWriteLock(async () => {
      const { revision, updatedAt, source, ...draft } = await this.get(id)
      return this.saveLocked({ ...draft, archived }, expectedRevision)
    })
  }
}
