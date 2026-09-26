import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import {
  AppearanceSchema, BUILTIN_CAPABILITIES, BUILTIN_TOOLS, BUILTIN_TOOL_IDS, BuiltinCapabilitySchema, CONTRACT_VERSION,
  CATALOG_SCHEMA_VERSION, CUSTOM_TOOL_KEY_PATTERN, CustomToolDefinitionSchema, EXPERT_CATEGORY_IDS, EXPERT_ID_PATTERN, EXPERT_LIMITS,
  ExpertPackageDefinitionSchema, ExpertPackageManifestSchema, KnowledgeRefSchema, OwnerSchema, PACKAGE_DEFINITION_FILE,
  PACKAGE_MANIFEST_FILE, PACKAGE_RESPONSIBILITY_FILE, RESERVED_SKILL_NAMES, RESERVED_SKILL_PREFIX, SKILL_NAME_PATTERN, ToolRefSchema,
  VisibilitySchema, customToolPortabilityIssues, hasControlCharacters, isExpertVisible, presetIdForCloudExpert, responsibilityIssue,
  type CloudCustomTool, type CloudExpert, type CustomToolDefinition, type ExpertPackageDefinition, type ExpertVisibility,
  type KnowledgeRef, type ToolRef,
} from '@dsh-ops/expert-distribution-contract'
import { GuideError, revisionOf } from './guide-store.js'
import { atomicJson, missing, readJson, receiveFile, safeDirectory, withLock } from './admin-files.js'
import { extractArchiveEntry, inspectSkillArchive, parseSkillFrontmatter, readArchive, type ArchiveEntry, type KnowledgeStore } from './knowledge-store.js'
import { maxSkillFileName } from '../shared/knowledge.js'

/** Validation failure with the individual problems the admin page lists next to the form. */
export class ExpertValidationError extends GuideError {
  constructor(code: string, readonly issues: string[], status = 400) { super(code, status) }
}
const fail = (code: string, status = 400): never => { throw new GuideError(code, status) }
const invalid = (issues: string[], code = 'INVALID_EXPERT'): never => { throw new ExpertValidationError(code, issues) }

const text = (max: number) => z.string().trim().max(max).refine(value => !hasControlCharacters(value), '包含控制字符')
const DraftSkillSchema = z.object({
  name: z.string().max(64).regex(SKILL_NAME_PATTERN),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(EXPERT_LIMITS.skillBytes),
  kind: z.enum(['zip', 'md']),
  required: z.boolean(),
  fileName: z.string().max(maxSkillFileName).optional(),
}).strict()
/** A draft may be unfinished (empty responsibility, no owner yet); publishing applies the full rules. */
const DraftSchema = z.object({
  name: text(EXPERT_LIMITS.nameLength),
  summary: text(EXPERT_LIMITS.summaryLength),
  appearance: AppearanceSchema,
  categoryIds: z.array(z.string().regex(EXPERT_ID_PATTERN)).max(EXPERT_LIMITS.categories),
  tags: z.array(text(EXPERT_LIMITS.tagLength).pipe(z.string().min(1))).max(EXPERT_LIMITS.tags),
  starterPrompts: z.array(text(EXPERT_LIMITS.starterPromptLength).pipe(z.string().min(1))).max(EXPERT_LIMITS.starterPrompts),
  sortOrder: z.number().int().min(0).max(100_000),
  builtinTools: z.array(BuiltinCapabilitySchema).max(BUILTIN_CAPABILITIES.length),
  responsibility: z.string().max(EXPERT_LIMITS.responsibilityBytes),
  skills: z.array(DraftSkillSchema).max(EXPERT_LIMITS.skills),
  tools: z.array(ToolRefSchema).max(EXPERT_LIMITS.tools),
  knowledge: z.array(KnowledgeRefSchema).max(EXPERT_LIMITS.knowledge),
  owner: OwnerSchema.optional(),
}).strict()
export type ExpertDraft = z.infer<typeof DraftSchema>
const DistributionSchema = z.object({
  status: z.enum(['active', 'disabled']),
  visibility: VisibilitySchema,
  allowClone: z.boolean(),
}).strict()
export type ExpertDistribution = z.infer<typeof DistributionSchema>
const RecordSchema = z.object({
  id: z.string().regex(EXPERT_ID_PATTERN),
  draft: DraftSchema,
  distribution: DistributionSchema,
  published: z.object({ version: z.number().int().positive(), publishedAt: z.string().datetime(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  importedFrom: z.object({ expertId: z.string().max(80), employeeId: z.string().max(64).optional(), importedAt: z.string().datetime() }).strict().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()
export type ExpertRecord = z.infer<typeof RecordSchema>
const DocumentSchema = z.object({ schemaVersion: z.literal(1), updatedAt: z.string().datetime(), experts: z.array(RecordSchema).max(EXPERT_LIMITS.experts) }).strict()
type ExpertDocument = z.infer<typeof DocumentSchema>
const SnapshotSchema = z.object({ id: z.string().regex(EXPERT_ID_PATTERN), version: z.number().int().positive(), publishedAt: z.string().datetime(), content: DraftSchema }).strict()
type Snapshot = z.infer<typeof SnapshotSchema>
const emptyDocument: ExpertDocument = { schemaVersion: 1, updatedAt: new Date(0).toISOString(), experts: [] }

/**
 * One entry of the custom tool library (`tools.json`): a portable MCP connection several experts may reference.
 * It holds credential slots (names and how to obtain them), never a value. Saving it takes effect at once.
 */
const ToolRecordSchema = z.object({
  definition: CustomToolDefinitionSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  importedFrom: z.object({ employeeId: z.string().max(64).optional(), importedAt: z.string().datetime() }).strict().optional(),
}).strict()
export type ToolRecord = z.infer<typeof ToolRecordSchema>
const ToolDocumentSchema = z.object({ schemaVersion: z.literal(1), updatedAt: z.string().datetime(), tools: z.array(ToolRecordSchema).max(EXPERT_LIMITS.toolLibrary) }).strict()
type ToolDocument = z.infer<typeof ToolDocumentSchema>
const emptyTools: ToolDocument = { schemaVersion: 1, updatedAt: new Date(0).toISOString(), tools: [] }
/** What the admin may change in a library entry: wording, address or command, timeout. Structure stays. */
const ToolEditSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300).optional(),
  url: z.string().trim().max(2048).optional(),
  command: z.string().trim().max(64).optional(),
  args: z.array(z.string().max(2048)).max(64).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000),
  credentials: z.array(z.object({ key: z.string(), label: z.string().trim().min(1).max(40), hint: z.string().trim().max(200).optional() }).strict()).max(EXPERT_LIMITS.credentialSlots),
}).strict()
/** How the admin resolves a package tool whose server name the library already uses with another configuration. */
export type ToolChoice = 'update' | 'rename'
export interface ImportToolRow {
  /** Key inside the package. */
  key: string
  name: string
  transport: 'stdio' | 'streamable-http'
  serverName: string
  url?: string
  command?: string
  args: string[]
  credentials: Array<{ key: string; label: string; hint?: string; location: { kind: 'header' | 'env'; name: string } }>
  /** `new`: added to the library; `reuse`: the library already has exactly this tool; `conflict`: same server name, other configuration. */
  resolution: 'new' | 'reuse' | 'conflict'
  /** Library key the expert will reference (for a conflict: the existing entry an update replaces). */
  libraryKey: string
  /** What “改名后新增” would create. */
  rename?: { key: string; serverName: string }
  /** Published experts that already use the existing entry (an update changes it for them too). */
  affected?: Array<{ id: string; name: string }>
  warnings: string[]
}

const packageLimits = { maxBytes: EXPERT_LIMITS.packageBytes, maxEntries: EXPERT_LIMITS.packageEntries, maxExtractedBytes: EXPERT_LIMITS.packageBytes, code: 'INVALID_EXPERT_PACKAGE' }
const IMPORT_TTL_MS = 24 * 60 * 60 * 1000
/** Path words of the admin API that an expert id may not take. */
const RESERVED_IDS = new Set(['options', 'import'])
const MAX_PENDING_IMPORTS = 20

export type ImportTarget = { mode: 'create'; id: string } | { mode: 'update'; id: string }
export interface ImportPreview {
  importId: string
  expiresAt: string
  origin: { expertId: string; employeeId?: string; exportedAt: string; appVersion?: string }
  expert: { name: string; summary: string; owner: { name: string; employeeId: string; contact?: string | undefined }; categoryIds: string[]; builtinTools: string[]; releaseNote?: string }
  skills: Array<{ name: string; size: number; required: boolean }>
  tools: Array<{ toolId?: string; customTool?: string; name: string; required: boolean; known: boolean }>
  customTools: ImportToolRow[]
  knowledge: Array<KnowledgeRef & { status: 'ok' | 'missing' | 'disabled' | 'unsynced'; label: string }>
  suggestedAllowlist: string[]
  target: ImportTarget
  existing?: { id: string; name: string; published?: { version: number } }
  changes?: { responsibility: boolean; skills: { added: string[]; removed: string[]; updated: string[] }; tools: { added: string[]; removed: string[] }; knowledge: { added: string[]; removed: string[] }; owner: boolean; basics: boolean }
  warnings: string[]
  errors: string[]
}
interface ParsedPackage {
  manifest: z.infer<typeof ExpertPackageManifestSchema>
  definition: ExpertPackageDefinition
  responsibility: string
  skills: Map<string, { bytes: Buffer; sha256: string }>
}

const BOM_PREFIX = new RegExp('^' + String.fromCharCode(0xfeff))
function digestOf(value: unknown): string { return revisionOf(JSON.stringify(value)) }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function unique<T>(values: readonly T[]) { return new Set(values).size === values.length }
function utf8Size(value: string) { return Buffer.byteLength(value, 'utf8') }
function knowledgeKey(ref: KnowledgeRef) { return ref.kind === 'metric' ? `metric:${ref.knowledgeId}` : `onebox:${ref.ref}` }
function knowledgeLabel(ref: KnowledgeRef) { return ref.kind === 'metric' ? ref.name ?? ref.knowledgeId : ref.name }
function toolKey(ref: ToolRef) { return 'toolId' in ref ? ref.toolId : `custom:${ref.customTool}` }
/** Library revision of a definition: the digest of its content (a re-save without change keeps it). */
function toolRevision(definition: CustomToolDefinition) { return sha256(Buffer.from(JSON.stringify(definition), 'utf8')) }
/** Same service configuration, the key aside (names, slots and wording included: anything a user would see). */
function sameTool(left: CustomToolDefinition, right: CustomToolDefinition) {
  const { key: _left, ...a } = left, { key: _right, ...b } = right
  return JSON.stringify(a) === JSON.stringify(b)
}
function toolWarnings(definition: CustomToolDefinition) {
  return customToolPortabilityIssues(definition).filter(issue => issue.severity === 'warning').map(issue => issue.message)
}
function toolName(ref: ToolRef) { return 'toolId' in ref ? BUILTIN_TOOLS.find(tool => tool.id === ref.toolId)?.name ?? ref.toolId : ref.customTool }
function parse<T>(schema: z.ZodType<T>, input: unknown, code = 'INVALID_EXPERT'): T {
  const result = schema.safeParse(input)
  if (!result.success) return invalid(result.error.issues.slice(0, 12).map(issue => `${issue.path.join('.') || '内容'}：${issue.message}`), code)
  return result.data
}

export class ExpertStore {
  readonly root: string
  readonly skills: string
  readonly versions: string
  readonly imports: string
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly toolLibrary: string
  constructor(directory: string, private readonly knowledge?: KnowledgeStore, private readonly now: () => number = Date.now) {
    this.root = path.join(directory, 'experts')
    this.skills = path.join(this.root, 'skills')
    this.versions = path.join(this.root, 'versions')
    this.imports = path.join(this.root, 'imports')
    this.toolLibrary = 'tools.json'
  }

  // ---- Custom tool library -----------------------------------------------------------------------

  private async loadTools(): Promise<ToolDocument & { revision: string }> {
    let raw: unknown
    try { raw = await readJson(this.root, [this.toolLibrary], 4 * 1024 ** 2) }
    catch (error) {
      if (missing(error)) return { ...emptyTools, revision: digestOf(emptyTools) }
      if (error instanceof GuideError) throw error
      return fail('CONTENT_UNAVAILABLE', 503)
    }
    const parsed = ToolDocumentSchema.safeParse(raw)
    if (!parsed.success) return fail('CONTENT_UNAVAILABLE', 503)
    const tools = parsed.data.tools
    if (!unique(tools.map(tool => tool.definition.key)) || !unique(tools.map(tool => tool.definition.serverName.toLowerCase()))) return fail('CONTENT_UNAVAILABLE', 503)
    return { ...parsed.data, revision: digestOf(parsed.data) }
  }
  private async commitTools(tools: ToolRecord[], destructive: boolean) {
    const document = ToolDocumentSchema.parse({ schemaVersion: 1, updatedAt: new Date(this.now()).toISOString(), tools: [...tools].sort((a, b) => a.definition.key.localeCompare(b.definition.key)) })
    await safeDirectory(this.root)
    if (destructive) {
      try {
        await lstat(path.join(this.root, this.toolLibrary))
        const trash = path.join(this.root, '.trash')
        await safeDirectory(trash)
        await copyFile(path.join(this.root, this.toolLibrary), path.join(trash, `tools-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`))
      } catch (error) { if (!missing(error)) throw error }
    }
    await atomicJson(this.root, this.toolLibrary, document)
    return { ...document, revision: digestOf(document) }
  }
  /** Experts whose draft or current published version references a library key. */
  private async toolUsage(document: ExpertDocument) {
    const usage = new Map<string, Array<{ id: string; name: string; draft: boolean; published: boolean }>>()
    for (const record of document.experts) {
      const drafted = new Set(record.draft.tools.flatMap(ref => 'customTool' in ref ? [ref.customTool] : []))
      const published = new Set<string>()
      if (record.published) {
        for (const ref of (await this.snapshot(record.id, record.published.version)).content.tools) if ('customTool' in ref) published.add(ref.customTool)
      }
      for (const key of new Set([...drafted, ...published])) {
        const rows = usage.get(key) ?? []
        rows.push({ id: record.id, name: record.draft.name, draft: drafted.has(key), published: published.has(key) && record.distribution.status === 'active' })
        usage.set(key, rows)
      }
    }
    return usage
  }
  private toolView(record: ToolRecord, usage: Array<{ id: string; name: string; draft: boolean; published: boolean }>) {
    return { ...record.definition, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.importedFrom ? { importedFrom: record.importedFrom } : {}), usage }
  }
  async listTools() {
    const [tools, document] = await Promise.all([this.loadTools(), this.load()])
    const usage = await this.toolUsage(document)
    return { revision: tools.revision, tools: tools.tools.map(record => this.toolView(record, usage.get(record.definition.key) ?? [])) }
  }
  /** Change a library entry's wording, address or command; it reaches every expert using it at the next sync. */
  async updateTool(key: string, input: unknown, expected: unknown) {
    if (!CUSTOM_TOOL_KEY_PATTERN.test(key)) return fail('EXPERT_TOOL_NOT_FOUND', 404)
    const edit = parse(ToolEditSchema, input, 'INVALID_EXPERT_TOOL')
    return withLock(this.root, '.experts-lock', async () => {
      const current = await this.loadTools()
      if (current.revision !== expected) return fail('REVISION_CONFLICT', 409)
      const record = current.tools.find(item => item.definition.key === key) ?? fail('EXPERT_TOOL_NOT_FOUND', 404)
      const previous = record.definition
      const labels = new Map(edit.credentials.map(slot => [slot.key, slot]))
      if (labels.size !== previous.credentials.length || previous.credentials.some(slot => !labels.has(slot.key))) return invalid(['凭据项只能修改名称与获取说明，不能增减'], 'INVALID_EXPERT_TOOL')
      const candidate = {
        ...previous,
        name: edit.name,
        ...(edit.description ? { description: edit.description } : {}),
        ...(previous.transport === 'streamable-http' ? { url: edit.url ?? previous.url } : { command: edit.command ?? previous.command, args: edit.args ?? previous.args }),
        timeoutMs: edit.timeoutMs,
        credentials: previous.credentials.map((slot) => {
          const { hint: _hint, ...rest } = slot
          const next = labels.get(slot.key)!
          return { ...rest, label: next.label, ...(next.hint ? { hint: next.hint } : {}) }
        }),
      }
      if (!edit.description) delete (candidate as { description?: string }).description
      const definition = parse(CustomToolDefinitionSchema, candidate, 'INVALID_EXPERT_TOOL')
      const revision = toolRevision(definition)
      if (revision === record.revision) return { revision: current.revision, tool: this.toolView(record, (await this.toolUsage(await this.load())).get(key) ?? []) }
      const next: ToolRecord = { ...record, definition, revision, updatedAt: new Date(this.now()).toISOString() }
      const document = await this.commitTools(current.tools.map(item => item.definition.key === key ? next : item), true)
      return { revision: document.revision, tool: this.toolView(next, (await this.toolUsage(await this.load())).get(key) ?? []) }
    })
  }
  /** Remove an entry no expert references (drafts included); the previous library is kept in `.trash`. */
  async removeTool(key: string, expected: unknown) {
    if (!CUSTOM_TOOL_KEY_PATTERN.test(key)) return fail('EXPERT_TOOL_NOT_FOUND', 404)
    return withLock(this.root, '.experts-lock', async () => {
      const current = await this.loadTools()
      if (current.revision !== expected) return fail('REVISION_CONFLICT', 409)
      if (!current.tools.some(item => item.definition.key === key)) return fail('EXPERT_TOOL_NOT_FOUND', 404)
      const users = (await this.toolUsage(await this.load())).get(key) ?? []
      if (users.length) throw new ExpertValidationError('EXPERT_TOOL_IN_USE', users.map(user => `「${user.name}」（${user.id}）${user.published ? '已发布版本' : '草稿'}仍在使用`), 409)
      const document = await this.commitTools(current.tools.filter(item => item.definition.key !== key), true)
      return { revision: document.revision }
    })
  }
  /** Custom tool references of a draft must name library entries. */
  private async assertToolRefs(draft: ExpertDraft) {
    const refs = draft.tools.flatMap(ref => 'customTool' in ref ? [ref.customTool] : [])
    if (!refs.length) return
    const keys = new Set((await this.loadTools()).tools.map(tool => tool.definition.key))
    const unknown = refs.filter(key => !keys.has(key))
    if (unknown.length) invalid(unknown.map(key => `自定义工具 ${key} 不在官网工具库中`))
  }
  /**
   * Match a package's custom tools against the library by server name: identical → reuse, absent → add, same name
   * with another configuration → the admin's choice (update the entry for everyone, or add it under a new name).
   */
  private async resolveTools(parsed: ParsedPackage, library: ToolDocument, experts: ExpertDocument, choices: Record<string, ToolChoice> = {}) {
    const rows: ImportToolRow[] = [], errors: string[] = [], missingChoices: string[] = [], writes: ToolRecord[] = []
    const mapping = new Map<string, string>()
    const usage = await this.toolUsage(experts)
    const takenKeys = new Set(library.tools.map(tool => tool.definition.key))
    const takenServers = new Set(library.tools.map(tool => tool.definition.serverName.toLowerCase()))
    const now = new Date(this.now()).toISOString()
    const importedFrom = { ...(parsed.manifest.origin.employeeId ? { employeeId: parsed.manifest.origin.employeeId } : {}), importedAt: now }
    const freshKey = (base: string) => {
      let candidate = base, index = 2
      while (takenKeys.has(candidate)) candidate = `${base.slice(0, 36)}-${index++}`
      takenKeys.add(candidate)
      return candidate
    }
    const freshServer = (base: string) => {
      let candidate = base, index = 2
      while (takenServers.has(candidate.toLowerCase())) candidate = `${base.slice(0, 29)}_${index++}`
      takenServers.add(candidate.toLowerCase())
      return candidate
    }
    for (const tool of parsed.definition.customTools) {
      const base = {
        key: tool.key, name: tool.name, transport: tool.transport, serverName: tool.serverName,
        ...(tool.url === undefined ? {} : { url: tool.url }), ...(tool.command === undefined ? {} : { command: tool.command }), args: tool.args,
        credentials: tool.credentials.map(slot => ({ key: slot.key, label: slot.label, ...(slot.hint ? { hint: slot.hint } : {}), location: slot.location })),
        warnings: toolWarnings(tool),
      }
      const existing = library.tools.find(item => item.definition.serverName.toLowerCase() === tool.serverName.toLowerCase())
      if (!existing) {
        const key = freshKey(tool.key)
        takenServers.add(tool.serverName.toLowerCase())
        const definition = { ...tool, key }
        writes.push({ definition, revision: toolRevision(definition), createdAt: now, updatedAt: now, importedFrom })
        mapping.set(tool.key, key)
        rows.push({ ...base, resolution: 'new', libraryKey: key })
        continue
      }
      const libraryKey = existing.definition.key
      if (sameTool(existing.definition, tool)) {
        mapping.set(tool.key, libraryKey)
        rows.push({ ...base, resolution: 'reuse', libraryKey })
        continue
      }
      const affected = (usage.get(libraryKey) ?? []).filter(user => user.published).map(user => ({ id: user.id, name: user.name }))
      const renameKey = freshKey(`${tool.key}-2`.slice(0, 41))
      const renameServer = freshServer(`${tool.serverName.slice(0, 30)}_2`)
      rows.push({ ...base, resolution: 'conflict', libraryKey, rename: { key: renameKey, serverName: renameServer }, affected })
      const choice = choices[tool.key]
      if (choice === 'update') {
        const definition = { ...tool, key: libraryKey }
        writes.push({ ...existing, definition, revision: toolRevision(definition), updatedAt: now, importedFrom })
        mapping.set(tool.key, libraryKey)
      } else if (choice === 'rename') {
        const definition = { ...tool, key: renameKey, serverName: renameServer }
        writes.push({ definition, revision: toolRevision(definition), createdAt: now, updatedAt: now, importedFrom })
        mapping.set(tool.key, renameKey)
      } else {
        missingChoices.push(`工具「${tool.name}」与工具库中的「${existing.definition.name}」服务名相同（${tool.serverName}）但配置不同，请选择“更新已有工具”或“改名后新增”`)
      }
    }
    if (library.tools.length + writes.filter(write => !library.tools.some(item => item.definition.key === write.definition.key)).length > EXPERT_LIMITS.toolLibrary) {
      errors.push(`工具库已达到 ${EXPERT_LIMITS.toolLibrary} 个上限，请先整理`)
    }
    return { rows, errors, missingChoices, writes, mapping }
  }

  private async load(): Promise<ExpertDocument & { revision: string }> {
    let raw: unknown
    try { raw = await readJson(this.root, ['catalog.json'], 8 * 1024 ** 2) }
    catch (error) {
      if (missing(error)) return { ...emptyDocument, revision: digestOf(emptyDocument) }
      if (error instanceof GuideError) throw error
      return fail('CONTENT_UNAVAILABLE', 503)
    }
    const parsed = DocumentSchema.safeParse(raw)
    if (!parsed.success) return fail('CONTENT_UNAVAILABLE', 503)
    if (!unique(parsed.data.experts.map(item => item.id))) return fail('CONTENT_UNAVAILABLE', 503)
    return { ...parsed.data, revision: digestOf(parsed.data) }
  }
  private async commit(experts: ExpertRecord[], destructive: boolean) {
    const document = DocumentSchema.parse({ schemaVersion: 1, updatedAt: new Date(this.now()).toISOString(), experts })
    if (destructive) await this.backup()
    await atomicJson(this.root, 'catalog.json', document)
    return { ...document, revision: digestOf(document) }
  }
  private async backup() {
    try { await lstat(path.join(this.root, 'catalog.json')) } catch (error) { if (missing(error)) return; throw error }
    const trash = path.join(this.root, '.trash')
    await safeDirectory(trash)
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    await copyFile(path.join(this.root, 'catalog.json'), path.join(trash, `catalog-${stamp}-${randomBytes(3).toString('hex')}.json`))
  }
  private change<T>(expected: unknown, action: (current: ExpertDocument & { revision: string }) => Promise<T>) {
    return withLock(this.root, '.experts-lock', async () => {
      const current = await this.load()
      if (current.revision !== expected) return fail('REVISION_CONFLICT', 409)
      return action(current)
    })
  }
  private found(document: ExpertDocument, id: string): ExpertRecord {
    const record = document.experts.find(item => item.id === id)
    if (!record) return fail('EXPERT_NOT_FOUND', 404)
    return record
  }
  private async replaceRecord(current: ExpertDocument, record: ExpertRecord, destructive = true) {
    const document = await this.commit(current.experts.map(item => item.id === record.id ? record : item), destructive)
    return { revision: document.revision, expert: this.view(this.found(document, record.id)) }
  }
  private view(record: ExpertRecord) {
    return { ...record, presetId: presetIdForCloudExpert(record.id), draftChanged: record.published?.digest !== digestOf(record.draft) }
  }
  private summary(record: ExpertRecord) {
    const visibility = record.distribution.visibility
    return {
      id: record.id, name: record.draft.name, summary: record.draft.summary, status: record.distribution.status,
      ...(record.published ? { published: { version: record.published.version, publishedAt: record.published.publishedAt } } : {}),
      draftChanged: record.published?.digest !== digestOf(record.draft),
      visibility: visibility.mode === 'everyone' ? { mode: 'everyone' as const } : { mode: 'allowlist' as const, count: visibility.employeeIds.length },
      ...(record.draft.owner ? { owner: record.draft.owner } : {}),
      ...(record.importedFrom ? { importedFrom: record.importedFrom } : {}),
      updatedAt: record.updatedAt,
    }
  }

  async list() {
    const document = await this.load()
    return { revision: document.revision, updatedAt: document.updatedAt, experts: document.experts.map(record => this.summary(record)) }
  }
  async get(id: string) {
    const document = await this.load()
    return { revision: document.revision, expert: this.view(this.found(document, id)) }
  }
  /** Form choices: the product's built-in tools, the custom tool library, and the website's metric knowledge catalog. */
  async options() {
    const metrics = this.knowledge ? (await this.knowledge.list()).items.map(item => ({ id: item.id, name: `${item.tenant_name}指标知识库`, enabled: item.enabled })) : []
    const customTools = (await this.loadTools()).tools.map(tool => ({ key: tool.definition.key, name: tool.definition.name, serverName: tool.definition.serverName, transport: tool.definition.transport }))
    return { tools: BUILTIN_TOOLS, capabilities: BUILTIN_CAPABILITIES, metrics, customTools }
  }

  async create(input: unknown, expected: unknown) {
    const request = z.object({ id: z.string().regex(EXPERT_ID_PATTERN).optional(), draft: z.unknown() }).strict().safeParse(input)
    if (!request.success) return invalid(['请求格式无效'])
    const draft = parse(DraftSchema, request.data.draft)
    return this.change(expected, async current => {
      if (current.experts.length >= EXPERT_LIMITS.experts) return fail('EXPERT_LIMIT', 409)
      let id = request.data.id
      if (!id) do { id = `expert-${randomBytes(3).toString('hex')}` } while (current.experts.some(item => item.id === id))
      if (current.experts.some(item => item.id === id) || RESERVED_IDS.has(id)) return fail('EXPERT_ID_TAKEN', 409)
      await this.assertDraftSkills(draft, [])
      await this.assertToolRefs(draft)
      const now = new Date(this.now()).toISOString()
      const record: ExpertRecord = { id, draft, distribution: { status: 'disabled', visibility: { mode: 'allowlist', employeeIds: [] }, allowClone: true }, createdAt: now, updatedAt: now }
      const document = await this.commit([...current.experts, record], false)
      return { revision: document.revision, expert: this.view(this.found(document, id)) }
    })
  }
  async saveDraft(id: string, input: unknown, expected: unknown) {
    const draft = parse(DraftSchema, input)
    return this.change(expected, async current => {
      const record = this.found(current, id)
      // Skills enter a draft only by upload or import; a save may reorder, re-flag or drop them.
      await this.assertDraftSkills(draft, record.draft.skills)
      await this.assertToolRefs(draft)
      return this.replaceRecord(current, { ...record, draft, updatedAt: new Date(this.now()).toISOString() })
    })
  }
  async remove(id: string, expected: unknown) {
    return this.change(expected, async current => {
      const record = this.found(current, id)
      const trash = path.join(this.root, '.trash')
      await safeDirectory(trash)
      await atomicJson(trash, `expert-${id}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`, record)
      const document = await this.commit(current.experts.filter(item => item.id !== id), true)
      return { revision: document.revision }
    })
  }
  async setDistribution(id: string, input: unknown, expected: unknown) {
    const distribution = parse(DistributionSchema, input)
    if (distribution.visibility.mode === 'allowlist' && !unique(distribution.visibility.employeeIds)) return invalid(['可见范围中有重复工号'])
    return this.change(expected, async current => {
      const record = this.found(current, id)
      if (distribution.status === 'active' && !record.published) return fail('EXPERT_NOT_PUBLISHED', 409)
      return this.replaceRecord(current, { ...record, distribution, updatedAt: new Date(this.now()).toISOString() })
    })
  }
  async publish(id: string, expected: unknown) {
    return this.change(expected, async current => {
      const record = this.found(current, id)
      if (record.published?.digest === digestOf(record.draft)) return fail('NOTHING_TO_PUBLISH', 409)
      const next = await this.publishRecord(record)
      return this.replaceRecord(current, next)
    })
  }
  /** Validate the draft with the publishing rules, write the immutable snapshot and put the expert on sale. */
  private async publishRecord(record: ExpertRecord): Promise<ExpertRecord> {
    await this.assertPublishable(record.draft)
    const version = (record.published?.version ?? 0) + 1
    const publishedAt = new Date(this.now()).toISOString()
    const snapshot: Snapshot = { id: record.id, version, publishedAt, content: record.draft }
    const directory = path.join(this.versions, record.id)
    await safeDirectory(this.versions); await safeDirectory(directory)
    const file = path.join(directory, `${version}.json`)
    const temp = path.join(directory, `.${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    // Published versions are immutable: never replace an existing snapshot.
    try { await lstat(file); await unlink(temp); return fail('CONTENT_UNAVAILABLE', 503) } catch (error) { if (error instanceof GuideError) throw error; if (!missing(error)) throw error }
    await rename(temp, file)
    this.snapshots.set(`${record.id}@${version}`, snapshot)
    return { ...record, published: { version, publishedAt, digest: digestOf(record.draft) }, distribution: { ...record.distribution, status: 'active' }, updatedAt: publishedAt }
  }
  private async assertPublishable(draft: ExpertDraft) {
    const issues: string[] = []
    if (!draft.owner) issues.push('请填写负责人')
    const responsibility = responsibilityIssue(draft.responsibility)
    if (responsibility) issues.push(responsibility)
    if (draft.categoryIds.length === 0) issues.push('请至少选择一个分类')
    for (const category of draft.categoryIds) if (!EXPERT_CATEGORY_IDS.has(category)) issues.push(`未知分类 ${category}`)
    if (!unique(draft.categoryIds)) issues.push('分类重复')
    if (!unique(draft.builtinTools)) issues.push('基础能力重复')
    if (!unique(draft.skills.map(skill => skill.name))) issues.push('技能名称重复')
    if (!unique(draft.tools.map(toolKey))) issues.push('工具重复')
    if (!unique(draft.knowledge.map(knowledgeKey))) issues.push('知识库重复')
    const library = new Map((await this.loadTools()).tools.map(tool => [tool.definition.key, tool.definition]))
    for (const tool of draft.tools) {
      if ('toolId' in tool && !BUILTIN_TOOL_IDS.has(tool.toolId)) issues.push(`未知内置工具 ${tool.toolId}`)
      if ('customTool' in tool) {
        const definition = library.get(tool.customTool)
        if (!definition) issues.push(`自定义工具 ${tool.customTool} 不在官网工具库中`)
        else for (const issue of customToolPortabilityIssues(definition)) if (issue.severity === 'error') issues.push(`自定义工具「${definition.name}」：${issue.message}`)
      }
    }
    if (draft.tools.filter(tool => 'customTool' in tool).length > EXPERT_LIMITS.customTools) issues.push(`自定义工具最多 ${EXPERT_LIMITS.customTools} 个`)
    const metrics = await this.metricCatalog()
    for (const ref of draft.knowledge) {
      if (ref.kind !== 'metric') continue
      const entry = metrics.get(ref.knowledgeId)
      if (!entry) issues.push(`指标知识库 ${ref.knowledgeId} 不存在`)
    }
    for (const skill of draft.skills) {
      if (RESERVED_SKILL_NAMES.has(skill.name) || skill.name.startsWith(RESERVED_SKILL_PREFIX)) issues.push(`技能名称 ${skill.name} 为系统保留`)
    }
    await this.assertDraftSkills(draft, draft.skills)
    if (issues.length) invalid(issues, 'EXPERT_NOT_PUBLISHABLE')
  }
  private async metricCatalog() {
    if (!this.knowledge) return new Map<string, { enabled: boolean }>()
    return new Map((await this.knowledge.list()).items.map(item => [item.id, { enabled: item.enabled }]))
  }
  /** Every draft Skill must be a stored, content-addressed file; `allowed` is what the caller may keep. */
  private async assertDraftSkills(draft: ExpertDraft, allowed: ExpertDraft['skills']) {
    for (const skill of draft.skills) {
      if (!allowed.some(item => item.name === skill.name && item.sha256 === skill.sha256 && item.kind === skill.kind && item.size === skill.size)) {
        return invalid([`技能 ${skill.name} 需要通过上传或导入加入`])
      }
      try {
        const info = await lstat(path.join(this.skills, `${skill.sha256}.${skill.kind}`))
        if (!info.isFile() || info.isSymbolicLink() || info.size !== skill.size) return fail('CONTENT_UNAVAILABLE', 503)
      } catch (error) { if (error instanceof GuideError) throw error; if (missing(error)) return invalid([`技能 ${skill.name} 的文件已不存在，请重新上传`]); throw error }
    }
  }

  /** Validate one uploaded Skill file and store it by content hash (identical files are reused). */
  private async storeSkill(bytes: Buffer, kind: 'zip' | 'md') {
    const skill = kind === 'zip' ? inspectSkillArchive(bytes) : parseSkillFrontmatter(bytes)
    const hash = sha256(bytes)
    await safeDirectory(this.root); await safeDirectory(this.skills)
    const stored = path.join(this.skills, `${hash}.${kind}`)
    try {
      const info = await lstat(stored)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length) return fail('CONTENT_UNAVAILABLE', 503)
    } catch (error) {
      if (error instanceof GuideError) throw error
      if (!missing(error)) throw error
      const temp = path.join(this.skills, `.${randomUUID()}.tmp`)
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await rename(temp, stored)
    }
    return { name: skill.name, sha256: hash, size: bytes.length, kind }
  }
  async attachSkill(id: string, fileName: string, required: boolean, req: IncomingMessage, expected: unknown) {
    if (!fileName || fileName.length > maxSkillFileName || [...fileName].some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32)) return fail('INVALID_SKILL_FILE')
    const kind = /\.zip$/i.test(fileName) ? 'zip' as const : /\.md$/i.test(fileName) ? 'md' as const : fail('INVALID_SKILL_FILE')
    await safeDirectory(this.root); await safeDirectory(this.skills)
    const file = await receiveFile(req, this.skills, EXPERT_LIMITS.skillBytes)
    try {
      const stored = await this.storeSkill(await readFile(file.temp), kind)
      if (RESERVED_SKILL_NAMES.has(stored.name) || stored.name.startsWith(RESERVED_SKILL_PREFIX)) return invalid([`技能名称 ${stored.name} 为系统保留`])
      return await this.change(expected, async current => {
        const record = this.found(current, id)
        const skills = record.draft.skills.filter(skill => skill.name !== stored.name)
        if (skills.length >= EXPERT_LIMITS.skills) return fail('SKILL_LIMIT', 409)
        const draft = { ...record.draft, skills: [...skills, { ...stored, required, fileName }] }
        return this.replaceRecord(current, { ...record, draft, updatedAt: new Date(this.now()).toISOString() })
      })
    } finally { await unlink(file.temp).catch(error => { if (!missing(error)) throw error }) }
  }
  async detachSkill(id: string, name: string, expected: unknown) {
    return this.change(expected, async current => {
      const record = this.found(current, id)
      if (!record.draft.skills.some(skill => skill.name === name)) return fail('EXPERT_SKILL_NOT_FOUND', 404)
      const draft = { ...record.draft, skills: record.draft.skills.filter(skill => skill.name !== name) }
      return this.replaceRecord(current, { ...record, draft, updatedAt: new Date(this.now()).toISOString() })
    })
  }

  // ---- Expert package import -------------------------------------------------------------------

  private async cleanupImports() {
    let entries: string[]
    try { entries = await readdir(this.imports) } catch (error) { if (missing(error)) return; throw error }
    const now = this.now()
    let kept = 0
    for (const name of entries.sort().reverse()) {
      const directory = path.join(this.imports, name)
      try {
        const info = await stat(directory)
        if (now - info.mtimeMs > IMPORT_TTL_MS || kept >= MAX_PENDING_IMPORTS) await rm(directory, { recursive: true, force: true })
        else kept++
      } catch (error) { if (!missing(error)) throw error }
    }
  }
  private importDirectory(importId: string) {
    if (!/^[a-f0-9]{32}$/.test(importId)) return fail('IMPORT_NOT_FOUND', 404)
    return path.join(this.imports, importId)
  }
  /** Parse and cross-check every file of an expert package; nothing here writes outside the upload. */
  private parsePackage(bytes: Buffer): ParsedPackage {
    const entries = readArchive(bytes, packageLimits)
    const byName = new Map<string, ArchiveEntry>()
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue
      byName.set(entry.name, entry)
    }
    const read = (name: string) => {
      const entry = byName.get(name)
      if (!entry) return invalid([`专家包缺少 ${name}`], 'INVALID_EXPERT_PACKAGE')
      return extractArchiveEntry(bytes, entry, 'INVALID_EXPERT_PACKAGE')
    }
    const json = (name: string) => {
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(name)).replace(BOM_PREFIX, '')) as unknown }
      catch (error) { if (error instanceof GuideError) throw error; return invalid([`${name} 不是有效的 JSON`], 'INVALID_EXPERT_PACKAGE') }
    }
    const manifest = parse(ExpertPackageManifestSchema, json(PACKAGE_MANIFEST_FILE), 'INVALID_EXPERT_PACKAGE')
    const listed = new Set(manifest.files.map(file => file.path))
    for (const name of byName.keys()) {
      if (name !== PACKAGE_MANIFEST_FILE && !listed.has(name)) invalid([`专家包包含未登记的文件 ${name}`], 'INVALID_EXPERT_PACKAGE')
    }
    const contents = new Map<string, Buffer>()
    for (const file of manifest.files) {
      const data = read(file.path)
      if (data.length !== file.size || sha256(data) !== file.sha256) invalid([`${file.path} 与清单记录的大小或校验值不一致，文件可能已损坏`], 'INVALID_EXPERT_PACKAGE')
      contents.set(file.path, data)
    }
    let definitionText: string
    let responsibility: string
    try {
      definitionText = new TextDecoder('utf-8', { fatal: true }).decode(contents.get(PACKAGE_DEFINITION_FILE)!).replace(BOM_PREFIX, '')
      responsibility = new TextDecoder('utf-8', { fatal: true }).decode(contents.get(PACKAGE_RESPONSIBILITY_FILE)!).replace(BOM_PREFIX, '')
    } catch { return invalid(['专家定义或职责不是 UTF-8 文本'], 'INVALID_EXPERT_PACKAGE') }
    let definitionValue: unknown
    try { definitionValue = JSON.parse(definitionText) } catch { return invalid([`${PACKAGE_DEFINITION_FILE} 不是有效的 JSON`], 'INVALID_EXPERT_PACKAGE') }
    const definition = parse(ExpertPackageDefinitionSchema, definitionValue, 'INVALID_EXPERT_PACKAGE')
    const issue = responsibilityIssue(responsibility)
    if (issue) invalid([issue], 'INVALID_EXPERT_PACKAGE')
    const skills = new Map<string, { bytes: Buffer; sha256: string }>()
    for (const skill of definition.skills) {
      const data = contents.get(skill.file)
      if (!data) return invalid([`专家包缺少技能 ${skill.name}`], 'INVALID_EXPERT_PACKAGE')
      if (data.length !== skill.size || sha256(data) !== skill.sha256) invalid([`技能 ${skill.name} 与定义记录的校验值不一致`], 'INVALID_EXPERT_PACKAGE')
      let inspected: { name: string }
      try { inspected = inspectSkillArchive(data) } catch { return invalid([`技能 ${skill.name} 的压缩包无效：需恰好一个 SKILL.md，目录名与 name 一致`], 'INVALID_EXPERT_PACKAGE') }
      if (inspected.name !== skill.name) invalid([`技能 ${skill.name} 的 SKILL.md 名称为 ${inspected.name}`], 'INVALID_EXPERT_PACKAGE')
      skills.set(skill.name, { bytes: data, sha256: skill.sha256 })
    }
    for (const path of listed) {
      if (path !== PACKAGE_DEFINITION_FILE && path !== PACKAGE_RESPONSIBILITY_FILE && !definition.skills.some(skill => skill.file === path)) {
        invalid([`专家包里的 ${path} 没有被专家定义引用`], 'INVALID_EXPERT_PACKAGE')
      }
    }
    return { manifest, definition, responsibility, skills }
  }
  private async previewOf(importId: string, parsed: ParsedPackage, expiresAt: string, current: ExpertDocument, choices: Record<string, ToolChoice> = {}, strict = false): Promise<ImportPreview & { resolved: Awaited<ReturnType<ExpertStore['resolveTools']>> }> {
    const { manifest, definition } = parsed
    const warnings: string[] = [], errors: string[] = []
    const resolved = await this.resolveTools(parsed, await this.loadTools(), current, choices)
    const metrics = await this.metricCatalog()
    const knowledge = definition.knowledge.map(ref => {
      if (ref.kind === 'metric') {
        const entry = metrics.get(ref.knowledgeId)
        const status = !entry ? 'missing' as const : entry.enabled ? 'ok' as const : 'disabled' as const
        if (status === 'missing') errors.push(`指标知识库 ${ref.knowledgeId} 不在官网目录中，请先在“知识库”中创建或从专家中移除`)
        if (status === 'disabled') warnings.push(`指标知识库 ${ref.knowledgeId} 已下架，使用者将看到“已下线”`)
        return { ...ref, status, label: knowledgeLabel(ref) }
      }
      const status = ref.spaceId ? 'ok' as const : 'unsynced' as const
      if (status === 'unsynced') warnings.push(`知识库「${ref.name}」尚未同步到 OneBox，使用者首次使用时会被提示联系负责人同步`)
      return { ...ref, status, label: knowledgeLabel(ref) }
    })
    const tools = definition.tools.map(ref => {
      const known = 'toolId' in ref ? BUILTIN_TOOL_IDS.has(ref.toolId) : true
      if ('toolId' in ref && !known) errors.push(`内置工具 ${ref.toolId} 不在当前产品的工具清单中`)
      const name = 'customTool' in ref ? definition.customTools.find(tool => tool.key === ref.customTool)?.name ?? ref.customTool : toolName(ref)
      return { ...('toolId' in ref ? { toolId: ref.toolId } : { customTool: ref.customTool }), name, required: ref.required, known }
    })
    for (const row of resolved.rows) {
      for (const warning of row.warnings) warnings.push(`工具「${row.name}」：${warning}`)
      if (row.transport === 'stdio') warnings.push(`工具「${row.name}」会在使用者电脑上运行命令 ${[row.command, ...row.args].join(' ')}，使用者首次使用时需要本人确认`)
    }
    errors.push(...resolved.errors)
    // A same-name conflict is the admin's choice in the preview; applying without one is refused.
    if (strict) errors.push(...resolved.missingChoices)
    const existing = current.experts.find(item => item.importedFrom?.expertId === manifest.origin.expertId
      && (item.importedFrom.employeeId ?? '') === (manifest.origin.employeeId ?? ''))
    const target: ImportTarget = existing ? { mode: 'update', id: existing.id } : { mode: 'create', id: await this.suggestId(current) }
    const preview: ImportPreview = {
      importId, expiresAt,
      origin: { expertId: manifest.origin.expertId, ...(manifest.origin.employeeId ? { employeeId: manifest.origin.employeeId } : {}), exportedAt: manifest.exportedAt, ...(manifest.appVersion ? { appVersion: manifest.appVersion } : {}) },
      expert: { name: definition.name, summary: definition.summary, owner: definition.owner, categoryIds: definition.categoryIds, builtinTools: definition.builtinTools, ...(definition.releaseNote ? { releaseNote: definition.releaseNote } : {}) },
      skills: definition.skills.map(skill => ({ name: skill.name, size: skill.size, required: skill.required })),
      tools, customTools: resolved.rows, knowledge,
      suggestedAllowlist: definition.suggestedAllowlist ?? [],
      target,
      warnings, errors,
    }
    if (existing) {
      preview.existing = { id: existing.id, name: existing.draft.name, ...(existing.published ? { published: { version: existing.published.version } } : {}) }
      preview.changes = changesBetween(existing.draft, this.draftFrom(parsed, undefined, resolved.mapping))
    }
    return { ...preview, resolved }
  }
  /** The preview as the admin page receives it (resolution internals stay on the server). */
  private publicPreview(preview: ImportPreview & { resolved?: unknown }): ImportPreview {
    const { resolved: _resolved, ...rest } = preview
    return rest
  }
  private async suggestId(current: ExpertDocument) {
    let id: string
    do { id = `expert-${randomBytes(3).toString('hex')}` } while (current.experts.some(item => item.id === id))
    return id
  }
  private draftFrom(parsed: ParsedPackage, previous?: ExpertDraft, mapping: ReadonlyMap<string, string> = new Map()): ExpertDraft {
    const { definition } = parsed
    return {
      name: definition.name,
      summary: definition.summary,
      appearance: definition.appearance,
      categoryIds: definition.categoryIds,
      tags: definition.tags,
      starterPrompts: definition.starterPrompts,
      sortOrder: definition.sortOrder ?? previous?.sortOrder ?? 1000,
      builtinTools: definition.builtinTools,
      responsibility: parsed.responsibility,
      skills: definition.skills.map(skill => ({ name: skill.name, sha256: skill.sha256, size: skill.size, kind: 'zip' as const, required: skill.required, fileName: `${skill.name}.zip` })),
      tools: definition.tools.map(ref => 'customTool' in ref ? { customTool: mapping.get(ref.customTool) ?? ref.customTool, required: ref.required } : ref),
      knowledge: definition.knowledge,
      owner: definition.owner,
    }
  }
  /** Receive an expert package, validate it completely and keep it for 24 hours pending the admin's decision. */
  async importPackage(req: IncomingMessage) {
    await safeDirectory(this.root); await safeDirectory(this.imports)
    await this.cleanupImports()
    const importId = randomBytes(16).toString('hex')
    const directory = this.importDirectory(importId)
    await mkdir(directory)
    try {
      const file = await receiveFile(req, directory, EXPERT_LIMITS.packageBytes)
      await rename(file.temp, path.join(directory, 'package.zip'))
      const parsed = this.parsePackage(await readFile(path.join(directory, 'package.zip')))
      const expiresAt = new Date(this.now() + IMPORT_TTL_MS).toISOString()
      const preview = await this.previewOf(importId, parsed, expiresAt, await this.load())
      await atomicJson(directory, 'preview.json', { importId, expiresAt })
      return { preview: this.publicPreview(preview) }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
  async previewImport(importId: string) {
    const directory = this.importDirectory(importId)
    let meta: unknown
    try { meta = await readJson(directory, ['preview.json']) } catch (error) { if (missing(error)) return fail('IMPORT_NOT_FOUND', 404); throw error }
    const expiresAt = z.object({ importId: z.string(), expiresAt: z.string().datetime() }).parse(meta).expiresAt
    if (Date.parse(expiresAt) <= this.now()) return fail('IMPORT_NOT_FOUND', 404)
    const parsed = this.parsePackage(await readFile(path.join(directory, 'package.zip')))
    return { preview: this.publicPreview(await this.previewOf(importId, parsed, expiresAt, await this.load())) }
  }
  async discardImport(importId: string) {
    await rm(this.importDirectory(importId), { recursive: true, force: true })
    return { discarded: true }
  }
  /** Create or update the draft from a pending import (optionally publishing it in the same step). */
  async applyImport(importId: string, input: unknown, expected: unknown) {
    const request = z.object({
      target: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('create'), id: z.string().regex(EXPERT_ID_PATTERN) }).strict(),
        z.object({ mode: z.literal('update'), id: z.string().regex(EXPERT_ID_PATTERN) }).strict(),
      ]),
      adoptAllowlist: z.boolean().default(false),
      publish: z.boolean().default(false),
      tools: z.record(z.string().regex(CUSTOM_TOOL_KEY_PATTERN), z.enum(['update', 'rename'])).default({}),
    }).strict().safeParse(input)
    if (!request.success) return invalid(['导入请求格式无效'])
    const directory = this.importDirectory(importId)
    let bytes: Buffer
    try { bytes = await readFile(path.join(directory, 'package.zip')) } catch (error) { if (missing(error)) return fail('IMPORT_NOT_FOUND', 404); throw error }
    const parsed = this.parsePackage(bytes)
    const result = await this.change(expected, async current => {
      const preview = await this.previewOf(importId, parsed, new Date(this.now() + IMPORT_TTL_MS).toISOString(), current, request.data.tools, true)
      if (preview.errors.length) return invalid(preview.errors, 'EXPERT_PACKAGE_REJECTED')
      for (const [, skill] of parsed.skills) await this.storeSkill(skill.bytes, 'zip')
      // Library entries first: the draft references them by key. An entry an update replaces is backed up.
      const { writes, mapping } = preview.resolved
      if (writes.length) {
        const library = await this.loadTools()
        const replaced = new Map(writes.map(write => [write.definition.key, write]))
        const updating = library.tools.some(item => replaced.has(item.definition.key))
        await this.commitTools([...library.tools.filter(item => !replaced.has(item.definition.key)), ...writes], updating)
      }
      const now = new Date(this.now()).toISOString()
      const importedFrom = { expertId: parsed.manifest.origin.expertId, ...(parsed.manifest.origin.employeeId ? { employeeId: parsed.manifest.origin.employeeId } : {}), importedAt: now }
      const { target, adoptAllowlist, publish } = request.data
      let record: ExpertRecord
      if (target.mode === 'create') {
        if (current.experts.some(item => item.id === target.id) || RESERVED_IDS.has(target.id)) return fail('EXPERT_ID_TAKEN', 409)
        if (current.experts.length >= EXPERT_LIMITS.experts) return fail('EXPERT_LIMIT', 409)
        const allowlist = adoptAllowlist ? parsed.definition.suggestedAllowlist ?? [] : []
        record = { id: target.id, draft: this.draftFrom(parsed, undefined, mapping), distribution: { status: 'disabled', visibility: { mode: 'allowlist', employeeIds: allowlist }, allowClone: true }, importedFrom, createdAt: now, updatedAt: now }
      } else {
        const existing = this.found(current, target.id)
        record = { ...existing, draft: this.draftFrom(parsed, existing.draft, mapping), importedFrom, updatedAt: now }
        if (adoptAllowlist && parsed.definition.suggestedAllowlist && record.distribution.visibility.mode === 'allowlist') {
          const merged = [...new Set([...record.distribution.visibility.employeeIds, ...parsed.definition.suggestedAllowlist])].slice(0, EXPERT_LIMITS.allowlist)
          record = { ...record, distribution: { ...record.distribution, visibility: { mode: 'allowlist', employeeIds: merged } } }
        }
      }
      if (publish && record.published?.digest !== digestOf(record.draft)) record = await this.publishRecord(record)
      const experts = target.mode === 'create' ? [...current.experts, record] : current.experts.map(item => item.id === record.id ? record : item)
      const document = await this.commit(experts, target.mode === 'update')
      return { revision: document.revision, expert: this.view(this.found(document, record.id)) }
    })
    await rm(directory, { recursive: true, force: true })
    return result
  }

  // ---- Public, per-employee reads ---------------------------------------------------------------

  private async snapshot(id: string, version: number): Promise<Snapshot> {
    const key = `${id}@${version}`
    const cached = this.snapshots.get(key)
    if (cached) return cached
    const parsed = SnapshotSchema.safeParse(await readJson(this.versions, [id, `${version}.json`], 512 * 1024))
    if (!parsed.success || parsed.data.id !== id || parsed.data.version !== version) return fail('CONTENT_UNAVAILABLE', 503)
    if (this.snapshots.size > 500) this.snapshots.clear()
    this.snapshots.set(key, parsed.data)
    return parsed.data
  }
  /**
   * The catalog one employee sees, with the library entries those experts reference (current revision: a library
   * save reaches every user at the next sync). The ETag covers exactly the served entries.
   */
  async publicCatalog(employeeId: string | undefined) {
    const [document, library] = await Promise.all([this.load(), this.loadTools()])
    const tools = new Map(library.tools.map(tool => [tool.definition.key, tool]))
    const experts: CloudExpert[] = []
    const referenced = new Set<string>()
    for (const record of document.experts) {
      if (!record.published || record.distribution.status !== 'active') continue
      const snapshot = await this.snapshot(record.id, record.published.version)
      const owner = snapshot.content.owner
      if (!owner) continue
      if (!isExpertVisible({ status: record.distribution.status, published: true, visibility: record.distribution.visibility as ExpertVisibility, owner }, employeeId)) continue
      const keys = snapshot.content.tools.flatMap(ref => 'customTool' in ref ? [ref.customTool] : [])
      // An expert whose tool left the library is not served (the product would drop it anyway).
      if (keys.some(key => !tools.has(key))) continue
      for (const key of keys) referenced.add(key)
      experts.push(entryOf(record, snapshot, owner))
    }
    experts.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    const customTools: CloudCustomTool[] = [...referenced].sort().map((key) => {
      const tool = tools.get(key)!
      return { ...tool.definition, revision: tool.revision, updatedAt: tool.updatedAt }
    })
    const body = { schemaVersion: CATALOG_SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, identity: { recognized: employeeId !== undefined }, experts, customTools }
    // Keyed by the employee too: a cached tag from another identity never revalidates this one.
    return { etag: `"${digestOf({ employeeId: employeeId ?? null, body })}"`, body: { ...body, generatedAt: new Date(this.now()).toISOString() } }
  }
  private async visibleSnapshot(id: string, version: number, employeeId: string | undefined) {
    if (!EXPERT_ID_PATTERN.test(id) || !Number.isSafeInteger(version) || version < 1) return fail('NOT_FOUND', 404)
    const document = await this.load()
    const record = document.experts.find(item => item.id === id)
    // Not visible, not published or not the current version all read as absent.
    if (!record?.published || record.published.version !== version || record.distribution.status !== 'active') return fail('NOT_FOUND', 404)
    const snapshot = await this.snapshot(id, version)
    const owner = snapshot.content.owner
    if (!owner || !isExpertVisible({ status: 'active', published: true, visibility: record.distribution.visibility as ExpertVisibility, owner }, employeeId)) return fail('NOT_FOUND', 404)
    return snapshot
  }
  async publicResponsibility(id: string, version: number, employeeId: string | undefined) {
    const snapshot = await this.visibleSnapshot(id, version, employeeId)
    const bytes = Buffer.from(snapshot.content.responsibility, 'utf8')
    return { bytes, sha256: sha256(bytes) }
  }
  async publicSkill(id: string, version: number, name: string, employeeId: string | undefined) {
    const snapshot = await this.visibleSnapshot(id, version, employeeId)
    const skill = snapshot.content.skills.find(item => item.name === name)
    if (!skill) return fail('NOT_FOUND', 404)
    return {
      root: this.root, segments: ['skills', `${skill.sha256}.${skill.kind}`], size: skill.size, sha256: skill.sha256, name: skill.name,
      fileName: `${skill.name}.${skill.kind}`, type: skill.kind === 'zip' ? 'application/zip' : 'text/markdown; charset=utf-8',
    }
  }
}

function entryOf(record: ExpertRecord, snapshot: Snapshot, owner: NonNullable<ExpertDraft['owner']>): CloudExpert {
  const content = snapshot.content
  return {
    id: record.id,
    presetId: presetIdForCloudExpert(record.id),
    version: snapshot.version,
    publishedAt: snapshot.publishedAt,
    name: content.name,
    summary: content.summary,
    appearance: content.appearance,
    categoryIds: content.categoryIds,
    tags: content.tags,
    starterPrompts: content.starterPrompts,
    sortOrder: content.sortOrder,
    owner,
    allowClone: record.distribution.allowClone,
    builtinTools: content.builtinTools,
    tools: content.tools,
    knowledge: content.knowledge,
    skills: content.skills.map(skill => ({ name: skill.name, sha256: skill.sha256, size: skill.size, kind: skill.kind, required: skill.required })),
    responsibility: { sha256: sha256(Buffer.from(content.responsibility, 'utf8')), size: utf8Size(content.responsibility) },
  }
}

function changesBetween(before: ExpertDraft, after: ExpertDraft): NonNullable<ImportPreview['changes']> {
  const beforeSkills = new Map(before.skills.map(skill => [skill.name, skill.sha256]))
  const afterSkills = new Map(after.skills.map(skill => [skill.name, skill.sha256]))
  const beforeTools = new Set(before.tools.map(toolKey)), afterTools = new Set(after.tools.map(toolKey))
  const beforeKnowledge = new Set(before.knowledge.map(knowledgeKey)), afterKnowledge = new Set(after.knowledge.map(knowledgeKey))
  return {
    responsibility: before.responsibility !== after.responsibility,
    skills: {
      added: [...afterSkills.keys()].filter(name => !beforeSkills.has(name)),
      removed: [...beforeSkills.keys()].filter(name => !afterSkills.has(name)),
      updated: [...afterSkills].filter(([name, hash]) => beforeSkills.has(name) && beforeSkills.get(name) !== hash).map(([name]) => name),
    },
    tools: { added: [...afterTools].filter(key => !beforeTools.has(key)), removed: [...beforeTools].filter(key => !afterTools.has(key)) },
    knowledge: { added: [...afterKnowledge].filter(key => !beforeKnowledge.has(key)), removed: [...beforeKnowledge].filter(key => !afterKnowledge.has(key)) },
    owner: JSON.stringify(before.owner ?? null) !== JSON.stringify(after.owner ?? null),
    basics: JSON.stringify([before.name, before.summary, before.appearance, before.categoryIds, before.tags, before.starterPrompts, before.builtinTools])
      !== JSON.stringify([after.name, after.summary, after.appearance, after.categoryIds, after.tags, after.starterPrompts, after.builtinTools]),
  }
}
