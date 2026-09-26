<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  BUILTIN_CAPABILITIES, BUILTIN_CAPABILITY_LABELS, EXPERT_CATEGORIES, EXPERT_ICONS, EXPERT_ID_PATTERN, EXPERT_LIMITS,
  ONEBOX_SPACE_ID_PATTERN, SHARED_LIBRARY_ID_PATTERN, KNOWLEDGE_REF_PATTERN, normalizeEmployeeId,
} from '@dsh-ops/expert-distribution-contract'
import { ApiError, guideApi, requestMessage, uploadFile } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'
import ExpertToolLibrary from './ExpertToolLibrary.vue'

type Owner = { name: string; employeeId: string; contact?: string }
type SkillRow = { name: string; sha256: string; size: number; kind: 'zip' | 'md'; required: boolean; fileName?: string }
type ToolRef = { toolId: string; required: boolean } | { customTool: string; required: boolean }
type KnowledgeRef = { kind: 'metric'; knowledgeId: string; name?: string; required: boolean }
  | { kind: 'onebox'; ref: string; name: string; description?: string; spaceId?: string; sharedLibraryId?: string; required: boolean }
type Visibility = { mode: 'everyone' } | { mode: 'allowlist'; employeeIds: string[] }
type Draft = {
  name: string; summary: string; appearance: { icon: string; accent: string; background: string }; categoryIds: string[]; tags: string[]
  starterPrompts: string[]; sortOrder: number; builtinTools: string[]; responsibility: string; skills: SkillRow[]; tools: ToolRef[]
  knowledge: KnowledgeRef[]; owner?: Owner
}
type Expert = {
  id: string; presetId: string; draft: Draft; draftChanged: boolean
  distribution: { status: 'active' | 'disabled'; visibility: Visibility; allowClone: boolean }
  published?: { version: number; publishedAt: string }; importedFrom?: { expertId: string; employeeId?: string; importedAt: string }
  createdAt: string; updatedAt: string
}
type Summary = { id: string; name: string; status: 'active' | 'disabled'; published?: { version: number }; draftChanged: boolean; visibility: { mode: 'everyone' } | { mode: 'allowlist'; count: number }; owner?: Owner }
type Options = { tools: Array<{ id: string; name: string }>; metrics: Array<{ id: string; name: string; enabled: boolean }>; customTools: Array<{ key: string; name: string; serverName: string; transport: 'stdio' | 'streamable-http' }> }
type ImportToolRow = {
  key: string; name: string; transport: 'stdio' | 'streamable-http'; serverName: string; url?: string; command?: string; args: string[]
  credentials: Array<{ key: string; label: string; hint?: string; location: { kind: 'header' | 'env'; name: string } }>
  resolution: 'new' | 'reuse' | 'conflict'; libraryKey: string; rename?: { key: string; serverName: string }; affected?: Array<{ id: string; name: string }>; warnings: string[]
}
type Preview = {
  importId: string; expiresAt: string; origin: { expertId: string; employeeId?: string; exportedAt: string; appVersion?: string }
  expert: { name: string; summary: string; owner: Owner; categoryIds: string[]; builtinTools: string[]; releaseNote?: string }
  skills: Array<{ name: string; size: number; required: boolean }>
  tools: Array<{ toolId?: string; customTool?: string; name: string; required: boolean; known: boolean }>
  customTools: ImportToolRow[]
  knowledge: Array<KnowledgeRef & { status: 'ok' | 'missing' | 'disabled' | 'unsynced'; label: string }>
  suggestedAllowlist: string[]; target: { mode: 'create' | 'update'; id: string }
  existing?: { id: string; name: string; published?: { version: number } }
  changes?: { responsibility: boolean; skills: { added: string[]; removed: string[]; updated: string[] }; tools: { added: string[]; removed: string[] }; knowledge: { added: string[]; removed: string[] }; owner: boolean; basics: boolean }
  warnings: string[]; errors: string[]
}
type OneboxRow = { ref: string; name: string; description: string; spaceId: string; sharedLibraryId: string; required: boolean }
type Form = {
  name: string; summary: string; icon: string; accent: string; background: string; categoryIds: string[]; tags: string; starterPrompts: string
  sortOrder: number; builtinTools: string[]; responsibility: string; skills: SkillRow[]
  tools: Record<string, { selected: boolean; required: boolean }>; customTools: Record<string, { selected: boolean; required: boolean }>; metrics: Record<string, { selected: boolean; required: boolean }>
  onebox: OneboxRow[]; ownerName: string; ownerEmployeeId: string; ownerContact: string
}
type DistributionForm = { status: 'active' | 'disabled'; mode: 'everyone' | 'allowlist'; employeeIds: string; allowClone: boolean }

const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; dirty: [v: boolean]; busy: [v: boolean] }>()
const iconLabels: Record<string, string> = { sparkles: '星光', document: '文档', megaphone: '喇叭', design: '设计', analytics: '分析', briefcase: '公文包', research: '研究', code: '代码', shield: '盾牌' }
const items = ref<Summary[]>([]), revision = ref(''), current = ref<Expert>(), options = ref<Options>({ tools: [], metrics: [], customTools: [] })
/** 专家 / 自定义工具 sub-pages; the tool library reports its own unsaved edits and busy state. */
const tab = ref<'experts' | 'tools'>('experts'), toolDirty = ref(false), toolBusy = ref(false)
const form = ref<Form>(), baseline = ref(''), distribution = ref<DistributionForm>(), distributionBaseline = ref('')
const busy = ref(false), loading = ref(true), notice = ref(''), error = ref(''), issues = ref<string[]>([])
const progress = ref(0), uploadName = ref(''), skillRequired = ref(true)
const errorElement = ref<HTMLElement>(), skillInput = ref<HTMLInputElement>(), packageInput = ref<HTMLInputElement>(), nameInput = ref<HTMLInputElement>()
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const creating = ref<{ id: string; name: string }>()
const importing = ref<{ phase: 'choose' | 'uploading' | 'preview'; preview?: Preview; targetMode: 'create' | 'update'; targetId: string; adoptAllowlist: boolean; publish: boolean; toolChoices: Record<string, 'update' | 'rename'> }>()
const lifetime = new AbortController()
let upload: AbortController | undefined

const dirty = computed(() => form.value !== undefined && JSON.stringify(form.value) !== baseline.value)
const distributionDirty = computed(() => distribution.value !== undefined && JSON.stringify(distribution.value) !== distributionBaseline.value)
watch([dirty, distributionDirty, toolDirty], ([a, b, c]) => emit('dirty', a || b || c)); watch([busy, toolBusy], ([a, b]) => emit('busy', a || b))
/** Conflicts the admin still has to resolve before the import can be applied. */
const unresolvedTools = computed(() => (importing.value?.preview?.customTools ?? []).filter(row => row.resolution === 'conflict' && !importing.value?.toolChoices[row.key]))
const call = <T,>(url: string, init: { method?: string; data?: unknown; timeout?: number } = {}) => guideApi<T>(url, { ...init, csrf: props.csrf, signal: lifetime.signal })
const allowlist = computed(() => (distribution.value?.employeeIds ?? '').split(/[\s,，;；]+/).map(value => value.trim()).filter(Boolean))
const invalidEmployees = computed(() => allowlist.value.filter(value => normalizeEmployeeId(value) === undefined))
const responsibilityBytes = computed(() => new TextEncoder().encode(form.value?.responsibility ?? '').byteLength)

async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; notice.value = ''; error.value = ''; issues.value = []
  try { await fn() } catch (e) {
    error.value = e instanceof ApiError ? e.message : requestMessage(e)
    issues.value = e instanceof ApiError ? e.issues : []
    if (e instanceof ApiError && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(e.code)) emit('error', e)
    await nextTick(); errorElement.value?.focus()
  } finally { busy.value = false }
}
async function list() {
  const [catalog, choices] = await Promise.all([
    call<{ revision: string; experts: Summary[] }>('/api/admin/experts'),
    call<Options>('/api/admin/experts/options'),
  ])
  items.value = catalog.experts; revision.value = catalog.revision; options.value = choices
  loading.value = false
}
function formOf(draft: Draft): Form {
  const tools: Form['tools'] = {}, metrics: Form['metrics'] = {}, customTools: Form['customTools'] = {}
  for (const tool of options.value.customTools) {
    const ref = draft.tools.find(item => 'customTool' in item && item.customTool === tool.key)
    customTools[tool.key] = { selected: Boolean(ref), required: ref?.required ?? false }
  }
  for (const ref of draft.tools) if ('customTool' in ref && !customTools[ref.customTool]) customTools[ref.customTool] = { selected: true, required: ref.required }
  for (const tool of options.value.tools) {
    const ref = draft.tools.find(item => 'toolId' in item && item.toolId === tool.id)
    tools[tool.id] = { selected: Boolean(ref), required: ref?.required ?? false }
  }
  for (const ref of draft.tools) if ('toolId' in ref && !tools[ref.toolId]) tools[ref.toolId] = { selected: true, required: ref.required }
  for (const metric of options.value.metrics) {
    const ref = draft.knowledge.find(item => item.kind === 'metric' && item.knowledgeId === metric.id)
    metrics[metric.id] = { selected: Boolean(ref), required: ref?.required ?? false }
  }
  for (const ref of draft.knowledge) if (ref.kind === 'metric' && !metrics[ref.knowledgeId]) metrics[ref.knowledgeId] = { selected: true, required: ref.required }
  return {
    name: draft.name, summary: draft.summary, icon: draft.appearance.icon, accent: draft.appearance.accent, background: draft.appearance.background,
    categoryIds: [...draft.categoryIds], tags: draft.tags.join('\n'), starterPrompts: draft.starterPrompts.join('\n'), sortOrder: draft.sortOrder,
    builtinTools: [...draft.builtinTools], responsibility: draft.responsibility, skills: draft.skills.map(skill => ({ ...skill })), tools, customTools, metrics,
    onebox: draft.knowledge.flatMap(ref => ref.kind === 'onebox' ? [{ ref: ref.ref, name: ref.name, description: ref.description ?? '', spaceId: ref.spaceId ?? '', sharedLibraryId: ref.sharedLibraryId ?? '', required: ref.required }] : []),
    ownerName: draft.owner?.name ?? '', ownerEmployeeId: draft.owner?.employeeId ?? '', ownerContact: draft.owner?.contact ?? '',
  }
}
function adopt(expert: Expert, nextRevision?: string) {
  current.value = expert
  if (nextRevision) revision.value = nextRevision
  form.value = formOf(expert.draft); baseline.value = JSON.stringify(form.value)
  const visibility = expert.distribution.visibility
  distribution.value = { status: expert.distribution.status, mode: visibility.mode, employeeIds: visibility.mode === 'allowlist' ? visibility.employeeIds.join('\n') : '', allowClone: expert.distribution.allowClone }
  distributionBaseline.value = JSON.stringify(distribution.value)
}
function lines(value: string) { return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) }
function draftOf(value: Form): Draft {
  const knowledge: KnowledgeRef[] = []
  for (const [knowledgeId, state] of Object.entries(value.metrics)) {
    if (!state.selected) continue
    const name = options.value.metrics.find(metric => metric.id === knowledgeId)?.name
    knowledge.push({ kind: 'metric', knowledgeId, ...(name ? { name } : {}), required: state.required })
  }
  for (const row of value.onebox) {
    knowledge.push({ kind: 'onebox', ref: row.ref.trim(), name: row.name.trim(), ...(row.description.trim() ? { description: row.description.trim() } : {}), ...(row.spaceId.trim() ? { spaceId: row.spaceId.trim() } : {}), ...(row.sharedLibraryId.trim() ? { sharedLibraryId: row.sharedLibraryId.trim() } : {}), required: row.required })
  }
  const contact = value.ownerContact.trim()
  const employeeId = normalizeEmployeeId(value.ownerEmployeeId) ?? value.ownerEmployeeId.trim()
  return {
    name: value.name.trim(), summary: value.summary.trim(), appearance: { icon: value.icon, accent: value.accent.trim(), background: value.background.trim() },
    categoryIds: value.categoryIds, tags: lines(value.tags.replaceAll(/[,，]/g, '\n')), starterPrompts: lines(value.starterPrompts), sortOrder: Number(value.sortOrder),
    builtinTools: BUILTIN_CAPABILITIES.filter(item => value.builtinTools.includes(item)), responsibility: value.responsibility, skills: value.skills,
    tools: [
      ...Object.entries(value.tools).filter(([, state]) => state.selected).map(([toolId, state]) => ({ toolId, required: state.required })),
      ...Object.entries(value.customTools).filter(([, state]) => state.selected).map(([customTool, state]) => ({ customTool, required: state.required })),
    ],
    knowledge,
    ...(value.ownerName.trim() || value.ownerEmployeeId.trim() ? { owner: { name: value.ownerName.trim(), employeeId, ...(contact ? { contact } : {}) } } : {}),
  }
}
function localIssues(value: Form): string[] {
  const found: string[] = []
  if (!value.name.trim()) found.push('请填写名称')
  if (!value.summary.trim()) found.push('请填写简介')
  if (!/^#[0-9A-Fa-f]{6}$/.test(value.accent.trim()) || !/^#[0-9A-Fa-f]{6}$/.test(value.background.trim())) found.push('颜色请填写 #RRGGBB 格式')
  if (value.categoryIds.length > EXPERT_LIMITS.categories) found.push(`分类最多选择 ${EXPERT_LIMITS.categories} 个`)
  if (!Number.isSafeInteger(Number(value.sortOrder)) || Number(value.sortOrder) < 0 || Number(value.sortOrder) > 100000) found.push('排序请填写 0–100000 的整数')
  if ((value.ownerName.trim() || value.ownerEmployeeId.trim()) && (!value.ownerName.trim() || normalizeEmployeeId(value.ownerEmployeeId) === undefined)) found.push('负责人需要姓名和有效工号')
  for (const row of value.onebox) {
    if (!KNOWLEDGE_REF_PATTERN.test(row.ref.trim())) found.push(`个人知识库「${row.name || '未命名'}」的标识只能用小写字母、数字和连字符`)
    if (!row.name.trim()) found.push('个人知识库需要名称')
    if (row.spaceId.trim() && !ONEBOX_SPACE_ID_PATTERN.test(row.spaceId.trim())) found.push(`「${row.name}」的 Space ID 应为 1–20 位数字`)
    if (row.sharedLibraryId.trim() && !SHARED_LIBRARY_ID_PATTERN.test(row.sharedLibraryId.trim())) found.push(`「${row.name}」的共享库 ID 格式无效`)
  }
  if (new Set(value.onebox.map(row => row.ref.trim())).size !== value.onebox.length) found.push('个人知识库标识重复')
  return found
}
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value || distributionDirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '已保存的草稿、已发布的版本和分发设置都会保留。', label: '放弃修改', action }
  else action()
}
function select(id: string) { guard(() => void run(async () => { const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(id)}`); adopt(result.expert, result.revision) })) }
function startCreate() { guard(() => { creating.value = { id: '', name: '' }; error.value = ''; notice.value = '' }) }
async function submitCreate() {
  const value = creating.value
  if (!value || !value.name.trim()) return
  if (value.id.trim() && !EXPERT_ID_PATTERN.test(value.id.trim())) { error.value = '专家 ID 只能用小写字母、数字和连字符，最长 40 位；留空自动生成。'; return }
  await run(async () => {
    const draft: Draft = { name: value.name.trim(), summary: '请填写这位专家的职责简介。', appearance: { icon: 'sparkles', accent: '#4F46E5', background: '#EEF2FF' }, categoryIds: [], tags: [], starterPrompts: [], sortOrder: 1000, builtinTools: ['shell', 'filesystem', 'goal', 'todo'], responsibility: '', skills: [], tools: [], knowledge: [] }
    const result = await call<{ revision: string; expert: Expert }>('/api/admin/experts', { method: 'POST', data: { ...(value.id.trim() ? { id: value.id.trim() } : {}), draft, revision: revision.value } })
    creating.value = undefined; adopt(result.expert, result.revision); await list()
    notice.value = '已创建草稿。填写职责、负责人等信息后保存并发布。'
    await nextTick(); nameInput.value?.focus()
  })
}
async function saveDraft() {
  if (!current.value || !form.value) return
  const found = localIssues(form.value)
  if (found.length) { error.value = '请先修正以下问题：'; issues.value = found; await nextTick(); errorElement.value?.focus(); return }
  await run(async () => {
    const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(current.value!.id)}`, { method: 'PUT', data: { draft: draftOf(form.value!), revision: revision.value } })
    adopt(result.expert, result.revision); await list(); notice.value = current.value?.published ? '草稿已保存。发布后使用者才会收到这些修改。' : '草稿已保存。'
  })
}
async function publish() {
  const expert = current.value
  if (!expert) return
  if (dirty.value) { await saveDraft(); if (dirty.value || error.value) return }
  confirmation.value = {
    title: expert.published ? `发布第 ${expert.published.version + 1} 版？` : '发布这位专家？',
    message: `可见范围内的同事会在下次同步时收到这一版（通常 30 分钟内，打开专家页时立即同步）。${expert.distribution.visibility.mode === 'everyone' ? '当前为全员可见。' : `当前可见：负责人${expert.distribution.visibility.employeeIds.length ? ` + ${expert.distribution.visibility.employeeIds.length} 位同事` : '（仅负责人）'}。`}`,
    label: '发布',
    action: () => void run(async () => {
      const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(expert.id)}/publish`, { method: 'POST', data: { revision: revision.value } })
      adopt(result.expert, result.revision); await list(); notice.value = `已发布第 ${result.expert.published?.version} 版。`
    }),
  }
}
async function saveDistribution(next?: Partial<DistributionForm>) {
  const expert = current.value, value = distribution.value
  if (!expert || !value) return
  const merged = { ...value, ...next }
  if (merged.mode === 'allowlist' && invalidEmployees.value.length) { error.value = `以下工号格式无效：${invalidEmployees.value.slice(0, 5).join('、')}`; return }
  if (allowlist.value.length > EXPERT_LIMITS.allowlist) { error.value = `可见范围最多 ${EXPERT_LIMITS.allowlist} 个工号`; return }
  const employeeIds = [...new Set(allowlist.value.map(item => normalizeEmployeeId(item)!))]
  await run(async () => {
    const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(expert.id)}/distribution`, {
      method: 'PUT', data: { revision: revision.value, distribution: { status: merged.status, visibility: merged.mode === 'everyone' ? { mode: 'everyone' } : { mode: 'allowlist', employeeIds }, allowClone: merged.allowClone } },
    })
    const keepForm = dirty.value ? form.value : undefined
    adopt(result.expert, result.revision)
    if (keepForm) form.value = keepForm
    await list(); notice.value = merged.status === 'active' ? '分发设置已生效：使用者下次同步时按新范围看到或收回这位专家。' : '已下架：使用者下次同步时会收回这位专家，进行中的对话不受影响。'
  })
}
function toggleSale() {
  const expert = current.value
  if (!expert || !distribution.value) return
  if (expert.distribution.status === 'active') confirmation.value = { title: '下架这位专家？', message: '使用者下次同步时会收回这位专家：不再出现在专家市场，进行中的对话到重启前不受影响；他们克隆的副本保留。', label: '下架', action: () => void saveDistribution({ status: 'disabled' }) }
  else void saveDistribution({ status: 'active' })
}
function removeExpert() {
  const expert = current.value
  if (!expert) return
  confirmation.value = { title: '删除这位专家？', message: `${expert.draft.name} · ${expert.id}。使用者下次同步时会收回它；草稿与已发布版本移入回收记录，技能文件保留。`, label: '删除专家', action: () => void run(async () => {
    await call(`/api/admin/experts/${encodeURIComponent(expert.id)}`, { method: 'DELETE', data: { revision: revision.value } })
    current.value = undefined; form.value = undefined; distribution.value = undefined; baseline.value = ''; distributionBaseline.value = ''
    await list(); notice.value = '专家已删除。'
  }) }
}
async function sendSkill(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], expert = current.value
  if (!file || !expert) return
  await run(async () => {
    upload = new AbortController()
    try {
      if (file.size > EXPERT_LIMITS.skillBytes) throw new ApiError('UPLOAD_TOO_LARGE')
      if (!/\.(zip|md)$/i.test(file.name)) throw new ApiError('INVALID_SKILL_FILE')
      uploadName.value = file.name; progress.value = 0
      const result = await uploadFile<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(expert.id)}/skills?name=${encodeURIComponent(file.name)}&required=${skillRequired.value}`, file,
        { csrf: props.csrf, revision: revision.value, signal: upload.signal, progress: v => progress.value = v })
      adopt(result.expert, result.revision); await list(); notice.value = '技能已校验并加入草稿，发布后使用者会收到。'
    } catch (e) { if (upload.signal.aborted) notice.value = '上传已取消。'; else throw e }
    finally { uploadName.value = ''; input.value = '' }
  })
}
function detachSkill(name: string) {
  const expert = current.value
  if (!expert) return
  confirmation.value = { title: `从草稿移除技能 ${name}？`, message: '发布后使用者的这位专家不再带有该技能。已上传的文件按内容哈希保留。', label: '移除技能', action: () => void run(async () => {
    const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(expert.id)}/skills/${encodeURIComponent(name)}`, { method: 'DELETE', data: { revision: revision.value } })
    adopt(result.expert, result.revision); await list(); notice.value = '技能已从草稿移除。'
  }) }
}
function addOnebox() {
  if (!form.value) return
  let index = form.value.onebox.length + 1
  while (form.value.onebox.some(row => row.ref === `kb-${index}`)) index++
  form.value.onebox.push({ ref: `kb-${index}`, name: '', description: '', spaceId: '', sharedLibraryId: '', required: false })
}
function startImport() { guard(() => { importing.value = { phase: 'choose', targetMode: 'create', targetId: '', adoptAllowlist: true, publish: false, toolChoices: {} }; error.value = ''; notice.value = ''; issues.value = [] }) }
function switchTab(next: 'experts' | 'tools') {
  if (next === tab.value || busy.value || toolBusy.value) return
  const go = () => { tab.value = next; toolDirty.value = false; error.value = ''; notice.value = ''; if (next === 'experts') void run(list) }
  if (tab.value === 'tools' && toolDirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '工具库中已保存的配置不受影响。', label: '放弃修改', action: go }
  else guard(go)
}
function tabKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  switchTab(tab.value === 'experts' ? 'tools' : 'experts')
  void nextTick(() => (document.querySelector('.expert-tabs [aria-selected="true"]') as HTMLElement | null)?.focus())
}
function resolutionText(row: ImportToolRow) {
  if (row.resolution === 'new') return `新增到工具库（${row.libraryKey}）`
  if (row.resolution === 'reuse') return `工具库已有相同配置，直接复用（${row.libraryKey}）`
  return `工具库已有同名服务「${row.serverName}」但配置不同`
}
async function sendPackage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], state = importing.value
  if (!file || !state) return
  await run(async () => {
    upload = new AbortController()
    try {
      if (file.size > EXPERT_LIMITS.packageBytes) throw new ApiError('UPLOAD_TOO_LARGE')
      state.phase = 'uploading'; uploadName.value = file.name; progress.value = 0
      const result = await uploadFile<{ preview: Preview }>('/api/admin/experts/import', file, { csrf: props.csrf, signal: upload.signal, progress: v => progress.value = v })
      state.preview = result.preview; state.phase = 'preview'
      state.targetMode = result.preview.target.mode; state.targetId = result.preview.target.id
      state.publish = Boolean(result.preview.existing?.published) && !result.preview.errors.length
    } catch (e) { state.phase = 'choose'; if (upload.signal.aborted) notice.value = '上传已取消。'; else throw e }
    finally { uploadName.value = ''; input.value = '' }
  })
}
async function applyImport() {
  const state = importing.value, preview = state?.preview
  if (!state || !preview || preview.errors.length) return
  if (state.targetMode === 'create' && !EXPERT_ID_PATTERN.test(state.targetId.trim())) { error.value = '专家 ID 只能用小写字母、数字和连字符，最长 40 位。'; return }
  await run(async () => {
    const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/import/${preview.importId}/apply`, {
      method: 'POST', timeout: 120000,
      data: { target: { mode: state.targetMode, id: state.targetMode === 'create' ? state.targetId.trim() : state.targetId }, adoptAllowlist: state.adoptAllowlist, publish: state.publish, tools: state.toolChoices, revision: revision.value },
    })
    importing.value = undefined; adopt(result.expert, result.revision); await list()
    notice.value = state.publish ? `已导入并发布第 ${result.expert.published?.version} 版。` : '已导入为草稿，请确认可见范围后发布。'
  })
}
function cancelImport() {
  const preview = importing.value?.preview
  upload?.abort(); importing.value = undefined
  if (preview) void call(`/api/admin/experts/import/${preview.importId}`, { method: 'DELETE' }).catch(() => {})
}
function reload() {
  guard(() => void run(async () => {
    const id = current.value?.id
    await list()
    if (id && items.value.some(item => item.id === id)) { const result = await call<{ revision: string; expert: Expert }>(`/api/admin/experts/${encodeURIComponent(id)}`); adopt(result.expert, result.revision) }
    else { current.value = undefined; form.value = undefined; distribution.value = undefined }
  }))
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB` }
function statusText(item: Summary) {
  if (!item.published) return '未发布'
  return `v${item.published.version} · ${item.status === 'active' ? '上架中' : '已下架'}${item.draftChanged ? ' · 有未发布修改' : ''}`
}
function visibilityText(item: Summary) {
  return item.visibility.mode === 'everyone' ? '全员可见' : item.visibility.count ? `负责人 + ${item.visibility.count} 人` : '仅负责人'
}
function knowledgeStatus(status: string) { return status === 'ok' ? '可用' : status === 'missing' ? '官网没有这个指标库' : status === 'disabled' ? '已下架' : '负责人尚未同步 OneBox' }
onMounted(() => run(list))
onBeforeUnmount(() => { lifetime.abort(); upload?.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section class="expert-manager" :aria-busy="busy || toolBusy">
    <div class="expert-tabs" role="tablist" aria-label="专家分发">
      <button id="expert-tab-experts" type="button" role="tab" :aria-selected="tab === 'experts'" :tabindex="tab === 'experts' ? 0 : -1" aria-controls="expert-panel" :disabled="busy || toolBusy" @click="switchTab('experts')" @keydown="tabKey">专家</button>
      <button id="expert-tab-tools" type="button" role="tab" :aria-selected="tab === 'tools'" :tabindex="tab === 'tools' ? 0 : -1" aria-controls="expert-panel" :disabled="busy || toolBusy" @click="switchTab('tools')" @keydown="tabKey">自定义工具</button>
    </div>
    <div id="expert-panel" role="tabpanel" :aria-labelledby="tab === 'experts' ? 'expert-tab-experts' : 'expert-tab-tools'">
    <ExpertToolLibrary v-if="tab === 'tools'" :csrf="csrf" @error="emit('error', $event)" @dirty="toolDirty = $event" @busy="toolBusy = $event" />
    <template v-else>
    <div class="editor-heading">
      <div><h2>专家分发</h2><p>导入创建者导出的专家包，或直接编辑；设置可见范围后发布，使用者的工作助手会自动收到，无需发版。</p></div>
      <div class="admin-actions">
        <button class="button secondary" :disabled="busy" @click="reload">刷新列表</button>
        <button class="button secondary" :disabled="busy" @click="startCreate">新建专家</button>
        <button class="button primary" :disabled="busy" @click="startImport">导入专家包</button>
      </div>
    </div>
    <div v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}<ul v-if="issues.length" class="expert-issues"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul></div>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div class="admin-layout">
      <aside class="admin-sidebar release-sidebar">
        <h3>专家</h3>
        <p v-if="loading" class="editor-help">正在加载…</p>
        <p v-else-if="!items.length" class="editor-help">还没有专家。导入一个专家包开始。</p>
        <nav aria-label="专家列表"><button v-for="item in items" :key="item.id" :disabled="busy" :aria-current="current?.id === item.id ? 'page' : undefined" @click="select(item.id)"><span>{{ item.name }}</span><small>{{ item.id }}<br />{{ statusText(item) }} · {{ visibilityText(item) }}</small></button></nav>
      </aside>
      <section v-if="current && form && distribution" class="admin-workspace release-workspace">
        <div class="editor-heading">
          <div><h3>{{ current.draft.name }}</h3><p>{{ dirty ? '有未保存的修改' : current.published ? (current.draftChanged ? `已发布 v${current.published.version}，草稿有未发布的修改` : `已发布 v${current.published.version}`) : '尚未发布' }}</p></div>
          <div class="admin-actions">
            <button class="button secondary" :disabled="busy || !dirty" @click="saveDraft">保存草稿</button>
            <button class="button primary" :disabled="busy || (!dirty && current.published !== undefined && !current.draftChanged)" @click="publish">{{ current.published ? '发布新版本' : '发布' }}</button>
          </div>
        </div>
        <div class="release-identity">
          <span><small>专家 ID</small><strong>{{ current.id }}</strong></span>
          <span><small>工作助手内的标识</small><strong>{{ current.presetId }}</strong></span>
          <span v-if="current.published"><small>最近发布</small><strong>{{ new Date(current.published.publishedAt).toLocaleString('zh-CN') }}</strong></span>
          <span v-if="current.importedFrom"><small>导入来源</small><strong>{{ current.importedFrom.employeeId ?? '未知工号' }} · {{ new Date(current.importedFrom.importedAt).toLocaleString('zh-CN') }}</strong></span>
        </div>

        <form class="expert-distribution" @submit.prevent="saveDistribution()">
          <fieldset :disabled="busy">
            <legend><h4>分发设置（保存即生效）</h4></legend>
            <div class="expert-choice-row" role="radiogroup" aria-label="可见范围">
              <label class="check-label"><input v-model="distribution.mode" type="radio" value="allowlist" />指定工号（负责人始终可见）</label>
              <label class="check-label"><input v-model="distribution.mode" type="radio" value="everyone" />全员可见</label>
            </div>
            <label v-if="distribution.mode === 'allowlist'" class="release-notes">可见工号<textarea v-model="distribution.employeeIds" rows="5" placeholder="每行一个工号，也可用逗号分隔；留空表示仅负责人可见"></textarea><small>{{ allowlist.length }} 个工号{{ invalidEmployees.length ? `，其中 ${invalidEmployees.length} 个格式无效` : '' }}。工号不区分大小写。</small></label>
            <label class="check-label"><input v-model="distribution.allowClone" type="checkbox" />允许使用者克隆为自己的专家（克隆后不再随云端更新）</label>
            <div class="admin-actions expert-distribution-actions">
              <button class="button secondary" :disabled="busy || !distributionDirty">保存分发设置</button>
              <button type="button" class="button secondary" :disabled="busy || !current.published" @click="toggleSale">{{ current.distribution.status === 'active' ? '下架' : '重新上架' }}</button>
            </div>
          </fieldset>
        </form>

        <form @submit.prevent="saveDraft">
          <fieldset :disabled="busy">
            <h4 class="expert-section-title">基本信息</h4>
            <div class="chapter-fields">
              <label>名称<input ref="nameInput" v-model="form.name" required :maxlength="EXPERT_LIMITS.nameLength" /></label>
              <label>排序<input v-model.number="form.sortOrder" type="number" min="0" max="100000" /><small>越小越靠前；随包预置专家在 10–100 之间。</small></label>
              <label class="chapter-summary-field">简介<textarea v-model="form.summary" rows="2" required :maxlength="EXPERT_LIMITS.summaryLength"></textarea></label>
              <label>强调色<input v-model="form.accent" maxlength="7" placeholder="#2F6BFF" /></label>
              <label>背景色<input v-model="form.background" maxlength="7" placeholder="#EEF3FF" /></label>
            </div>
            <fieldset class="expert-choices"><legend>图标</legend><label v-for="icon in EXPERT_ICONS" :key="icon" class="check-label"><input v-model="form.icon" type="radio" :value="icon" />{{ iconLabels[icon] ?? icon }}</label></fieldset>
            <fieldset class="expert-choices"><legend>分类（最多 {{ EXPERT_LIMITS.categories }} 个）</legend><label v-for="category in EXPERT_CATEGORIES" :key="category.id" class="check-label"><input v-model="form.categoryIds" type="checkbox" :value="category.id" />{{ category.name }}<small v-if="!category.enabled">（工作助手未开放此分类筛选）</small></label></fieldset>
            <div class="chapter-fields">
              <label>标签<textarea v-model="form.tags" rows="3" placeholder="每行一个"></textarea><small>最多 {{ EXPERT_LIMITS.tags }} 个。</small></label>
              <label>Prompt 建议<textarea v-model="form.starterPrompts" rows="3" placeholder="每行一条"></textarea><small>显示在专家卡片上，最多 {{ EXPERT_LIMITS.starterPrompts }} 条。</small></label>
            </div>

            <h4 class="expert-section-title">职责（AGENTS.md）</h4>
            <label class="release-notes">职责全文<textarea v-model="form.responsibility" class="expert-responsibility" rows="12" spellcheck="false"></textarea><small>{{ size(responsibilityBytes) }} / 64 KiB。选择这位专家的会话会持续遵循这些规则。</small></label>

            <fieldset class="expert-choices"><legend>基础能力</legend><label v-for="capability in BUILTIN_CAPABILITIES" :key="capability" class="check-label"><input v-model="form.builtinTools" type="checkbox" :value="capability" />{{ BUILTIN_CAPABILITY_LABELS[capability] }}</label></fieldset>

            <h4 class="expert-section-title">技能</h4>
            <div class="admin-actions">
              <input ref="skillInput" class="file-input" type="file" accept=".zip,.md" tabindex="-1" aria-label="选择技能文件" :disabled="busy || dirty" @change="sendSkill" />
              <label class="check-label"><input v-model="skillRequired" type="checkbox" />上传为必需技能</label>
              <button type="button" class="button secondary" :disabled="busy || dirty" @click="skillInput?.click()">上传技能</button>
              <button v-if="uploadName" type="button" class="button secondary" @click="upload?.abort()">取消上传</button>
            </div>
            <p v-if="dirty" class="editor-help">请先保存草稿，再上传或移除技能。</p>
            <div v-if="uploadName" class="upload-progress" role="status"><span>{{ uploadName }}</span><progress :value="progress" max="100"></progress>{{ progress }}%</div>
            <article v-for="skill in form.skills" :key="skill.name" class="package-file">
              <div><strong>{{ skill.name }}</strong><small>{{ skill.fileName ?? `${skill.name}.${skill.kind}` }} · {{ size(skill.size) }}</small></div>
              <label class="check-label"><input v-model="skill.required" type="checkbox" />必需</label>
              <button type="button" :disabled="busy || dirty" @click="detachSkill(skill.name)">移除</button>
            </article>
            <p v-if="!form.skills.length" class="editor-help">还没有技能。</p>

            <h4 class="expert-section-title">知识库</h4>
            <fieldset class="expert-choices expert-rows"><legend>云端指标知识库</legend>
              <p v-if="!Object.keys(form.metrics).length" class="editor-help">官网“知识库”中还没有指标知识库。</p>
              <div v-for="(state, id) in form.metrics" :key="id" class="expert-row"><label class="check-label"><input v-model="state.selected" type="checkbox" />{{ options.metrics.find(metric => metric.id === id)?.name ?? id }}<small>{{ id }}{{ options.metrics.find(metric => metric.id === id) ? (options.metrics.find(metric => metric.id === id)!.enabled ? '' : ' · 已下架') : ' · 官网已不存在' }}</small></label><label v-if="state.selected" class="check-label"><input v-model="state.required" type="checkbox" />必需</label></div>
            </fieldset>
            <fieldset class="expert-choices expert-rows"><legend>OneBox 个人知识库</legend>
              <div v-for="(row, index) in form.onebox" :key="index" class="expert-onebox">
                <div class="chapter-fields">
                  <label>名称<input v-model="row.name" maxlength="60" /></label>
                  <label>标识<input v-model="row.ref" maxlength="40" /><small>专家内唯一，只用小写字母、数字和连字符。</small></label>
                  <label>Space ID<input v-model="row.spaceId" maxlength="20" inputmode="numeric" placeholder="负责人同步后填写" /><small :class="{ 'expert-warning': !row.spaceId.trim() }">{{ row.spaceId.trim() ? '使用者首次使用时会引导导入这个 Space' : '负责人尚未同步 OneBox：使用者会被提示联系负责人同步' }}</small></label>
                  <label>共享库 ID（可选）<input v-model="row.sharedLibraryId" maxlength="100" /></label>
                  <label class="chapter-summary-field">说明<input v-model="row.description" maxlength="300" /></label>
                </div>
                <div class="admin-actions"><label class="check-label"><input v-model="row.required" type="checkbox" />必需</label><button type="button" class="button secondary" @click="form.onebox.splice(index, 1)">移除</button></div>
              </div>
              <button type="button" class="button secondary" :disabled="form.onebox.length >= EXPERT_LIMITS.knowledge" @click="addOnebox">添加个人知识库</button>
            </fieldset>

            <h4 class="expert-section-title">工具</h4>
            <fieldset class="expert-choices expert-rows"><legend>内置工具（首次使用时自动添加）</legend>
              <div v-for="(state, id) in form.tools" :key="id" class="expert-row"><label class="check-label"><input v-model="state.selected" type="checkbox" />{{ options.tools.find(tool => tool.id === id)?.name ?? id }}<small>{{ id }}</small></label><label v-if="state.selected" class="check-label"><input v-model="state.required" type="checkbox" />必需</label></div>
            </fieldset>
            <fieldset class="expert-choices expert-rows"><legend>自定义工具（官网工具库；令牌由使用者首次使用时自己填写）</legend>
              <p v-if="!Object.keys(form.customTools).length" class="editor-help">工具库中还没有自定义工具。导入带自定义工具的专家包时会自动加入，可在“自定义工具”页签管理。</p>
              <div v-for="(state, key) in form.customTools" :key="key" class="expert-row"><label class="check-label"><input v-model="state.selected" type="checkbox" />{{ options.customTools.find(tool => tool.key === key)?.name ?? key }}<small>{{ key }}{{ options.customTools.find(tool => tool.key === key) ? ` · ${options.customTools.find(tool => tool.key === key)!.serverName}` : ' · 工具库中已不存在' }}</small></label><label v-if="state.selected" class="check-label"><input v-model="state.required" type="checkbox" />必需</label></div>
            </fieldset>

            <h4 class="expert-section-title">负责人</h4>
            <div class="chapter-fields">
              <label>姓名<input v-model="form.ownerName" :maxlength="EXPERT_LIMITS.ownerNameLength" /></label>
              <label>工号<input v-model="form.ownerEmployeeId" maxlength="64" /><small>负责人始终能看到这位专家；使用者遇到需要负责人处理的问题时会看到姓名与工号。</small></label>
              <label class="chapter-summary-field">联系方式（可选）<input v-model="form.ownerContact" :maxlength="EXPERT_LIMITS.contactLength" placeholder="例如 WeLink 群名或邮箱" /></label>
            </div>
            <div class="admin-actions expert-save-row"><button class="button primary" :disabled="busy || !dirty">{{ busy ? '处理中…' : '保存草稿' }}</button></div>
          </fieldset>
        </form>
        <div class="editor-bottom"><button :disabled="busy" @click="removeExpert">删除专家</button></div>
      </section>
      <div v-else class="admin-empty">导入专家包，或从左侧选择一位专家。</div>
    </div>
    </template>
    </div>

    <WebsiteDialog v-if="creating" title="新建专家" message="创建空白草稿，之后在右侧填写职责、技能、知识库、工具与负责人。" confirm-label="创建草稿" :confirm-disabled="busy || !creating.name.trim()" @cancel="!busy && (creating = undefined)" @confirm="submitCreate">
      <fieldset class="management-fields" :disabled="busy">
        <label>名称<input v-model="creating.name" :maxlength="EXPERT_LIMITS.nameLength" @keydown.enter.prevent="submitCreate" /></label>
        <label>专家 ID（可选）<input v-model="creating.id" maxlength="40" placeholder="例如 push-ops，留空自动生成" /><small>创建后不可修改；工作助手中显示为 cloud-&lt;ID&gt;。</small></label>
      </fieldset>
    </WebsiteDialog>

    <WebsiteDialog v-if="importing" title="导入专家包" :message="importing.phase === 'preview' ? '核对下面的内容后导入。导入不会改变已发布的版本，除非勾选“同时发布”。' : '选择创建者在工作助手“我的专家”中导出的 .expert.zip 文件。'" :confirm-label="importing.phase === 'preview' ? (importing.publish ? '导入并发布' : '导入为草稿') : '选择文件'" :confirm-disabled="busy || importing.phase === 'uploading' || (importing.phase === 'preview' && (Boolean(importing.preview?.errors.length) || unresolvedTools.length > 0))" @cancel="cancelImport" @confirm="importing.phase === 'preview' ? applyImport() : packageInput?.click()">
      <input ref="packageInput" class="file-input" type="file" accept=".zip" tabindex="-1" aria-label="选择专家包" @change="sendPackage" />
      <div v-if="uploadName" class="upload-progress" role="status"><span>{{ uploadName }}</span><progress :value="progress" max="100"></progress>{{ progress }}% · {{ progress === 100 ? '正在校验…' : '上传中' }}</div>
      <div v-if="importing.preview" class="expert-preview">
        <p class="expert-preview-title"><strong>{{ importing.preview.expert.name }}</strong> · 负责人 {{ importing.preview.expert.owner.name }}（{{ importing.preview.expert.owner.employeeId }}）<br /><small>导出于 {{ new Date(importing.preview.origin.exportedAt).toLocaleString('zh-CN') }}{{ importing.preview.origin.appVersion ? ` · 工作助手 ${importing.preview.origin.appVersion}` : '' }}</small></p>
        <p v-if="importing.preview.expert.releaseNote" class="editor-help">更新说明：{{ importing.preview.expert.releaseNote }}</p>
        <ul v-if="importing.preview.errors.length" class="admin-error expert-issues" role="alert"><li v-for="item in importing.preview.errors" :key="item">{{ item }}</li></ul>
        <ul v-if="importing.preview.warnings.length" class="expert-warnings"><li v-for="item in importing.preview.warnings" :key="item">{{ item }}</li></ul>
        <fieldset class="expert-choices" :disabled="busy"><legend>导入到</legend>
          <label v-if="importing.preview.existing" class="check-label"><input v-model="importing.targetMode" type="radio" value="update" @change="importing.targetId = importing.preview!.existing!.id" />更新已有专家「{{ importing.preview.existing.name }}」（{{ importing.preview.existing.id }}{{ importing.preview.existing.published ? ` · 已发布 v${importing.preview.existing.published.version}` : '' }}）</label>
          <label class="check-label"><input v-model="importing.targetMode" type="radio" value="create" @change="importing.targetId = importing.preview!.target.mode === 'create' ? importing.preview!.target.id : ''" />新建专家</label>
          <label v-if="importing.targetMode === 'create'" class="expert-inline-field">专家 ID<input v-model="importing.targetId" maxlength="40" /></label>
        </fieldset>
        <div v-if="importing.targetMode === 'update' && importing.preview.changes" class="expert-changes">
          <strong>与当前草稿相比</strong>
          <ul>
            <li>职责：{{ importing.preview.changes.responsibility ? '有变化' : '无变化' }}；名称、简介等：{{ importing.preview.changes.basics ? '有变化' : '无变化' }}；负责人：{{ importing.preview.changes.owner ? '有变化' : '无变化' }}</li>
            <li v-if="importing.preview.changes.skills.added.length">新增技能：{{ importing.preview.changes.skills.added.join('、') }}</li>
            <li v-if="importing.preview.changes.skills.updated.length">更新技能：{{ importing.preview.changes.skills.updated.join('、') }}</li>
            <li v-if="importing.preview.changes.skills.removed.length">移除技能：{{ importing.preview.changes.skills.removed.join('、') }}</li>
            <li v-if="importing.preview.changes.tools.added.length || importing.preview.changes.tools.removed.length">工具：+{{ importing.preview.changes.tools.added.length }} / -{{ importing.preview.changes.tools.removed.length }}</li>
            <li v-if="importing.preview.changes.knowledge.added.length || importing.preview.changes.knowledge.removed.length">知识库：+{{ importing.preview.changes.knowledge.added.length }} / -{{ importing.preview.changes.knowledge.removed.length }}</li>
          </ul>
        </div>
        <dl class="expert-preview-list">
          <dt>技能（{{ importing.preview.skills.length }}）</dt><dd>{{ importing.preview.skills.map(skill => `${skill.name}${skill.required ? '（必需）' : ''}`).join('、') || '无' }}</dd>
          <dt>工具（{{ importing.preview.tools.length }}）</dt><dd>{{ importing.preview.tools.map(tool => `${tool.name}${tool.required ? '（必需）' : ''}${tool.known ? '' : '（未知）'}`).join('、') || '无' }}</dd>
          <template v-if="importing.preview.customTools.length"><dt>自定义工具</dt><dd>
            <div v-for="row in importing.preview.customTools" :key="row.key" class="expert-import-tool">
              <strong>{{ row.name }}</strong><small>{{ row.transport === 'stdio' ? `运行命令：${[row.command, ...row.args].join(' ')}` : row.url }}</small>
              <span :class="{ 'expert-warning': row.resolution === 'conflict' }">{{ resolutionText(row) }}</span>
              <small v-if="row.credentials.length">凭据项（使用者首次使用时自己填写）：{{ row.credentials.map(slot => slot.label).join('、') }}</small>
              <fieldset v-if="row.resolution === 'conflict'" class="expert-choices" :disabled="busy"><legend>如何处理</legend>
                <label class="check-label"><input v-model="importing.toolChoices[row.key]" type="radio" value="update" />更新已有工具{{ row.affected?.length ? `（同时影响已发布的 ${row.affected.map(item => `「${item.name}」`).join('、')}）` : '' }}</label>
                <label class="check-label"><input v-model="importing.toolChoices[row.key]" type="radio" value="rename" />改名后新增为 {{ row.rename?.serverName }}（模型看到的工具名随之改变）</label>
              </fieldset>
            </div>
          </dd></template>
          <dt>知识库（{{ importing.preview.knowledge.length }}）</dt><dd><span v-for="ref in importing.preview.knowledge" :key="ref.kind === 'metric' ? ref.knowledgeId : ref.ref" class="expert-knowledge-chip" :class="`is-${ref.status}`">{{ ref.label }} · {{ knowledgeStatus(ref.status) }}</span><template v-if="!importing.preview.knowledge.length">无</template></dd>
        </dl>
        <label v-if="importing.preview.suggestedAllowlist.length" class="check-label"><input v-model="importing.adoptAllowlist" type="checkbox" />{{ importing.targetMode === 'create' ? '采用' : '并入' }}创建者建议的可见范围（{{ importing.preview.suggestedAllowlist.length }} 个工号）</label>
        <label class="check-label"><input v-model="importing.publish" type="checkbox" :disabled="Boolean(importing.preview.errors.length)" />同时发布（可见范围内的同事会收到新版本）</label>
      </div>
      <p v-if="error" role="alert" class="admin-error">{{ error }}</p>
    </WebsiteDialog>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept" />
  </section>
</template>

<style scoped>
.expert-section-title{font-size:15px;margin:32px 0 14px;padding-top:20px;border-top:1px solid var(--border-subtle)}
.expert-distribution{border:1px solid var(--border-default);border-radius:10px;padding:18px 20px;margin:0 0 8px;background:#fafbfe}
.expert-distribution legend h4{font-size:15px;margin:0 0 12px}
.expert-choice-row,.expert-choices{display:flex;flex-wrap:wrap;gap:12px 22px;margin:14px 0}
.expert-choices legend{font-size:12px;margin-bottom:10px;width:100%}
.expert-choices small{color:var(--text-tertiary);font-size:10px;margin-left:4px}
.expert-rows{flex-direction:column;gap:10px}
.expert-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle)}
.expert-onebox{border:1px solid var(--border-subtle);border-radius:8px;padding:14px;display:grid;gap:12px}
.expert-warning{color:#9a5b00!important}
.expert-responsibility{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px!important;min-height:260px!important}
.expert-distribution-actions,.expert-save-row{margin-top:14px}
.expert-issues{margin:8px 0 0;padding-left:20px;font-size:12px}
.expert-warnings{margin:10px 0;padding:12px 12px 12px 30px;border-radius:8px;background:#fff8e8;color:#7a4a00;font-size:12px;line-height:1.8}
.expert-preview{display:grid;gap:12px;font-size:13px}
.expert-preview-title small{color:var(--text-tertiary);font-size:11px}
.expert-inline-field{display:flex;flex-direction:column;gap:6px;font-size:12px;width:100%}
.expert-changes{font-size:12px;background:#f6f7fb;border-radius:8px;padding:12px 14px}
.expert-changes ul{margin:8px 0 0;padding-left:20px;line-height:1.8}
.expert-preview-list{display:grid;grid-template-columns:max-content 1fr;gap:8px 14px;font-size:12px;margin:0}
.expert-preview-list dt{color:var(--text-secondary)}
.expert-preview-list dd{margin:0;overflow-wrap:anywhere}
.expert-knowledge-chip{display:inline-block;margin:0 8px 6px 0;padding:2px 8px;border-radius:999px;background:#eef6f1;color:#2f6a4f}
.expert-tabs{display:flex;gap:4px;margin:0 0 18px;border-bottom:1px solid var(--border-subtle)}
.expert-tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 14px;font:inherit;font-size:13px;color:var(--text-secondary);cursor:pointer;margin-bottom:-1px}
.expert-tabs button[aria-selected="true"]{color:var(--text-primary);border-bottom-color:var(--accent-primary);font-weight:600}
.expert-tabs button:focus-visible{outline:2px solid var(--accent-primary);outline-offset:2px}
.expert-import-tool{display:grid;gap:4px;padding:8px 0;border-bottom:1px solid var(--border-subtle)}
.expert-import-tool small{color:var(--text-tertiary);font-size:11px;overflow-wrap:anywhere}
.expert-knowledge-chip.is-unsynced,.expert-knowledge-chip.is-disabled{background:#fff4df;color:#8a5300}
.expert-knowledge-chip.is-missing{background:#fdecec;color:#973d3d}
@media(max-width:760px){.expert-preview-list{grid-template-columns:1fr}.expert-row{flex-direction:column}}
@media(prefers-reduced-motion:reduce){.expert-manager *{transition:none!important}}
</style>
