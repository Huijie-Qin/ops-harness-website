import { parseDocument } from 'yaml'
import {
  EXPERT_LIMITS, SKILL_TREE_LIMITS, isIgnoredSkillPath, legacyClientIssues, skillManifestIssues, skillTreeIssues,
} from '@dsh-ops/expert-distribution-contract'
import { extractArchiveEntry, readArchive, type ArchiveEntry, type ArchiveLimits } from './knowledge-store.js'

/** Why a Skill of an expert cannot be used: one sentence per problem, as the admin page lists them. */
export class ExpertSkillProblem extends Error {
  constructor(readonly problems: string[]) { super(problems.join('；')) }
}

export interface ExpertSkillCheck {
  name: string
  description: string
  /** Why a client released before these rules (contract 0.1.x) would refuse this Skill; empty when it installs it. */
  legacy: string[]
}

// Folders and OS metadata count towards the entries, not the files; the content limits are the tree rules below.
const archiveLimits: ArchiveLimits = {
  maxBytes: EXPERT_LIMITS.skillBytes, maxEntries: SKILL_TREE_LIMITS.archiveEntries, maxExtractedBytes: Number.MAX_SAFE_INTEGER,
  maxDepth: SKILL_TREE_LIMITS.depth + 1, code: 'INVALID_EXPERT_SKILL',
}
const BOM_PREFIX = new RegExp('^' + String.fromCharCode(0xfeff))

/**
 * One Skill of an expert checked by the rules every side of expert distribution applies (contract
 * `skill-tree`, the same as the product's 我的技能): a ZIP holds the Skill folder at its root or as its only top
 * folder, a `SKILL.md` deeper inside is an ordinary file, OS metadata is left out, the description has no length
 * limit. `.md` is a lone `SKILL.md`. `expectedName` is the name the Skill travels under in a package.
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
  catch { throw new ExpertSkillProblem([`压缩包无法读取：只支持普通 ZIP（存储或 deflate 压缩），不支持加密、ZIP64、分卷、符号链接、重复的文件名或超过 ${SKILL_TREE_LIMITS.archiveEntries} 个条目`]) }
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

function manifestOf(bytes: Buffer, expectedName: string | undefined): { name: string; description: string } {
  const fields = frontmatter(bytes)
  if (!fields) throw new ExpertSkillProblem(['SKILL.md 开头缺少用 --- 包起来的 name 与 description，或格式不正确'])
  const problems = skillManifestIssues(fields, expectedName).map(issue => issue.message)
  if (problems.length) throw new ExpertSkillProblem(problems)
  return { name: String(fields.name).trim(), description: String(fields.description).trim() }
}

/** `name` and `description` of the frontmatter, parsed like every other YAML here: unique keys, no aliases. */
function frontmatter(bytes: Buffer): { name: unknown; description: unknown } | undefined {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return undefined }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(BOM_PREFIX, '').replace(/\r\n?/g, '\n'))
  if (!match) return undefined
  try {
    const parsed = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' })
    if (parsed.errors.length) return undefined
    const meta: unknown = parsed.toJS({ maxAliasCount: 0 })
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
    const record = meta as Record<string, unknown>
    return { name: record.name, description: record.description }
  } catch { return undefined }
}

function formatBytes(bytes: number) {
  return bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2 * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`
}
