import path from 'node:path'
import { parseDocument } from 'yaml'
import { EXPERT_LIMITS } from '@dsh-ops/expert-distribution-contract'
import { DISTRIBUTION_SKIP_RULE, normalizeSkillTree, suggestSkillNameWithoutLoss, type SkillTreeNote } from '@dsh-ops/skill-contract/normalize'
import {
  SKILL_TREE_LIMITS, isIgnoredSkillPath, legacyClientIssues, skillManifestIssues, skillTreeIssues, type SkillManifestFields,
} from '@dsh-ops/skill-contract/tree'
import { extractArchiveEntry, readArchive, type ArchiveEntry, type ArchiveLimits } from './knowledge-store.js'
import { writeSkillZip } from './skill-zip.js'

/** Why a Skill of an expert cannot be used: one sentence per problem, as the admin page lists them. */
export class ExpertSkillProblem extends Error {
  constructor(readonly problems: string[]) { super(problems.join('；')) }
}

/** An upload whose `name` cannot become a Skill name (Chinese, emoji, none): the admin gives one. */
export class ExpertSkillNameRequired extends Error {
  /** A guess the page offers, from the Skill's folder or the uploaded file's name; `''` for none. */
  constructor(message: string, readonly suggestion: string) { super(message) }
}

export interface ExpertSkillCheck {
  name: string
  description: string
  /** `metadata.displayName` of the manifest when it differs from `name` (a repair keeps the original name there). */
  displayName?: string
  /** Why a client released before these rules (contract 0.1.x) would refuse this Skill; empty when it installs it. */
  legacy: string[]
}

/** The version of the shared rules a stored Skill was last checked with; publishing re-checks older ones. */
export const SKILL_RULES_VERSION = 'skill-contract@0.1.0'

// Folders and OS metadata count towards the entries, not the files; the content limits are the tree rules below.
const archiveLimits: ArchiveLimits = {
  maxBytes: EXPERT_LIMITS.skillBytes, maxEntries: SKILL_TREE_LIMITS.archiveEntries, maxExtractedBytes: Number.MAX_SAFE_INTEGER,
  maxDepth: SKILL_TREE_LIMITS.depth + 1, code: 'INVALID_EXPERT_SKILL',
}
const BOM_PREFIX = new RegExp('^' + String.fromCharCode(0xfeff))
const UNREADABLE_ARCHIVE = `压缩包无法读取：只支持普通 ZIP（存储或 deflate 压缩），不支持加密、ZIP64、分卷、符号链接、重复的文件名或超过 ${SKILL_TREE_LIMITS.archiveEntries} 个条目`

/**
 * One Skill of an expert checked by the rules every side of expert distribution applies (`@dsh-ops/skill-contract/tree`,
 * the same as the product's export and every client's install): a ZIP holds the Skill folder at its root or as its only
 * top folder, a `SKILL.md` deeper inside is an ordinary file, OS metadata is left out, the description has no length
 * limit, and the frontmatter is judged the way DSH loads a Skill (the name as written, readable invocation switches).
 * `.md` is a lone `SKILL.md`. `expectedName` is the name the Skill travels under in a package.
 * Only the central directory and `SKILL.md` are read.
 */
export function checkExpertSkill(bytes: Buffer, kind: 'zip' | 'md', expectedName?: string): ExpertSkillCheck {
  if (kind === 'md') {
    const problems = skillTreeIssues([{ path: 'SKILL.md', size: bytes.length }]).map(issue => issue.message)
    if (problems.length) throw new ExpertSkillProblem(problems)
    const manifest = manifestOf(bytes, expectedName)
    return { ...manifest, legacy: legacyClientIssues({ archiveBytes: bytes.length, archiveEntries: 1, extractedBytes: bytes.length, archiveDepth: 1, manifests: 1, descriptionLength: manifest.description.length }) }
  }
  if (bytes.length > EXPERT_LIMITS.skillBytes) throw new ExpertSkillProblem([`压缩包有 ${formatBytes(bytes.length)}，超过 ${formatBytes(EXPERT_LIMITS.skillBytes)} 上限`])
  let entries: ArchiveEntry[]
  try { entries = readArchive(bytes, archiveLimits) }
  catch { throw new ExpertSkillProblem([UNREADABLE_ARCHIVE]) }
  const kept = entries.filter(entry => !entry.name.endsWith('/') && !isIgnoredSkillPath(entry.name))
  // The Skill folder: the archive's root when it holds SKILL.md, else its only top folder.
  let prefix = ''
  if (!kept.some(entry => entry.name === 'SKILL.md')) {
    const tops = new Set(kept.map(entry => entry.name.split('/')[0]))
    const [top] = tops
    if (tops.size !== 1 || top === undefined || !kept.some(entry => entry.name === `${top}/SKILL.md`)) {
      throw new ExpertSkillProblem(['压缩包里找不到技能的 SKILL.md：它应在压缩包根目录，或唯一的一级文件夹里'])
    }
    if (expectedName !== undefined && top !== expectedName) throw new ExpertSkillProblem([`压缩包里的文件夹名（${top}）与技能名称（${expectedName}）不一致`])
    prefix = `${top}/`
  }
  const problems = skillTreeIssues(kept.map(entry => ({ path: entry.name.slice(prefix.length), size: entry.size }))).map(issue => issue.message)
  if (problems.length) throw new ExpertSkillProblem(problems)
  let manifestBytes: Buffer
  try { manifestBytes = extractArchiveEntry(bytes, kept.find(entry => entry.name === `${prefix}SKILL.md`)!, archiveLimits.code) }
  catch { throw new ExpertSkillProblem(['压缩包里的 SKILL.md 已损坏']) }
  const manifest = manifestOf(manifestBytes, expectedName ?? (prefix ? prefix.slice(0, -1) : undefined))
  const files = entries.filter(entry => !entry.name.endsWith('/'))
  return {
    ...manifest,
    legacy: legacyClientIssues({
      archiveBytes: bytes.length,
      archiveEntries: entries.length,
      extractedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      archiveDepth: files.reduce((depth, entry) => Math.max(depth, entry.name.split('/').length), 0),
      manifests: kept.filter(entry => entry.name.split('/').at(-1) === 'SKILL.md').length,
      descriptionLength: manifest.description.length,
    }),
  }
}

/** What an admin's upload became once repaired: the file to store and distribute, and what changed. */
export interface PreparedExpertSkill {
  bytes: Buffer
  kind: 'zip' | 'md'
  name: string
  /** What people read when it differs from `name`: the manifest's own name kept by the repair, or its heading. */
  displayName?: string
  /** What the repair changed, one sentence each; empty when the upload was stored as it came. */
  fixes: string[]
  check: ExpertSkillCheck
}

/** Bounds of one Skill while it is repaired: the distribution rules' own. */
const REPAIR_LIMITS = Object.freeze({
  maxFiles: SKILL_TREE_LIMITS.files,
  maxBytes: SKILL_TREE_LIMITS.extractedBytes,
  maxFileBytes: SKILL_TREE_LIMITS.extractedBytes,
})

/**
 * One Skill an admin uploads, first repaired with the module every entry repairs with (the product's 我的技能
 * import does the same) and then checked by the rules every receiver applies (`checkExpertSkill`). What can be fixed
 * for sure is: YAML written loosely, the `---` fences, GBK / UTF-16 text, a name that only needs cleaning
 * (`Weekly_Report` → `weekly-report`), names Windows cannot hold, YAML anchors. A name that cannot become a Skill
 * name without losing a letter raises `ExpertSkillNameRequired` unless the admin gave `givenName`; the manifest's
 * own name stays as the display name. The repaired Skill is packed with its files at the archive root (a lone
 * `SKILL.md` stays one). What is never content (`.git`, `node_modules`, caches, OS files) is neither read nor kept.
 */
export function prepareUploadedSkill(upload: Buffer, kind: 'zip' | 'md', fileName: string, givenName?: string): PreparedExpertSkill {
  const { files, skipped } = kind === 'md' ? { files: new Map<string, Uint8Array>([['SKILL.md', upload]]), skipped: [] as string[] } : uploadedFiles(upload)
  const tree = normalizeSkillTree(files, { limits: REPAIR_LIMITS, requireName: true, ...(givenName === undefined ? {} : { name: givenName }) })
  if (tree.problems.length) throw new ExpertSkillProblem(tree.problems.map(note => noteText(note, '')))
  if (tree.skills.length !== 1) {
    throw new ExpertSkillProblem([`压缩包里有 ${tree.skills.length} 个技能（${tree.skills.map(skill => skill.root || '根目录').join('、')}），一次只能上传一个`])
  }
  const skill = tree.skills[0]!
  // What the author has to change comes first; the English name is asked for when the file is otherwise fine.
  const others = skill.problems.filter(note => note.code !== 'name-required')
  if (others.length) throw new ExpertSkillProblem(others.map(note => noteText(note, skill.root)))
  const required = skill.problems.find(note => note.code === 'name-required')
  if (required) throw new ExpertSkillNameRequired(required.message, nameSuggestion(skill.root, fileName))
  const ignored = skipped.length + tree.skipped.count
  const examples = [...new Set([...skipped, ...tree.skipped.examples])].slice(0, 3)
  const fixes = [
    ...skill.fixes.map(note => note.message),
    ...(ignored ? [`跳过了 ${String(ignored)} 个不属于技能的文件（${examples.join('、')}${ignored > examples.length ? ' 等' : ''}），使用者那边也不需要它们。`] : []),
  ]
  // Nothing to repair: stored exactly as uploaded when every receiver takes it as it is.
  if (fixes.length === 0) {
    const asIs = checkedOrUndefined(upload, kind)
    if (asIs?.name === skill.name) return { bytes: upload, kind, name: skill.name, ...displayNameOf(asIs), fixes, check: asIs }
  }
  const lone = kind === 'md' && skill.files.size === 1
  const bytes = lone ? Buffer.from(skill.files.get('SKILL.md')!) : writeSkillZip(skill.files)
  const outKind = lone ? 'md' : 'zip'
  const check = checkExpertSkill(bytes, outKind)
  if (check.name !== skill.name) throw new ExpertSkillProblem([`SKILL.md 的 name（${check.name}）与修复后的技能名称（${skill.name}）不一致`])
  // Only the layout differed (the Skill in a folder not named after it, or deeper than the only top folder).
  if (fixes.length === 0) fixes.push(skill.root ? `技能文件原来在压缩包的「${skill.root}」文件夹里，已放到压缩包根目录重新打包，内容不变。` : '已重新打包压缩包，内容不变。')
  return { bytes, kind: outKind, name: skill.name, ...displayNameOf(check), fixes, check }
}

function checkedOrUndefined(bytes: Buffer, kind: 'zip' | 'md'): ExpertSkillCheck | undefined {
  try { return checkExpertSkill(bytes, kind) }
  catch (error) { if (error instanceof ExpertSkillProblem) return undefined; throw error }
}

function displayNameOf(check: ExpertSkillCheck): { displayName?: string } {
  return check.displayName === undefined ? {} : { displayName: check.displayName }
}

/**
 * The files of an uploaded ZIP for the repair. What is never content is counted, not inflated; the rest must fit the
 * distribution limits by its declared sizes before anything is inflated, and each entry inflates to its declared size.
 */
function uploadedFiles(bytes: Buffer): { files: Map<string, Uint8Array>; skipped: string[] } {
  if (bytes.length > EXPERT_LIMITS.skillBytes) throw new ExpertSkillProblem([`压缩包有 ${formatBytes(bytes.length)}，超过 ${formatBytes(EXPERT_LIMITS.skillBytes)} 上限`])
  let entries: ArchiveEntry[]
  try { entries = readArchive(bytes, archiveLimits) }
  catch { throw new ExpertSkillProblem([UNREADABLE_ARCHIVE]) }
  const skipped: string[] = []
  const content: ArchiveEntry[] = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    if (DISTRIBUTION_SKIP_RULE.matches(entry.name)) skipped.push(DISTRIBUTION_SKIP_RULE.summary(entry.name))
    else content.push(entry)
  }
  const total = content.reduce((sum, entry) => sum + entry.size, 0)
  if (total > SKILL_TREE_LIMITS.extractedBytes) throw new ExpertSkillProblem([`文件共 ${formatBytes(total)}，超过 ${formatBytes(SKILL_TREE_LIMITS.extractedBytes)} 上限`])
  const files = new Map<string, Uint8Array>()
  for (const entry of content) {
    try { files.set(entry.name, extractArchiveEntry(bytes, entry, archiveLimits.code)) }
    catch { throw new ExpertSkillProblem([`压缩包里的 ${entry.name} 已损坏`]) }
  }
  return { files, skipped }
}

/** A name the page offers when the admin has to give one: from the Skill's folder, else the uploaded file's name. */
function nameSuggestion(root: string, fileName: string): string {
  const folder = root === '' ? '' : root.split('/').at(-1)!
  return suggestSkillNameWithoutLoss(folder) || suggestSkillNameWithoutLoss(path.basename(fileName).replace(/\.(zip|md)$/iu, ''))
}

/**
 * A note of the repair as this page says it: the admin uploads where 我的技能 imports, and a file is named inside the
 * Skill (`root`: where its SKILL.md was found in the upload); the SKILL.md itself goes without saying.
 */
function noteText(note: SkillTreeNote, root: string): string {
  const message = note.message.replace(/后再导入。$/u, '后再上传。')
  const file = note.path !== undefined && root !== '' && note.path.startsWith(`${root}/`) ? note.path.slice(root.length + 1) : note.path
  return file && file !== 'SKILL.md' && !message.includes(file) ? `${message}（${file}）` : message
}

function manifestOf(bytes: Buffer, expectedName: string | undefined): { name: string; description: string; displayName?: string } {
  const fields = frontmatter(bytes)
  if (!fields) throw new ExpertSkillProblem(['SKILL.md 开头缺少用 --- 包起来的 name 与 description，或格式不正确'])
  const problems = skillManifestIssues(fields, expectedName).map(issue => issue.message)
  if (problems.length) throw new ExpertSkillProblem(problems)
  const name = String(fields.name).trim()
  const metadata = fields.metadata
  const shown = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).displayName : undefined
  const displayName = typeof shown === 'string' ? shown.trim() : ''
  return { name, description: String(fields.description).trim(), ...(displayName && displayName !== name ? { displayName } : {}) }
}

/** The whole frontmatter, parsed like every other YAML here: unique keys, no aliases. The rules read the switches too. */
function frontmatter(bytes: Buffer): SkillManifestFields | undefined {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return undefined }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(BOM_PREFIX, '').replace(/\r\n?/g, '\n'))
  if (!match) return undefined
  try {
    const parsed = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' })
    if (parsed.errors.length) return undefined
    const meta: unknown = parsed.toJS({ maxAliasCount: 0 })
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
    return meta as SkillManifestFields
  } catch { return undefined }
}

function formatBytes(bytes: number) {
  return bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2 * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`
}
