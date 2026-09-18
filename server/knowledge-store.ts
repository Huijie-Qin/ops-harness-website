import { createHash, randomBytes } from 'node:crypto'
import { copyFile, lstat, readFile, rename, unlink } from 'node:fs/promises'
import { crc32, inflateRawSync } from 'node:zlib'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { parseDocument } from 'yaml'
import {
  maxKnowledgeEntries, maxKnowledgeId, maxSkillArchiveBytes, maxSkillArchiveEntries, maxSkillDescription,
  maxSkillFileBytes, maxSkillFileName, maxSkillName, maxTypicalIndicators, metricKnowledgeIdPattern, skillNamePattern,
  type MetricKnowledgeCatalog, type MetricKnowledgeEntry, type MetricKnowledgeSkill,
} from '../shared/knowledge.js'
import { GuideError, revisionOf } from './guide-store.js'
import { atomicJson, missing, readJson, receiveFile, safeDirectory, withLock } from './admin-files.js'

const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).optional()
const WorkflowSchema = z.object({ get_card_index: text(256), get_card_meta: text(256), quer_card_data: text(256) }).strict()
const KnowledgeIdSchema = z.object({ card_index_knowledge_base: text(256), card_meta_knowledge_base: text(256) }).strict()
const MetaSchema = z.object({
  knowledge_description: text(2000),
  indicators_cover: optionalText(80), reports_cover: optionalText(80), update_frequency: optionalText(80),
  typical_indicators: z.array(text(80)).max(maxTypicalIndicators).optional(),
}).strict()
const SkillSchema = z.object({
  name: z.string().max(maxSkillName).regex(skillNamePattern), file_name: text(maxSkillFileName),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(maxSkillFileBytes),
  kind: z.enum(['zip', 'md']), uploaded_at: z.string().datetime(),
}).strict()
const IdSchema = z.string().max(maxKnowledgeId).regex(metricKnowledgeIdPattern)
const InputSchema = z.object({
  id: IdSchema.optional(), tenant_name: text(80), tenant_id: text(128),
  knowledge_retrieve_workflow_id: WorkflowSchema, knowledge_id: KnowledgeIdSchema, knowledge_base_meta: MetaSchema,
  enabled: z.boolean(),
}).strict()
const EntrySchema = InputSchema.extend({
  id: IdSchema, skill: SkillSchema.optional(), created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict()
const DocumentSchema = z.object({ schemaVersion: z.literal(1), updatedAt: z.string().datetime(), skill: SkillSchema.optional(), items: z.array(EntrySchema).max(maxKnowledgeEntries) }).strict()
type CatalogDocument = z.infer<typeof DocumentSchema>
type KnowledgeInput = z.infer<typeof InputSchema>

const fail = (code: string, status = 400): never => { throw new GuideError(code, status) }
function parse<T>(schema: z.ZodType<T>, input: unknown, code = 'INVALID_KNOWLEDGE', status = 400): T {
  const result = schema.safeParse(input)
  if (!result.success) return fail(code, status)
  return result.data
}
// The stored document never contains its own hash; `revision` is derived from the normalized bytes.
const revisionOfDocument = (document: CatalogDocument) => revisionOf(JSON.stringify(document))
const emptyDocument: CatalogDocument = { schemaVersion: 1, updatedAt: new Date(0).toISOString(), items: [] }

export function parseSkillFrontmatter(bytes: Buffer): { name: string; description: string } {
  if (bytes.length > maxSkillFileBytes) return fail('INVALID_SKILL_FILE')
  const raw = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw)
  if (!match || match[1]!.length > 4096) return fail('INVALID_SKILL_FILE')
  let meta: Record<string, unknown>
  try {
    const parsed = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' })
    if (parsed.errors.length) return fail('INVALID_SKILL_FILE')
    meta = parsed.toJS({ maxAliasCount: 0 })
  } catch { return fail('INVALID_SKILL_FILE') }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fail('INVALID_SKILL_FILE')
  const name = meta.name, description = meta.description
  if (typeof name !== 'string' || name.length > maxSkillName || !skillNamePattern.test(name)) return fail('INVALID_SKILL_FILE')
  if (typeof description !== 'string' || !description.trim() || description.length > maxSkillDescription) return fail('INVALID_SKILL_FILE')
  return { name, description: description.trim() }
}

type ArchiveEntry = { name: string; method: number; compressed: number; size: number; crc: number; offset: number }
function archiveName(name: string) {
  if (!name || name.length > 255 || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)) return fail('INVALID_SKILL_FILE')
  const segments = name.split('/')
  if (segments.length > 16) return fail('INVALID_SKILL_FILE')
  segments.forEach((segment, index) => {
    if (segment === '.' || segment === '..') return fail('INVALID_SKILL_FILE')
    if (!segment && index !== segments.length - 1) return fail('INVALID_SKILL_FILE')
  })
  return name
}
// Minimal central-directory reader: stored and deflate only, no zip64, encryption, spanning or path escapes.
export function readArchive(bytes: Buffer): ArchiveEntry[] {
  if (bytes.length < 22 || bytes.length > maxSkillFileBytes) return fail('INVALID_SKILL_FILE')
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) return fail('INVALID_SKILL_FILE')
  if (eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length) return fail('INVALID_SKILL_FILE')
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === 0x07064b50) return fail('INVALID_SKILL_FILE')
  const disk = bytes.readUInt16LE(eocd + 4), start = bytes.readUInt16LE(eocd + 6)
  const local = bytes.readUInt16LE(eocd + 8), total = bytes.readUInt16LE(eocd + 10)
  const size = bytes.readUInt32LE(eocd + 12), offset = bytes.readUInt32LE(eocd + 16)
  if (disk !== 0 || start !== 0 || local !== total) return fail('INVALID_SKILL_FILE')
  if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) return fail('INVALID_SKILL_FILE')
  if (!total || total > maxSkillArchiveEntries || offset + size !== eocd) return fail('INVALID_SKILL_FILE')
  const entries: ArchiveEntry[] = []
  const names = new Set<string>()
  let cursor = offset, extracted = 0
  for (let index = 0; index < total; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) return fail('INVALID_SKILL_FILE')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), plain = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32)
    const entryDisk = bytes.readUInt16LE(cursor + 34), external = bytes.readUInt32LE(cursor + 38), header = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > eocd) return fail('INVALID_SKILL_FILE')
    if (flags & 0x1 || flags & 0x40 || flags & 0x2000) return fail('INVALID_SKILL_FILE')
    if (method !== 0 && method !== 8) return fail('INVALID_SKILL_FILE')
    if (entryDisk !== 0 || compressed === 0xffffffff || plain === 0xffffffff || header === 0xffffffff) return fail('INVALID_SKILL_FILE')
    if ((external >>> 16 & 0xf000) === 0xa000) return fail('INVALID_SKILL_FILE')
    const name = archiveName(bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength))
    const directory = name.endsWith('/')
    if (flags & 0x8 && !directory && (!compressed || !plain)) return fail('INVALID_SKILL_FILE')
    if (directory && plain) return fail('INVALID_SKILL_FILE')
    for (let extra = cursor + 46 + nameLength; extra + 4 <= cursor + 46 + nameLength + extraLength; extra += 4 + bytes.readUInt16LE(extra + 2)) {
      if (bytes.readUInt16LE(extra) === 0x0001) return fail('INVALID_SKILL_FILE')
    }
    if (names.has(name)) return fail('INVALID_SKILL_FILE')
    names.add(name)
    extracted += plain
    if (extracted > maxSkillArchiveBytes) return fail('INVALID_SKILL_FILE')
    if (header + 30 > offset) return fail('INVALID_SKILL_FILE')
    entries.push({ name, method, compressed, size: plain, crc, offset: header })
    cursor = next
  }
  if (cursor !== eocd) return fail('INVALID_SKILL_FILE')
  return entries
}
export function extractArchiveEntry(bytes: Buffer, entry: ArchiveEntry): Buffer {
  const at = entry.offset
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== 0x04034b50) return fail('INVALID_SKILL_FILE')
  const flags = bytes.readUInt16LE(at + 6), method = bytes.readUInt16LE(at + 8)
  const nameLength = bytes.readUInt16LE(at + 26), extraLength = bytes.readUInt16LE(at + 28)
  if (flags & 0x1 || method !== entry.method) return fail('INVALID_SKILL_FILE')
  if (bytes.toString('utf8', at + 30, at + 30 + nameLength) !== entry.name) return fail('INVALID_SKILL_FILE')
  const from = at + 30 + nameLength + extraLength
  if (from + entry.compressed > bytes.length) return fail('INVALID_SKILL_FILE')
  const raw = bytes.subarray(from, from + entry.compressed)
  let data: Buffer
  try { data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) }) }
  catch { return fail('INVALID_SKILL_FILE') }
  if (data.length !== entry.size || crc32(data) !== entry.crc) return fail('INVALID_SKILL_FILE')
  return data
}
// The archive must carry exactly one SKILL.md, at the root or directly inside the single top-level directory.
export function inspectSkillArchive(bytes: Buffer) {
  const entries = readArchive(bytes)
  const candidates = entries.filter(entry => entry.name.split('/').at(-1) === 'SKILL.md')
  if (candidates.length !== 1) return fail('INVALID_SKILL_FILE')
  const target = candidates[0]!
  const segments = target.name.split('/')
  if (segments.length > 2) return fail('INVALID_SKILL_FILE')
  const directory = segments.length === 2 ? segments[0]! : undefined
  if (directory && new Set(entries.map(entry => entry.name.split('/')[0])).size !== 1) return fail('INVALID_SKILL_FILE')
  const frontmatter = parseSkillFrontmatter(extractArchiveEntry(bytes, target))
  if (directory && directory !== frontmatter.name) return fail('INVALID_SKILL_FILE')
  return frontmatter
}

export class KnowledgeStore {
  readonly root: string
  readonly skills: string
  constructor(directory: string) { this.root = path.join(directory, 'knowledge'); this.skills = path.join(this.root, 'skills') }

  private async load(): Promise<CatalogDocument & { revision: string }> {
    let raw: unknown
    try { raw = await readJson(this.root, ['catalog.json'], 4 * 1024 ** 2) }
    catch (error) {
      if (missing(error)) return { ...emptyDocument, revision: revisionOfDocument(emptyDocument) }
      if (error instanceof GuideError) throw error
      return fail('CONTENT_UNAVAILABLE', 503)
    }
    const parsed = parse(DocumentSchema, raw, 'CONTENT_UNAVAILABLE', 503)
    // Catalogs written before the skill became catalog-wide carried one per entry; that field is ignored.
    const document: CatalogDocument = { ...parsed, items: parsed.items.map(stripLegacySkill) }
    if (new Set(document.items.map(item => item.id)).size !== document.items.length) return fail('CONTENT_UNAVAILABLE', 503)
    if (new Set(document.items.map(item => item.tenant_id)).size !== document.items.length) return fail('CONTENT_UNAVAILABLE', 503)
    return { ...document, revision: revisionOfDocument(document) }
  }
  private async backup() {
    const trash = path.join(this.root, '.trash')
    try { await lstat(path.join(this.root, 'catalog.json')) } catch (error) { if (missing(error)) return; throw error }
    await safeDirectory(trash)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(path.join(this.root, 'catalog.json'), path.join(trash, `catalog-${stamp}.json`))
  }
  private async commit(items: MetricKnowledgeEntry[], skill: MetricKnowledgeSkill | undefined, destructive: boolean) {
    const document = parse(DocumentSchema, { schemaVersion: 1, updatedAt: new Date().toISOString(), ...(skill ? { skill } : {}), items })
    if (destructive) await this.backup()
    await atomicJson(this.root, 'catalog.json', document)
    return { ...document, revision: revisionOfDocument(document) }
  }
  private change<T>(expected: unknown, action: (current: CatalogDocument & { revision: string }) => Promise<T>) {
    return withLock(this.root, '.knowledge-lock', async () => {
      const current = await this.load()
      if (current.revision !== expected) return fail('REVISION_CONFLICT', 409)
      return action(current)
    })
  }
  private found(document: CatalogDocument, id: string) {
    const entry = document.items.find(item => item.id === id)
    if (!entry) return fail('KNOWLEDGE_NOT_FOUND', 404)
    return entry
  }
  private async replace(current: CatalogDocument & { revision: string }, entry: MetricKnowledgeEntry, destructive: boolean) {
    const document = await this.commit(current.items.map(item => item.id === entry.id ? entry : item), current.skill, destructive)
    return { revision: document.revision, updatedAt: document.updatedAt, entry: this.found(document, entry.id) }
  }

  async list(): Promise<MetricKnowledgeCatalog> {
    const { revision, ...document } = await this.load()
    return { schemaVersion: 1, revision, updatedAt: document.updatedAt, ...(document.skill ? { skill: document.skill } : {}), items: document.items }
  }
  async publicList(): Promise<MetricKnowledgeCatalog> {
    const catalog = await this.list()
    return { ...catalog, items: catalog.items.filter(item => item.enabled) }
  }
  async create(input: unknown, expected: unknown) {
    const value: KnowledgeInput = parse(InputSchema, input)
    return this.change(expected, async current => {
      if (current.items.length >= maxKnowledgeEntries) return fail('KNOWLEDGE_LIMIT', 409)
      const { id: requested, ...rest } = value
      let id = requested
      if (!id) do { id = `metrics-${randomBytes(5).toString('hex')}` } while (current.items.some(item => item.id === id))
      if (current.items.some(item => item.id === id)) return fail('KNOWLEDGE_ID_TAKEN', 409)
      if (current.items.some(item => item.tenant_id === value.tenant_id)) return fail('TENANT_ID_TAKEN', 409)
      const now = new Date().toISOString()
      const document = await this.commit([...current.items, { id, ...rest, created_at: now, updated_at: now }], current.skill, false)
      return { revision: document.revision, updatedAt: document.updatedAt, entry: this.found(document, id) }
    })
  }
  async update(id: string, input: unknown, expected: unknown) {
    const value: KnowledgeInput = parse(InputSchema, input)
    parse(IdSchema, id)
    // The identifier is part of the public contract and never changes after creation.
    if (value.id !== undefined && value.id !== id) return fail('INVALID_KNOWLEDGE')
    return this.change(expected, async current => {
      const previous = this.found(current, id)
      if (current.items.some(item => item.id !== id && item.tenant_id === value.tenant_id)) return fail('TENANT_ID_TAKEN', 409)
      const { id: ignored, ...rest } = value
      return this.replace(current, { id, ...rest, created_at: previous.created_at, updated_at: new Date().toISOString() }, true)
    })
  }
  async remove(id: string, expected: unknown) {
    parse(IdSchema, id)
    return this.change(expected, async current => {
      this.found(current, id)
      // The shared skill file is catalog-wide and stays; other entries keep using it.
      const document = await this.commit(current.items.filter(item => item.id !== id), current.skill, true)
      return { revision: document.revision, updatedAt: document.updatedAt }
    })
  }
  /** Attach the catalog-wide companion Skill; every bound library installs this one file. */
  async attachSkill(name: string, req: IncomingMessage, expected: unknown) {
    if (unsafeFileName(name)) return fail('INVALID_SKILL_FILE')
    const kind = /\.zip$/i.test(name) ? 'zip' as const : /\.md$/i.test(name) ? 'md' as const : fail('INVALID_SKILL_FILE')
    await safeDirectory(this.root); await safeDirectory(this.skills)
    const file = await receiveFile(req, this.skills, maxSkillFileBytes)
    try {
      const bytes = await readFile(file.temp)
      const skill = kind === 'zip' ? inspectSkillArchive(bytes) : parseSkillFrontmatter(bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const stored = `${sha256}.${kind}`
      return await this.change(expected, async current => {
        // Content-addressed and immutable: an identical file is reused, never rewritten.
        try {
          const info = await lstat(path.join(this.skills, stored))
          if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) return fail('CONTENT_UNAVAILABLE', 503)
        } catch (error) { if (!missing(error)) throw error; await rename(file.temp, path.join(this.skills, stored)) }
        const value: MetricKnowledgeSkill = { name: skill.name, file_name: name, sha256, size: file.size, kind, uploaded_at: new Date().toISOString() }
        const document = await this.commit(current.items, value, Boolean(current.skill))
        return { revision: document.revision, updatedAt: document.updatedAt, skill: document.skill }
      })
    } finally { await unlink(file.temp).catch(error => { if (!missing(error)) throw error }) }
  }
  async detachSkill(expected: unknown) {
    return this.change(expected, async current => {
      if (!current.skill) return fail('SKILL_NOT_FOUND', 404)
      const document = await this.commit(current.items, undefined, true)
      return { revision: document.revision, updatedAt: document.updatedAt }
    })
  }
  async openSkill() {
    const document = await this.load()
    if (!document.skill) return fail('SKILL_NOT_FOUND', 404)
    const { name, sha256, size, kind, file_name: fileName } = document.skill
    return {
      root: this.root, segments: ['skills', `${sha256}.${kind}`], size, sha256, name, fileName,
      type: kind === 'zip' ? 'application/zip' : 'text/markdown; charset=utf-8',
    }
  }
}

function stripLegacySkill(entry: MetricKnowledgeEntry & { skill?: unknown }): MetricKnowledgeEntry {
  const { skill: _legacy, ...rest } = entry
  return rest
}

function unsafeFileName(name: string): boolean {
  return !name || name.length > maxSkillFileName || [...name].some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32)
}
