<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EXPERT_LIMITS } from '@dsh-ops/expert-distribution-contract'
import { ApiError, guideApi, requestMessage } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'

type Slot = { key: string; label: string; hint?: string; location: { kind: 'header' | 'env'; name: string } }
type Usage = { id: string; name: string; draft: boolean; published: boolean }
type Tool = {
  key: string; name: string; description?: string; transport: 'stdio' | 'streamable-http'; serverName: string
  url?: string; command?: string; args: string[]; headers: Record<string, string>; timeoutMs: number; credentials: Slot[]
  revision: string; updatedAt: string; importedFrom?: { employeeId?: string; importedAt: string }; usage: Usage[]
}
type Form = { name: string; description: string; url: string; command: string; args: string; timeoutSeconds: number; credentials: Array<{ key: string; label: string; hint: string }> }

const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; dirty: [v: boolean]; busy: [v: boolean] }>()
const tools = ref<Tool[]>([]), revision = ref(''), selected = ref<string>(), form = ref<Form>(), baseline = ref('null')
const busy = ref(false), loading = ref(true), notice = ref(''), error = ref(''), issues = ref<string[]>([])
const errorElement = ref<HTMLElement>()
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const lifetime = new AbortController()

const current = computed(() => tools.value.find(tool => tool.key === selected.value))
const dirty = computed(() => JSON.stringify(form.value ?? null) !== baseline.value)
const publishedUsers = computed(() => current.value?.usage.filter(user => user.published) ?? [])
watch(dirty, v => emit('dirty', v)); watch(busy, v => emit('busy', v))
const call = <T,>(url: string, init: { method?: string; data?: unknown } = {}) => guideApi<T>(url, { ...init, csrf: props.csrf, signal: lifetime.signal })

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
  const result = await call<{ revision: string; tools: Tool[] }>('/api/admin/expert-tools')
  tools.value = result.tools; revision.value = result.revision; loading.value = false
}
function formOf(tool: Tool): Form {
  return {
    name: tool.name, description: tool.description ?? '', url: tool.url ?? '', command: tool.command ?? '', args: tool.args.join('\n'),
    timeoutSeconds: Math.round(tool.timeoutMs / 1000), credentials: tool.credentials.map(slot => ({ key: slot.key, label: slot.label, hint: slot.hint ?? '' })),
  }
}
function adopt(tool?: Tool) {
  selected.value = tool?.key
  form.value = tool ? formOf(tool) : undefined
  baseline.value = JSON.stringify(form.value ?? null)
}
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '工具库中已保存的配置不受影响。', label: '放弃修改', action }
  else action()
}
function select(key: string) { guard(() => adopt(tools.value.find(tool => tool.key === key))) }
function reload() { guard(() => void run(async () => { const key = selected.value; await list(); adopt(tools.value.find(tool => tool.key === key)) })) }
function location(slot: Slot) { return slot.location.kind === 'header' ? `请求头 ${slot.location.name}` : `环境变量 ${slot.location.name}` }
/** A header as the admin reads it: credential placeholders shown by the slot's name. */
function headerText(value: string, slots: Slot[]) {
  return value.replace(/\{\{credential:([a-z0-9-]+)\}\}/g, (_match, key: string) => `‹凭据：${slots.find(slot => slot.key === key)?.label ?? key}›`)
}
function usageText(tool: Tool) {
  const published = tool.usage.filter(user => user.published).length
  return tool.usage.length ? `${tool.usage.length} 位专家引用${published ? `，${published} 位已发布` : ''}` : '未被引用'
}
function localIssues(value: Form, tool: Tool): string[] {
  const found: string[] = []
  if (!value.name.trim()) found.push('请填写名称')
  if (tool.transport === 'streamable-http' && !/^https?:\/\//i.test(value.url.trim())) found.push('请填写 http(s) 服务地址')
  if (tool.transport === 'stdio' && !value.command.trim()) found.push('请填写启动命令')
  if (!Number.isInteger(Number(value.timeoutSeconds)) || Number(value.timeoutSeconds) < 1 || Number(value.timeoutSeconds) > 600) found.push('调用超时请填写 1–600 秒')
  for (const slot of value.credentials) if (!slot.label.trim()) found.push(`凭据项 ${slot.key} 需要名称`)
  return found
}
async function save() {
  const tool = current.value, value = form.value
  if (!tool || !value) return
  const found = localIssues(value, tool)
  if (found.length) { error.value = '请先修正以下问题：'; issues.value = found; await nextTick(); errorElement.value?.focus(); return }
  const write = () => void run(async () => {
    const result = await call<{ revision: string; tool: Tool }>(`/api/admin/expert-tools/${encodeURIComponent(tool.key)}`, {
      method: 'PUT',
      data: {
        revision: revision.value,
        tool: {
          name: value.name.trim(), ...(value.description.trim() ? { description: value.description.trim() } : {}),
          ...(tool.transport === 'streamable-http' ? { url: value.url.trim() } : { command: value.command.trim(), args: value.args.split(/\r?\n/).map(arg => arg.trim()).filter(Boolean) }),
          timeoutMs: Math.round(Number(value.timeoutSeconds) * 1000),
          credentials: value.credentials.map(slot => ({ key: slot.key, label: slot.label.trim(), ...(slot.hint.trim() ? { hint: slot.hint.trim() } : {}) })),
        },
      },
    })
    const affected = publishedUsers.value.length
    await list(); adopt(tools.value.find(item => item.key === result.tool.key))
    notice.value = affected ? `已保存：${affected} 位已发布专家的使用者会在下次同步时更新这个工具。` : '已保存。'
  })
  if (!publishedUsers.value.length) { write(); return }
  confirmation.value = {
    title: '保存工具配置？',
    message: `将影响 ${publishedUsers.value.length} 位已发布专家：${publishedUsers.value.map(user => `「${user.name}」`).join('、')}。使用者下次同步时更新本机工具；已添加的会重新校验连接，命令变化时需要使用者重新确认。`,
    label: '保存', action: write,
  }
}
function remove() {
  const tool = current.value
  if (!tool || tool.usage.length) return
  confirmation.value = {
    title: `删除工具「${tool.name}」？`,
    message: '只从官网工具库删除这一项；删除前的工具库保留在回收记录中。',
    label: '删除工具',
    action: () => void run(async () => {
      await call(`/api/admin/expert-tools/${encodeURIComponent(tool.key)}`, { method: 'DELETE', data: { revision: revision.value } })
      await list(); adopt(undefined); notice.value = '工具已删除。'
    }),
  }
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
onMounted(() => run(list))
onBeforeUnmount(() => { lifetime.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section class="expert-tool-library" :aria-busy="busy">
    <div class="editor-heading">
      <div><p>专家引用的自定义 MCP 工具。连接配置随专家下发，令牌与密钥由每位使用者首次使用时自己填写；保存即对所有引用它的专家生效。</p></div>
      <div class="admin-actions"><button class="button secondary" :disabled="busy" @click="reload">刷新列表</button></div>
    </div>
    <div v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}<ul v-if="issues.length" class="tool-issues"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul></div>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div class="admin-layout">
      <aside class="admin-sidebar release-sidebar">
        <h3>工具库（{{ tools.length }} / {{ EXPERT_LIMITS.toolLibrary }}）</h3>
        <p v-if="loading" class="editor-help">正在加载…</p>
        <p v-else-if="!tools.length" class="editor-help">还没有自定义工具。导入带自定义工具的专家包时会自动加入。</p>
        <nav aria-label="自定义工具列表"><button v-for="tool in tools" :key="tool.key" :disabled="busy" :aria-current="selected === tool.key ? 'page' : undefined" @click="select(tool.key)"><span>{{ tool.name }}</span><small>{{ tool.serverName }} · {{ tool.transport === 'stdio' ? '命令行' : 'HTTP' }}<br />{{ usageText(tool) }}</small></button></nav>
      </aside>
      <section v-if="current && form" class="admin-workspace release-workspace">
        <div class="editor-heading">
          <div><h3>{{ current.name }}</h3><p>{{ dirty ? '有未保存的修改' : `更新于 ${new Date(current.updatedAt).toLocaleString('zh-CN')}` }}</p></div>
          <div class="admin-actions"><button class="button primary" :disabled="busy || !dirty" @click="save">保存</button></div>
        </div>
        <div class="release-identity">
          <span><small>工具键</small><strong>{{ current.key }}</strong></span>
          <span><small>服务名（模型看到的工具前缀）</small><strong>mcp__{{ current.serverName }}__…</strong></span>
          <span><small>传输方式</small><strong>{{ current.transport === 'stdio' ? '命令行（stdio）' : 'Streamable HTTP' }}</strong></span>
          <span v-if="current.importedFrom"><small>导入来源</small><strong>{{ current.importedFrom.employeeId ?? '未知工号' }} · {{ new Date(current.importedFrom.importedAt).toLocaleString('zh-CN') }}</strong></span>
        </div>
        <p v-if="current.transport === 'stdio'" class="tool-command" role="note"><strong>使用者电脑上将运行：</strong><code>{{ [current.command, ...current.args].join(' ') }}</code><small>首次使用和命令变化时，都需要使用者本人确认。</small></p>

        <form @submit.prevent="save">
          <fieldset :disabled="busy">
            <div class="chapter-fields">
              <label>名称<input v-model="form.name" maxlength="40" required /></label>
              <label>调用超时（秒）<input v-model.number="form.timeoutSeconds" type="number" min="1" max="600" /></label>
              <label class="chapter-summary-field">说明（可选）<input v-model="form.description" maxlength="300" /></label>
              <label v-if="current.transport === 'streamable-http'" class="chapter-summary-field">服务地址<input v-model="form.url" maxlength="2048" spellcheck="false" /><small>不能包含用户名、密码或 token 等密钥参数。</small></label>
              <template v-else>
                <label>启动命令<input v-model="form.command" maxlength="64" spellcheck="false" /><small>只能是程序名（如 npx、uvx），不能是本机路径。</small></label>
                <label>参数<textarea v-model="form.args" rows="3" spellcheck="false" placeholder="每行一个参数"></textarea></label>
              </template>
            </div>

            <h4 class="tool-section-title">请求头</h4>
            <p v-if="!Object.keys(current.headers).length" class="editor-help">无。</p>
            <dl v-else class="tool-headers"><template v-for="(value, name) in current.headers" :key="name"><dt>{{ name }}</dt><dd>{{ headerText(value, current.credentials) }}</dd></template></dl>

            <h4 class="tool-section-title">凭据项（值不在官网保存，使用者首次使用时自己填写）</h4>
            <p v-if="!form.credentials.length" class="editor-help">这个工具不需要凭据。</p>
            <div v-for="(slot, index) in form.credentials" :key="slot.key" class="tool-slot">
              <p class="editor-help">{{ slot.key }} · {{ location(current.credentials[index]!) }}</p>
              <div class="chapter-fields">
                <label>名称<input v-model="slot.label" maxlength="40" /></label>
                <label>获取说明<input v-model="slot.hint" maxlength="200" placeholder="例如：在 CRM 个人设置里生成 API 令牌" /></label>
              </div>
            </div>

            <h4 class="tool-section-title">引用这个工具的专家</h4>
            <p v-if="!current.usage.length" class="editor-help">暂无。</p>
            <ul v-else class="tool-usage"><li v-for="user in current.usage" :key="user.id">「{{ user.name }}」（{{ user.id }}）{{ user.published ? ' · 已发布' : ' · 仅草稿' }}</li></ul>
          </fieldset>
        </form>
        <div class="editor-bottom"><button :disabled="busy || current.usage.length > 0" :title="current.usage.length ? '仍有专家在使用，先在这些专家中移除' : undefined" @click="remove">删除工具</button></div>
      </section>
      <div v-else class="admin-empty">从左侧选择一个工具。</div>
    </div>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept" />
  </section>
</template>

<style scoped>
.tool-section-title{font-size:14px;margin:26px 0 12px;padding-top:16px;border-top:1px solid var(--border-subtle)}
.tool-command{display:grid;gap:6px;margin:14px 0;padding:12px 14px;border-radius:8px;background:#fff8e8;border:1px solid #f3dca8;font-size:13px}
.tool-command code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.tool-command small{color:#7a4a00;font-size:11px}
.tool-headers{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:12px;margin:0}
.tool-headers dt{color:var(--text-secondary)}
.tool-headers dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.tool-slot{border:1px solid var(--border-subtle);border-radius:8px;padding:10px 14px;margin-bottom:10px}
.tool-usage,.tool-issues{margin:6px 0 0;padding-left:20px;font-size:12px;line-height:1.8}
@media(max-width:760px){.tool-headers{grid-template-columns:1fr}}
</style>
