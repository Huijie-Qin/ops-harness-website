<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { MetricKnowledgeCatalog, MetricKnowledgeEntry } from '../shared/knowledge'
import { maxSkillFileBytes, maxTypicalIndicators, metricKnowledgeIdPattern } from '../shared/knowledge'
import { ApiError, guideApi, requestMessage, uploadFile } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'

type Form = {
  id: string; tenant_name: string; tenant_id: string
  get_card_index: string; get_card_meta: string; quer_card_data: string
  card_index_knowledge_base: string; card_meta_knowledge_base: string
  knowledge_description: string; indicators_cover: string; reports_cover: string; update_frequency: string
  typical_indicators: string; enabled: boolean
}
const empty = (): Form => ({
  id: '', tenant_name: '', tenant_id: '', get_card_index: '', get_card_meta: '', quer_card_data: '',
  card_index_knowledge_base: '', card_meta_knowledge_base: '', knowledge_description: '',
  indicators_cover: '', reports_cover: '', update_frequency: '', typical_indicators: '', enabled: true,
})
const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; dirty: [v: boolean]; busy: [v: boolean] }>()
const items = ref<MetricKnowledgeEntry[]>([]), revision = ref(''), current = ref<MetricKnowledgeEntry>(), creating = ref(false)
const form = ref<Form>(empty()), baseline = ref('')
const busy = ref(false), loading = ref(true), notice = ref(''), error = ref(''), progress = ref(0), uploadName = ref('')
const errorElement = ref<HTMLElement>(), fileInput = ref<HTMLInputElement>(), tenantInput = ref<HTMLInputElement>()
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const lifetime = new AbortController()
let upload: AbortController | undefined
const active = computed(() => Boolean(current.value || creating.value))
const dirty = computed(() => active.value && JSON.stringify(form.value) !== baseline.value)
const skill = computed(() => current.value?.skill)
watch(dirty, v => emit('dirty', v)); watch(busy, v => emit('busy', v))
const call = <T,>(url: string, options: { method?: string; data?: unknown } = {}) =>
  guideApi<T>(url, { ...options, csrf: props.csrf, signal: lifetime.signal })
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; notice.value = ''; error.value = ''
  try { await fn() } catch (e) {
    error.value = requestMessage(e)
    if (e instanceof ApiError && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(e.code)) emit('error', e)
    await nextTick(); errorElement.value?.focus()
  } finally { busy.value = false }
}
async function list() {
  const catalog = await call<MetricKnowledgeCatalog>('/api/admin/knowledge')
  items.value = catalog.items; revision.value = catalog.revision
  loading.value = false
}
function adopt(entry: MetricKnowledgeEntry) {
  creating.value = false; current.value = entry
  const meta = entry.knowledge_base_meta
  form.value = {
    id: entry.id, tenant_name: entry.tenant_name, tenant_id: entry.tenant_id,
    get_card_index: entry.knowledge_retrieve_workflow_id.get_card_index,
    get_card_meta: entry.knowledge_retrieve_workflow_id.get_card_meta,
    quer_card_data: entry.knowledge_retrieve_workflow_id.quer_card_data,
    card_index_knowledge_base: entry.knowledge_id.card_index_knowledge_base,
    card_meta_knowledge_base: entry.knowledge_id.card_meta_knowledge_base,
    knowledge_description: meta.knowledge_description, indicators_cover: meta.indicators_cover ?? '',
    reports_cover: meta.reports_cover ?? '', update_frequency: meta.update_frequency ?? '',
    typical_indicators: (meta.typical_indicators ?? []).join('\n'), enabled: entry.enabled,
  }
  baseline.value = JSON.stringify(form.value)
}
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '已保存的知识库条目和技能文件会保留。', label: '放弃修改', action }
  else action()
}
function select(entry: MetricKnowledgeEntry) { guard(() => { adopt(entry); error.value = ''; notice.value = '' }) }
function create() {
  guard(() => {
    creating.value = true; current.value = undefined
    form.value = empty(); baseline.value = JSON.stringify(form.value); notice.value = ''; error.value = ''
    void nextTick(() => tenantInput.value?.focus())
  })
}
function indicators() { return form.value.typical_indicators.split(/\r?\n/).map(v => v.trim()).filter(Boolean) }
function payload() {
  const value = form.value
  const meta: Record<string, unknown> = { knowledge_description: value.knowledge_description.trim() }
  if (value.indicators_cover.trim()) meta.indicators_cover = value.indicators_cover.trim()
  if (value.reports_cover.trim()) meta.reports_cover = value.reports_cover.trim()
  if (value.update_frequency.trim()) meta.update_frequency = value.update_frequency.trim()
  if (indicators().length) meta.typical_indicators = indicators()
  return {
    ...(creating.value && value.id.trim() ? { id: value.id.trim() } : {}),
    tenant_name: value.tenant_name.trim(), tenant_id: value.tenant_id.trim(),
    knowledge_retrieve_workflow_id: { get_card_index: value.get_card_index.trim(), get_card_meta: value.get_card_meta.trim(), quer_card_data: value.quer_card_data.trim() },
    knowledge_id: { card_index_knowledge_base: value.card_index_knowledge_base.trim(), card_meta_knowledge_base: value.card_meta_knowledge_base.trim() },
    knowledge_base_meta: meta, enabled: value.enabled,
  }
}
async function save() {
  if (creating.value && form.value.id.trim() && !metricKnowledgeIdPattern.test(form.value.id.trim())) { error.value = '知识库标识需以 metrics- 开头，只使用小写字母、数字和连字符；留空由服务端生成。'; return }
  if (indicators().length > maxTypicalIndicators) { error.value = `典型指标最多 ${maxTypicalIndicators} 行。`; return }
  await run(async () => {
    const id = current.value?.id
    const result = await call<{ revision: string; entry: MetricKnowledgeEntry }>(id ? `/api/admin/knowledge/${encodeURIComponent(id)}` : '/api/admin/knowledge',
      { method: id ? 'PUT' : 'POST', data: { entry: payload(), revision: revision.value } })
    adopt(result.entry); await list()
    notice.value = id ? '已保存，公开目录立即生效。' : '知识库已创建，可以上传配套技能文件。'
  })
}
function saveClick() {
  if (current.value?.enabled && !form.value.enabled) confirmation.value = { title: '下架这个知识库？', message: '公开目录将不再返回该条目，端侧已绑定的副本不受影响。', label: '保存并下架', action: () => void save() }
  else void save()
}
function remove() {
  const entry = current.value
  if (!entry) return
  confirmation.value = { title: '删除这个知识库条目？', message: `${entry.tenant_name} · ${entry.id}。公开目录立即不再返回该条目；已上传的技能文件按内容哈希保留。`, label: '删除条目', action: () => void run(async () => {
    await call(`/api/admin/knowledge/${encodeURIComponent(entry.id)}`, { method: 'DELETE', data: { revision: revision.value } })
    current.value = undefined; creating.value = false; form.value = empty(); baseline.value = JSON.stringify(form.value)
    await list(); notice.value = '条目已删除。'
  }) }
}
async function send(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  const entry = current.value
  if (!file || !entry) return
  await run(async () => {
    upload = new AbortController()
    try {
      if (file.size > maxSkillFileBytes) throw new ApiError('UPLOAD_TOO_LARGE')
      if (!/\.(zip|md)$/i.test(file.name)) throw new ApiError('INVALID_SKILL_FILE')
      uploadName.value = file.name; progress.value = 0
      const result = await uploadFile<{ revision: string; entry: MetricKnowledgeEntry }>(
        `/api/admin/knowledge/${encodeURIComponent(entry.id)}/skill?name=${encodeURIComponent(file.name)}`, file,
        { csrf: props.csrf, revision: revision.value, signal: upload.signal, progress: v => progress.value = v })
      adopt(result.entry); await list(); notice.value = '技能文件已校验并保存。'
    } catch (e) {
      if (upload.signal.aborted) notice.value = '上传已取消，原有技能文件仍保留。'
      else throw e
    } finally { uploadName.value = ''; input.value = '' }
  })
}
function detach() {
  const entry = current.value
  if (!entry?.skill) return
  confirmation.value = { title: '移除这个技能文件？', message: `${entry.skill.file_name}。条目将不再提供技能下载，已上传的文件按内容哈希保留。`, label: '移除技能文件', action: () => void run(async () => {
    const result = await call<{ revision: string; entry: MetricKnowledgeEntry }>(`/api/admin/knowledge/${encodeURIComponent(entry.id)}/skill`, { method: 'DELETE', data: { revision: revision.value } })
    adopt(result.entry); await list(); notice.value = '技能文件引用已移除。'
  }) }
}
function reload() {
  guard(() => void run(async () => {
    const id = current.value?.id
    await list()
    const entry = items.value.find(item => item.id === id)
    if (entry) adopt(entry)
    else { current.value = undefined; creating.value = false; form.value = empty(); baseline.value = JSON.stringify(form.value) }
  }))
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB` }
onMounted(() => run(list))
onBeforeUnmount(() => { lifetime.abort(); upload?.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section :aria-busy="busy">
    <div class="editor-heading">
      <div><h2>知识库元数据</h2><p>维护指标知识库的租户、检索工作流与配套技能，办公助手刷新知识中心即可看到。</p></div>
      <div class="admin-actions"><button class="button secondary" :disabled="busy" @click="reload">刷新列表</button><button class="button primary" :disabled="busy" @click="create">新建知识库</button></div>
    </div>
    <p v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div class="admin-layout">
      <aside class="admin-sidebar release-sidebar">
        <h3>知识库条目</h3>
        <p v-if="loading" class="editor-help">正在加载…</p>
        <p v-else-if="!items.length" class="editor-help">尚无条目</p>
        <nav aria-label="知识库条目"><button v-for="item in items" :key="item.id" :disabled="busy" :aria-current="current?.id === item.id ? 'page' : undefined" @click="select(item)"><span>{{ item.tenant_name }}</span><small>{{ item.id }}<br />{{ item.enabled ? '已上架' : '已下架' }} · {{ item.skill ? '技能已配置' : '未配技能' }}</small></button></nav>
      </aside>
      <section v-if="active" class="admin-workspace release-workspace">
        <div class="editor-heading"><h3>{{ creating ? '创建知识库条目' : '维护知识库条目' }}</h3><span class="editor-help">{{ dirty ? '有未保存的修改' : creating ? '尚未创建' : '已保存' }}</span></div>
        <div v-if="current" class="release-identity">
          <span><small>知识库标识</small><strong>{{ current.id }}</strong></span>
          <span><small>创建时间</small><strong>{{ new Date(current.created_at).toLocaleString('zh-CN') }}</strong></span>
          <span><small>最近更新</small><strong>{{ new Date(current.updated_at).toLocaleString('zh-CN') }}</strong></span>
        </div>
        <form @submit.prevent="saveClick">
          <fieldset :disabled="busy">
            <div class="chapter-fields">
              <label v-if="creating">知识库标识<input v-model="form.id" maxlength="64" placeholder="留空自动生成，例如 metrics-retail" /><small>以 metrics- 开头，只用小写字母、数字和连字符；创建后不可修改。</small></label>
              <label>租户名称<input ref="tenantInput" v-model="form.tenant_name" required maxlength="80" placeholder="例如：示例零售" /></label>
              <label>租户 ID<input v-model="form.tenant_id" required maxlength="128" placeholder="DataAgent 中的租户标识" /><small>同一目录内唯一。</small></label>
              <label>检索工作流 get_card_index<input v-model="form.get_card_index" required maxlength="256" /></label>
              <label>检索工作流 get_card_meta<input v-model="form.get_card_meta" required maxlength="256" /></label>
              <label>检索工作流 quer_card_data<input v-model="form.quer_card_data" required maxlength="256" /></label>
              <label>知识库 card_index_knowledge_base<input v-model="form.card_index_knowledge_base" required maxlength="256" /></label>
              <label>知识库 card_meta_knowledge_base<input v-model="form.card_meta_knowledge_base" required maxlength="256" /></label>
              <label>指标覆盖<input v-model="form.indicators_cover" maxlength="80" placeholder="例如：1,200 项，可留空" /></label>
              <label>报表覆盖<input v-model="form.reports_cover" maxlength="80" placeholder="例如：32 张，可留空" /></label>
              <label>更新频率<input v-model="form.update_frequency" maxlength="80" placeholder="例如：每日 07:00，可留空" /></label>
            </div>
            <label class="release-notes">知识库描述<textarea v-model="form.knowledge_description" required rows="4" maxlength="2000" placeholder="说明该知识库覆盖的业务范围与口径来源。"></textarea><small>展示在知识中心卡片上，最多 2000 字。</small></label>
            <label class="release-notes">典型指标<textarea v-model="form.typical_indicators" rows="4" :maxlength="maxTypicalIndicators * 81" placeholder="每行一个，例如：&#10;GMV&#10;动销率"></textarea><small>每行一个，最多 {{ maxTypicalIndicators }} 个，每个 80 字以内；留空则卡片不显示标签。</small></label>
            <label class="check-label"><input v-model="form.enabled" type="checkbox" />上架：在公开目录中提供此知识库</label>
            <button class="button primary" :disabled="busy || !dirty">{{ busy ? '处理中…' : creating ? '创建条目' : '保存条目' }}</button>
          </fieldset>
        </form>
        <section v-if="current" class="package-upload" aria-labelledby="knowledge-skill-heading">
          <div class="editor-heading">
            <div><h3 id="knowledge-skill-heading">配套技能文件</h3><p>一个 .zip 或 .md，最多 5 MiB。ZIP 中须恰好有一个 SKILL.md，位于根目录或唯一的一级目录内。</p></div>
            <div class="admin-actions">
              <input ref="fileInput" class="file-input" type="file" accept=".zip,.md" tabindex="-1" aria-label="选择技能文件" :disabled="busy || dirty" @change="send" />
              <button class="button secondary" :disabled="busy || dirty" @click="fileInput?.click()">选择技能文件</button>
              <button v-if="uploadName" class="button secondary" @click="upload?.abort()">取消上传</button>
            </div>
          </div>
          <p v-if="dirty" class="editor-help">请先保存表单修改，再上传技能文件。</p>
          <div v-if="uploadName" class="upload-progress" role="status"><span>{{ uploadName }}</span><progress :value="progress" max="100"></progress>{{ progress }}% · {{ progress === 100 ? '正在校验保存…' : '上传中' }}</div>
          <article v-if="skill" class="package-file">
            <div><strong>{{ skill.file_name }}</strong><small>技能名 {{ skill.name }} · {{ skill.kind === 'zip' ? '压缩包' : 'Markdown' }} · {{ size(skill.size) }} · {{ new Date(skill.uploaded_at).toLocaleString('zh-CN') }}</small><details><summary>内容哈希 SHA-256</summary><code>{{ skill.sha256 }}</code></details></div>
            <button :disabled="busy || dirty" @click="detach">移除技能文件</button>
          </article>
          <p v-else class="editor-help">尚未配置技能文件。绑定该知识库的数据分析专家不会收到附带技能。</p>
          <p v-if="skill && current.enabled" class="editor-help"><a :href="`/api/knowledge/metrics/${encodeURIComponent(current.id)}/skill`" download>下载当前技能文件</a>，可核对内容后再上架。</p>
        </section>
        <div v-if="current" class="editor-bottom"><button :disabled="busy" @click="remove">删除条目</button></div>
      </section>
      <div v-else class="admin-empty">新建知识库条目，或选择左侧已有条目进行维护。</div>
    </div>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept" />
  </section>
</template>
