<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ExpertScenario } from '@dsh-ops/expert-distribution-contract/scenarios'
import { ApiError, guideApi, requestMessage } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'
import ScenarioListEditor from './ScenarioListEditor.vue'

/**
 * 内置专家场景: the 常用场景 of the experts the product ships. A published list replaces the shipped one for
 * everyone at the next sync; withdrawing goes back to what the product shipped.
 */
type Builtin = {
  id: string; name: string; draft: ExpertScenario[]; draftChanged: boolean; updatedAt?: string
  published?: { version: number; publishedAt: string; scenarios: ExpertScenario[] }
}

/**
 * Appearance icons of the shipped experts (their preset.yml), only so the editor previews the glyph a scenario without
 * its own icon or mode borrows in the product. A drift changes that preview, never what is published.
 */
const BUILTIN_EXPERT_ICONS: Readonly<Record<string, string>> = {
  'product-default': 'sparkles', 'data-analyst': 'analytics', 'push-expert': 'megaphone',
  'marketing-compliance': 'briefcase', 'browser-content-compliance': 'shield',
}

const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; dirty: [v: boolean]; busy: [v: boolean] }>()
const experts = ref<Builtin[]>([]), revision = ref(''), selected = ref<string>(), form = ref<ExpertScenario[]>(), baseline = ref('null')
const busy = ref(false), loading = ref(true), notice = ref(''), error = ref(''), issues = ref<string[]>([]), editing = ref(false)
const errorElement = ref<HTMLElement>()
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const lifetime = new AbortController()

const current = computed(() => experts.value.find(expert => expert.id === selected.value))
const changed = computed(() => JSON.stringify(form.value ?? null) !== baseline.value)
const dirty = computed(() => changed.value || editing.value)
/** An override is published or a draft is saved: there is something to take back to the shipped list. */
const overridden = computed(() => Boolean(current.value?.published || current.value?.draftChanged))
/**
 * A publish would change what colleagues see: the list on screen (saved first) differs from the published one, or,
 * never overridden, a saved draft (even an empty one hides the shipped list) or a list on screen. An open scenario row
 * counts, so the click can ask for it to be saved first.
 */
const publishable = computed(() => {
  const expert = current.value
  if (!expert || !form.value) return false
  if (editing.value) return true
  if (expert.published) return JSON.stringify(form.value) !== JSON.stringify(expert.published.scenarios)
  return expert.draftChanged || form.value.length > 0
})
watch(dirty, v => emit('dirty', v)); watch(busy, v => emit('busy', v))
const call = <T,>(url: string, init: { method?: string; data?: unknown } = {}) => guideApi<T>(url, { ...init, csrf: props.csrf, signal: lifetime.signal })
const route = (id: string) => `/api/admin/expert-builtin-scenarios/${encodeURIComponent(id)}`
const date = (value: string) => new Date(value).toLocaleString('zh-CN')

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
  const result = await call<{ revision: string; experts: Builtin[] }>('/api/admin/expert-builtin-scenarios')
  experts.value = result.experts; revision.value = result.revision; loading.value = false
}
function adopt(expert?: Builtin) {
  selected.value = expert?.id
  form.value = expert ? expert.draft.map(scenario => ({ ...scenario })) : undefined
  baseline.value = JSON.stringify(form.value ?? null)
}
/** Take a write's answer: the new revision and the expert as stored. */
function accept(result: { revision: string; expert: Builtin }) {
  revision.value = result.revision
  experts.value = experts.value.map(expert => expert.id === result.expert.id ? result.expert : expert)
  adopt(result.expert)
}
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '已保存的草稿和已发布的场景都会保留。', label: '放弃修改', action }
  else action()
}
function select(id: string) { guard(() => adopt(experts.value.find(expert => expert.id === id))) }
function reload() { guard(() => void run(async () => { const id = selected.value; await list(); adopt(experts.value.find(expert => expert.id === id)) })) }
function statusText(expert: Builtin) {
  if (!expert.published) return expert.draftChanged ? '随产品发布 · 有未发布修改' : '随产品发布'
  return `已覆盖 · 发布于 ${date(expert.published.publishedAt)}${expert.draftChanged ? ' · 有未发布修改' : ''}`
}
async function saveDraft(): Promise<boolean> {
  const expert = current.value
  if (!expert || !form.value) return false
  if (editing.value) { error.value = '请先保存或取消正在编辑的场景。'; await nextTick(); errorElement.value?.focus(); return false }
  let saved = false
  await run(async () => {
    accept(await call(route(expert.id), { method: 'PUT', data: { scenarios: form.value, revision: revision.value } }))
    notice.value = '草稿已保存。发布后所有同事才会收到。'
    saved = true
  })
  return saved
}
async function publish() {
  const expert = current.value
  if (!expert) return
  if (dirty.value && !await saveDraft()) return
  const count = current.value?.draft.length ?? 0
  confirmation.value = {
    title: `发布「${expert.name}」的常用场景？`,
    message: `发布后，所有同事下次同步时生效。${count ? `这 ${count} 个场景会整体替换随产品发布的场景。` : '列表为空：这位专家将不显示随产品发布的场景。'}`,
    label: '发布',
    action: () => void run(async () => {
      const result = await call<{ revision: string; expert: Builtin }>(`${route(expert.id)}/publish`, { method: 'POST', data: { revision: revision.value } })
      accept(result); notice.value = `已发布第 ${result.expert.published?.version} 版，所有同事下次同步时生效。`
    }),
  }
}
function withdraw() {
  const expert = current.value
  if (!expert) return
  confirmation.value = {
    title: `「${expert.name}」恢复为随产品发布？`,
    message: '撤下已发布的场景并丢弃未发布的草稿，所有同事下次同步时恢复为随产品发布的场景。撤下前的内容保留在回收记录中。',
    label: '恢复为随产品发布',
    action: () => void (async () => {
      let done = false
      await run(async () => {
        accept(await call(route(expert.id), { method: 'DELETE', data: { revision: revision.value } }))
        notice.value = '已恢复为随产品发布。'
        done = true
      })
      // The button leaves with the override: keep the keyboard on this expert.
      if (done) { await nextTick(); (document.querySelector('.expert-builtin-scenarios nav [aria-current="page"]') as HTMLElement | null)?.focus() }
    })(),
  }
}
function confirm() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
onMounted(() => run(async () => { await list(); adopt(experts.value[0]) }))
onBeforeUnmount(() => { lifetime.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section class="expert-builtin-scenarios" :aria-busy="busy">
    <div class="editor-heading">
      <div><p>随工作助手安装包发布的专家。在这里发布的常用场景会整体替换这位专家随产品发布的场景，对所有同事生效（包括未登录 WeLink 的使用者）；专家的其他内容不受影响。</p></div>
      <div class="admin-actions builtin-heading-actions"><button class="button secondary" :disabled="busy" @click="reload">刷新列表</button></div>
    </div>
    <div v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}<ul v-if="issues.length" class="builtin-issues"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul></div>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div class="admin-layout">
      <aside class="admin-sidebar release-sidebar">
        <h3>内置专家</h3>
        <p v-if="loading" class="editor-help">正在加载…</p>
        <nav aria-label="内置专家列表"><button v-for="expert in experts" :key="expert.id" :disabled="busy" :aria-current="selected === expert.id ? 'page' : undefined" @click="select(expert.id)"><span>{{ expert.name }}</span><small>{{ expert.id }}<br />{{ statusText(expert) }}</small></button></nav>
      </aside>
      <section v-if="current && form" class="admin-workspace release-workspace">
        <div class="editor-heading">
          <div><h3>{{ current.name }}</h3><p>{{ dirty ? '有未保存的修改' : statusText(current) }}</p></div>
          <div class="admin-actions">
            <button class="button secondary" :disabled="busy || !changed" @click="saveDraft">保存草稿</button>
            <button class="button primary" :disabled="busy || !publishable" @click="publish">发布</button>
          </div>
        </div>
        <div class="release-identity">
          <span><small>专家 ID</small><strong>{{ current.id }}</strong></span>
          <span><small>使用者看到的场景</small><strong>{{ current.published ? `官网发布的 ${current.published.scenarios.length} 个（v${current.published.version}）` : '随产品发布' }}</strong></span>
          <span v-if="current.published"><small>最近发布</small><strong>{{ date(current.published.publishedAt) }}</strong></span>
        </div>
        <div class="builtin-body">
          <p class="editor-help builtin-help">使用者在新对话首页或专家卡片上点一下场景，就会把提问模板填进输入框，改完【】里的内容再发送。最多 8 个。</p>
          <ScenarioListEditor v-model="form" :disabled="busy" :expert-icon="BUILTIN_EXPERT_ICONS[current.id]" @editing="editing = $event" />
        </div>
        <div v-if="overridden" class="editor-bottom"><button :disabled="busy" @click="withdraw">恢复为随产品发布</button></div>
      </section>
      <div v-else class="admin-empty">从左侧选择一位内置专家。</div>
    </div>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="confirm" />
  </section>
</template>

<style scoped>
.builtin-heading-actions{flex-shrink:0}
.builtin-heading-actions .button{white-space:nowrap}
.builtin-body{padding-bottom:20px}
.builtin-help{margin:0 0 14px!important}
.builtin-issues{margin:6px 0 0;padding-left:20px;font-size:12px;line-height:1.8}
</style>
