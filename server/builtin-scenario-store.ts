import { randomBytes } from 'node:crypto'
import { copyFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  BUILTIN_EXPERTS, BUILTIN_EXPERT_IDS, ScenariosSchema, scenarioIssues,
  type BuiltinScenarioOverride, type ExpertScenario, type ScenarioIssue,
} from '@dsh-ops/expert-distribution-contract'
import { GuideError, revisionOf } from './guide-store.js'
import { atomicJson, missing, readJson, safeDirectory, withLock } from './admin-files.js'

/**
 * 内置专家场景: the website's replacement for the 常用场景 of the experts the product ships
 * (`BUILTIN_EXPERTS`). An override is the expert's whole list (replace, not merge; `[]` hides the shipped
 * ones); an expert without a published override keeps what the product shipped. The admin edits a draft and
 * publishes it; withdrawing drops the override and its draft, back to the shipped list.
 *
 * Storage: `<contentDirectory>/experts/builtin-scenarios.json` (schemaVersion 1, revision = content digest),
 * written under the catalog's `.experts-lock` with an atomic rename; the previous file goes to `.trash/`.
 */
const FILE = 'builtin-scenarios.json'
const EntrySchema = z.object({
  expertId: z.string().refine(id => BUILTIN_EXPERT_IDS.has(id), '不是随产品发布的专家'),
  /** What the next publish sends; may be empty (publishing `[]` hides the shipped scenarios). */
  draft: ScenariosSchema,
  published: z.object({
    version: z.number().int().positive(),
    publishedAt: z.string().datetime(),
    scenarios: ScenariosSchema,
  }).strict().optional(),
  updatedAt: z.string().datetime(),
}).strict()
type Entry = z.infer<typeof EntrySchema>
const DocumentSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  experts: z.array(EntrySchema).max(BUILTIN_EXPERTS.length),
}).strict()
type BuiltinDocument = z.infer<typeof DocumentSchema>
const emptyDocument: BuiltinDocument = { schemaVersion: 1, updatedAt: new Date(0).toISOString(), experts: [] }

function digestOf(value: unknown) { return revisionOf(JSON.stringify(value)) }
function same(left: readonly ExpertScenario[], right: readonly ExpertScenario[]) { return JSON.stringify(left) === JSON.stringify(right) }

/** Validation failure with per-scenario problems (same shape the expert routes answer with). */
export class BuiltinScenarioError extends GuideError {
  constructor(code: string, readonly issues: string[], status = 400) { super(code, status) }
}
/** A scenario problem as the admin reads it: which scenario (1-based), then the contract's message. */
export function scenarioIssueText(issue: ScenarioIssue): string {
  return issue.index === undefined ? `常用场景：${issue.message}` : `常用场景第 ${issue.index + 1} 个：${issue.message}`
}
function issueLines(value: unknown): string[] { return scenarioIssues(value).slice(0, 12).map(scenarioIssueText) }

/** One shipped expert as the admin page shows it. */
export interface BuiltinScenarioView {
  id: string
  name: string
  draft: ExpertScenario[]
  published?: { version: number; publishedAt: string; scenarios: ExpertScenario[] }
  /** A saved draft that differs from what is published (or, never published, any saved draft). */
  draftChanged: boolean
  updatedAt?: string
}

export class BuiltinScenarioStore {
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  private async load(): Promise<BuiltinDocument & { revision: string }> {
    let raw: unknown
    try { raw = await readJson(this.root, [FILE], 1024 ** 2) }
    catch (error) {
      if (missing(error)) return { ...emptyDocument, revision: digestOf(emptyDocument) }
      if (error instanceof GuideError) throw error
      throw new GuideError('CONTENT_UNAVAILABLE', 503)
    }
    const parsed = DocumentSchema.safeParse(raw)
    if (!parsed.success || new Set(parsed.data.experts.map(entry => entry.expertId)).size !== parsed.data.experts.length) throw new GuideError('CONTENT_UNAVAILABLE', 503)
    return { ...parsed.data, revision: digestOf(parsed.data) }
  }
  private async commit(experts: Entry[]) {
    const order = BUILTIN_EXPERTS.map(expert => expert.id as string)
    const document = DocumentSchema.parse({
      schemaVersion: 1, updatedAt: new Date(this.now()).toISOString(),
      experts: [...experts].sort((a, b) => order.indexOf(a.expertId) - order.indexOf(b.expertId)),
    })
    await safeDirectory(this.root)
    await this.backup()
    await atomicJson(this.root, FILE, document)
    return { ...document, revision: digestOf(document) }
  }
  /** Keep the file being replaced in `.trash/` (drafts, publishes and withdrawals alike). */
  private async backup() {
    try { await lstat(path.join(this.root, FILE)) } catch (error) { if (missing(error)) return; throw error }
    const trash = path.join(this.root, '.trash')
    await safeDirectory(trash)
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    await copyFile(path.join(this.root, FILE), path.join(trash, `builtin-scenarios-${stamp}-${randomBytes(3).toString('hex')}.json`))
  }
  private change<T>(expertId: string, expected: unknown, action: (current: BuiltinDocument & { revision: string }, entry: Entry | undefined) => Promise<T>) {
    if (!BUILTIN_EXPERT_IDS.has(expertId)) throw new GuideError('BUILTIN_EXPERT_NOT_FOUND', 404)
    return withLock(this.root, '.experts-lock', async () => {
      const current = await this.load()
      if (current.revision !== expected) throw new GuideError('REVISION_CONFLICT', 409)
      return action(current, current.experts.find(entry => entry.expertId === expertId))
    })
  }
  private view(id: string, entry: Entry | undefined): BuiltinScenarioView {
    const name = BUILTIN_EXPERTS.find(expert => expert.id === id)?.name ?? id
    if (!entry) return { id, name, draft: [], draftChanged: false }
    return {
      id, name, draft: entry.draft,
      ...(entry.published ? { published: entry.published } : {}),
      draftChanged: entry.published ? !same(entry.draft, entry.published.scenarios) : true,
      updatedAt: entry.updatedAt,
    }
  }
  private result(document: BuiltinDocument & { revision: string }, expertId: string) {
    return { revision: document.revision, expert: this.view(expertId, document.experts.find(entry => entry.expertId === expertId)) }
  }

  /** Every shipped expert, overridden or not, in the product's order. */
  async list() {
    const document = await this.load()
    return { revision: document.revision, experts: BUILTIN_EXPERTS.map(expert => this.view(expert.id, document.experts.find(entry => entry.expertId === expert.id))) }
  }
  /** Save the draft list; it reaches no one until published. */
  async saveDraft(expertId: string, input: unknown, expected: unknown) {
    if (!BUILTIN_EXPERT_IDS.has(expertId)) throw new GuideError('BUILTIN_EXPERT_NOT_FOUND', 404)
    if (!Array.isArray(input)) throw new BuiltinScenarioError('INVALID_SCENARIOS', ['常用场景必须是列表'])
    const issues = issueLines(input)
    if (issues.length) throw new BuiltinScenarioError('INVALID_SCENARIOS', issues)
    const draft = ScenariosSchema.parse(input)
    return this.change(expertId, expected, async (current, entry) => {
      if (entry && same(entry.draft, draft)) return this.result(current, expertId)
      const next: Entry = { ...(entry ?? {}), expertId, draft, updatedAt: new Date(this.now()).toISOString() }
      const document = await this.commit([...current.experts.filter(item => item.expertId !== expertId), next])
      return this.result(document, expertId)
    })
  }
  /** Publish the saved draft as the expert's whole scenario list; everyone receives it at the next sync. */
  async publish(expertId: string, expected: unknown) {
    return this.change(expertId, expected, async (current, entry) => {
      if (!entry || (entry.published && same(entry.draft, entry.published.scenarios))) throw new GuideError('NOTHING_TO_PUBLISH', 409)
      const issues = issueLines(entry.draft)
      if (issues.length) throw new BuiltinScenarioError('EXPERT_NOT_PUBLISHABLE', issues)
      const publishedAt = new Date(this.now()).toISOString()
      const next: Entry = { ...entry, published: { version: (entry.published?.version ?? 0) + 1, publishedAt, scenarios: entry.draft }, updatedAt: publishedAt }
      const document = await this.commit(current.experts.map(item => item.expertId === expertId ? next : item))
      return this.result(document, expertId)
    })
  }
  /** Drop the override and its draft: the expert shows what the product shipped again at the next sync. */
  async withdraw(expertId: string, expected: unknown) {
    return this.change(expertId, expected, async (current, entry) => {
      if (!entry) return this.result(current, expertId)
      const document = await this.commit(current.experts.filter(item => item.expertId !== expertId))
      return this.result(document, expertId)
    })
  }
  /** The published overrides, in the product's order (the public catalog's `builtinScenarios`). */
  async published(): Promise<Array<Required<BuiltinScenarioOverride>>> {
    const document = await this.load()
    return BUILTIN_EXPERTS.flatMap((expert) => {
      const published = document.experts.find(entry => entry.expertId === expert.id)?.published
      return published ? [{ expertId: expert.id, scenarios: published.scenarios, publishedAt: published.publishedAt }] : []
    })
  }
}
