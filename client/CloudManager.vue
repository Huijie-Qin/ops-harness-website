<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CloudRun } from '@dsh-ops/cloud-task-contract'
import { ApiError, guideApi, requestMessage } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'

type TokenRecord = { hashPrefix: string; employeeId: string; kind: 'user' | 'executor'; label: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null }
type InstanceRecord = { employeeId: string; state: string; backend: string; backendRef: string | null; port: number | null; launchUrl: string | null; lastHeartbeatAt: string | null; bundleVersion: string | null; dshVersion: string | null; updatedAt: string; lastActivityAt: string; lastError: string | null; hasCatalog: boolean }
const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; busy: [v: boolean] }>()
const tokens = ref<TokenRecord[]>([]), instances = ref<InstanceRecord[]>([]), runs = ref<CloudRun[]>([]), backend = ref('')
const busy = ref(false), loading = ref(true), disabled = ref(false), notice = ref(''), error = ref('')
const form = ref({ employeeId: '', label: '', expiresInDays: '' })
const issued = ref<{ token: string; record: TokenRecord }>()
const copied = ref(false)
const runFilter = ref(''), showRevoked = ref(false)
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const errorElement = ref<HTMLElement>(), employeeInput = ref<HTMLInputElement>(), tokenField = ref<HTMLInputElement>()
const lifetime = new AbortController()
const visibleTokens = computed(() => tokens.value.filter(token => showRevoked.value || !token.revokedAt))
const stateLabels: Record<string, string> = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' }
const runLabels: Record<string, string> = { queued: '排队中', claimed: '已领取', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消', 'timed-out': '超时', expired: '已过期' }
const call = <T,>(url: string, options: { method?: string; data?: unknown } = {}) => guideApi<T>(url, { ...options, csrf: props.csrf, signal: lifetime.signal })
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; emit('busy', true); notice.value = ''; error.value = ''
  try { await fn() } catch (e) {
    if (e instanceof ApiError && e.code === 'CLOUD_NOT_ENABLED') { disabled.value = true; return }
    error.value = requestMessage(e)
    if (e instanceof ApiError && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(e.code)) emit('error', e)
    await nextTick(); errorElement.value?.focus()
  } finally { busy.value = false; emit('busy', false) }
}
async function list() {
  const [tokenList, instanceList, runList] = await Promise.all([
    call<{ tokens: TokenRecord[] }>('/api/admin/cloud/tokens'),
    call<{ instances: InstanceRecord[]; backend: string }>('/api/admin/cloud/instances'),
    call<{ runs: CloudRun[] }>(`/api/admin/cloud/runs?limit=50${runFilter.value.trim() ? `&employeeId=${encodeURIComponent(runFilter.value.trim().toLowerCase())}` : ''}`),
  ])
  tokens.value = tokenList.tokens; instances.value = instanceList.instances; backend.value = instanceList.backend; runs.value = runList.runs
  disabled.value = false; loading.value = false
}
function validEmployee(value: string) { return /^[a-z0-9._-]{1,64}$/.test(value.trim().toLowerCase()) }
async function issue() {
  const employeeId = form.value.employeeId.trim().toLowerCase()
  if (!validEmployee(employeeId)) { error.value = '工号只能包含小写字母、数字、点、下划线和连字符，最多 64 位。'; return }
  const days = form.value.expiresInDays.trim()
  if (days && !(/^\d{1,4}$/.test(days) && Number(days) >= 1 && Number(days) <= 3650)) { error.value = '有效期请填写 1–3650 天，留空表示长期有效。'; return }
  await run(async () => {
    issued.value = await call('/api/admin/cloud/tokens', { method: 'POST', data: { employeeId, label: form.value.label.trim(), ...(days ? { expiresInDays: Number(days) } : {}) } })
    copied.value = false
    form.value = { employeeId: '', label: '', expiresInDays: '' }
    await list()
    await nextTick(); tokenField.value?.focus(); tokenField.value?.select()
  })
}
async function copyToken() {
  if (!issued.value) return
  try { await navigator.clipboard.writeText(issued.value.token); copied.value = true } catch { tokenField.value?.select() }
}
function closeIssued() { issued.value = undefined; copied.value = false; void nextTick(() => employeeInput.value?.focus()) }
function revoke(token: TokenRecord) {
  confirmation.value = { title: '吊销这个令牌？', message: `${token.employeeId} · ${token.kind === 'user' ? '个人访问令牌' : '执行器令牌'}${token.label ? ` · ${token.label}` : ''}（${token.hashPrefix}…）。吊销立即生效，持有者的下一次请求将被拒绝，需要重新签发。`, label: '吊销令牌', action: () => void run(async () => {
    await call(`/api/admin/cloud/tokens/${token.hashPrefix}`, { method: 'DELETE', data: {} })
    await list(); notice.value = '令牌已吊销。'
  }) }
}
function stop(instance: InstanceRecord) {
  confirmation.value = { title: '停止这个实例？', message: `${instance.employeeId} 的云端实例将被停止并吊销其执行器令牌；排队中的任务会在下次调度时重新拉起实例。`, label: '停止实例', action: () => void run(async () => {
    await call(`/api/admin/cloud/instances/${encodeURIComponent(instance.employeeId)}/stop`, { method: 'POST', data: {} })
    await list(); notice.value = `已停止 ${instance.employeeId} 的实例。`
  }) }
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
function when(value: string | null | undefined) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
function tokenStatus(token: TokenRecord) {
  if (token.revokedAt) return { state: 'revoked', label: '已吊销' }
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return { state: 'expired', label: '已过期' }
  return { state: 'active', label: '有效' }
}
function heartbeat(instance: InstanceRecord) {
  if (!instance.lastHeartbeatAt) return '尚无心跳'
  const age = Date.now() - Date.parse(instance.lastHeartbeatAt)
  return age < 90_000 ? `${Math.max(1, Math.round(age / 1000))} 秒前` : when(instance.lastHeartbeatAt)
}
onMounted(() => run(list))
onBeforeUnmount(() => { lifetime.abort(); emit('busy', false) })
</script>

<template>
  <section class="cloud-manager" :aria-busy="busy">
    <div class="editor-heading">
      <div><h2>令牌、实例与运行</h2><p>按工号签发个人访问令牌，查看每用户云端实例与最近的运行记录。任务内容与计划由用户在工作助手中维护。</p></div>
      <div class="admin-actions"><button class="button secondary" :disabled="busy" @click="run(list)">刷新</button></div>
    </div>
    <p v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div v-if="disabled" class="admin-empty cloud-disabled"><strong>云端任务尚未启用。</strong><p>在官网配置的 <code>cloud</code> 节设置 <code>"enabled": true</code> 并选择编排后端后重启服务；说明见 docs/runbooks/cloud-tasks.md。</p></div>
    <template v-else>
      <p v-if="loading" class="editor-help" role="status">正在读取…</p>
      <section class="cloud-block" aria-labelledby="cloud-issue-heading">
        <h3 id="cloud-issue-heading">签发个人访问令牌</h3>
        <form class="cloud-issue" @submit.prevent="issue">
          <fieldset :disabled="busy">
            <label>工号<input ref="employeeInput" v-model="form.employeeId" required maxlength="64" autocomplete="off" placeholder="例如 w00000001" /></label>
            <label>备注<input v-model="form.label" maxlength="80" placeholder="例如 办公笔记本，可留空" /></label>
            <label>有效期（天）<input v-model="form.expiresInDays" inputmode="numeric" maxlength="4" placeholder="留空为长期" /></label>
            <button class="button primary">{{ busy ? '处理中…' : '签发令牌' }}</button>
          </fieldset>
        </form>
        <p class="editor-help">令牌明文只在签发后显示一次；用户在工作助手“设置 → 云端执行”中填写。服务端只保存哈希，可随时吊销。</p>
      </section>
      <section class="cloud-block" aria-labelledby="cloud-tokens-heading">
        <div class="cloud-block-heading"><h3 id="cloud-tokens-heading">令牌<span>（{{ visibleTokens.length }}）</span></h3><label class="check-label"><input v-model="showRevoked" type="checkbox" />显示已吊销</label></div>
        <div v-if="visibleTokens.length" class="cloud-table" role="region" aria-label="令牌列表，可横向滚动" tabindex="0"><table>
          <thead><tr><th scope="col">工号</th><th scope="col">类型</th><th scope="col">备注</th><th scope="col">前缀</th><th scope="col">创建</th><th scope="col">到期</th><th scope="col">最近使用</th><th scope="col">状态</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
          <tbody><tr v-for="token in visibleTokens" :key="token.hashPrefix"><td><strong>{{ token.employeeId }}</strong></td><td>{{ token.kind === 'user' ? '个人访问' : '执行器' }}</td><td class="cloud-wrap">{{ token.label || '—' }}</td><td><code>{{ token.hashPrefix }}</code></td><td>{{ when(token.createdAt) }}</td><td>{{ token.expiresAt ? when(token.expiresAt) : '长期' }}</td><td>{{ when(token.lastUsedAt) }}</td><td><span class="cloud-status" :class="tokenStatus(token).state">{{ tokenStatus(token).label }}</span></td><td><button v-if="!token.revokedAt" class="cloud-action danger" :disabled="busy" @click="revoke(token)">吊销</button></td></tr></tbody>
        </table></div>
        <p v-else-if="!loading" class="editor-help">尚未签发令牌。</p>
      </section>
      <section class="cloud-block" aria-labelledby="cloud-instances-heading">
        <div class="cloud-block-heading"><h3 id="cloud-instances-heading">实例<span>（{{ instances.length }}）</span></h3><span class="editor-help">编排后端：{{ backend === 'docker' ? 'Docker 容器' : backend === 'process' ? '本机进程（联调）' : '—' }}</span></div>
        <div v-if="instances.length" class="cloud-table" role="region" aria-label="实例列表，可横向滚动" tabindex="0"><table>
          <thead><tr><th scope="col">工号</th><th scope="col">状态</th><th scope="col">心跳</th><th scope="col">版本</th><th scope="col">最近活动</th><th scope="col">说明</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
          <tbody><tr v-for="instance in instances" :key="instance.employeeId"><td><strong>{{ instance.employeeId }}</strong><small v-if="instance.backendRef">{{ instance.backend }} · {{ instance.backendRef.slice(0, 12) }}{{ instance.port ? ` · ${instance.port}` : '' }}</small></td><td><span class="cloud-status" :class="instance.state">{{ stateLabels[instance.state] ?? instance.state }}</span></td><td>{{ heartbeat(instance) }}</td><td>{{ instance.bundleVersion ? `bundle ${instance.bundleVersion}` : '—' }}<small v-if="instance.dshVersion">DSH {{ instance.dshVersion }}</small></td><td>{{ when(instance.lastActivityAt) }}</td><td class="cloud-wrap"><span v-if="instance.lastError" class="cloud-error">{{ instance.lastError }}</span><a v-else-if="instance.launchUrl" :href="instance.launchUrl" target="_blank" rel="noopener">打开实例页面 ↗</a><span v-else>{{ instance.hasCatalog ? '已上报目录' : '—' }}</span></td><td><button v-if="['starting', 'running', 'error'].includes(instance.state)" class="cloud-action danger" :disabled="busy" @click="stop(instance)">停止</button></td></tr></tbody>
        </table></div>
        <p v-else-if="!loading" class="editor-help">还没有拉起过实例。用户首次打开云端任务时会准备专家目录；之后有排队任务时会自动启动实例。</p>
      </section>
      <section class="cloud-block" aria-labelledby="cloud-runs-heading">
        <div class="cloud-block-heading"><h3 id="cloud-runs-heading">最近运行<span>（{{ runs.length }}）</span></h3><form class="cloud-run-filter" role="search" @submit.prevent="run(list)"><input v-model="runFilter" type="search" aria-label="按工号筛选运行记录" placeholder="按工号筛选" maxlength="64" /><button class="button secondary" :disabled="busy">筛选</button></form></div>
        <div v-if="runs.length" class="cloud-table" role="region" aria-label="运行记录，可横向滚动" tabindex="0"><table>
          <thead><tr><th scope="col">任务</th><th scope="col">工号</th><th scope="col">状态</th><th scope="col">触发</th><th scope="col">排队</th><th scope="col">结束</th><th scope="col">结果</th></tr></thead>
          <tbody><tr v-for="item in runs" :key="item.id"><td><strong>{{ item.taskName }}</strong><small><code>{{ item.id }}</code></small></td><td>{{ item.employeeId }}</td><td><span class="cloud-status" :class="item.status">{{ runLabels[item.status] ?? item.status }}</span><small v-if="item.cancelRequested && !['cancelled'].includes(item.status)">已请求取消</small></td><td>{{ item.trigger === 'manual' ? '手动' : '计划' }}</td><td>{{ when(item.queuedAt) }}</td><td>{{ when(item.finishedAt) }}</td><td class="cloud-wrap">{{ item.errorCode ? `错误 ${item.errorCode}` : item.summary || (item.artifact ? `产物 ${item.artifact.fileCount} 个文件` : '—') }}</td></tr></tbody>
        </table></div>
        <p v-else-if="!loading" class="editor-help">{{ runFilter ? '该工号没有运行记录。' : '最近 7 天没有运行记录。' }}</p>
      </section>
    </template>
    <WebsiteDialog v-if="issued" title="令牌已签发" :message="`请立即复制并交给 ${issued.record.employeeId}；关闭后无法再次查看，只能重新签发。`" confirm-label="我已保存" @cancel="closeIssued" @confirm="closeIssued">
      <div class="cloud-token-reveal"><input ref="tokenField" :value="issued.token" readonly aria-label="令牌明文" spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /><button class="button secondary" type="button" @click="copyToken">{{ copied ? '已复制' : '复制' }}</button></div>
      <p class="editor-help">前缀 <code>{{ issued.record.hashPrefix }}</code>{{ issued.record.expiresAt ? ` · 到期 ${when(issued.record.expiresAt)}` : ' · 长期有效' }}</p>
    </WebsiteDialog>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept" />
  </section>
</template>

<style scoped>
.cloud-manager{min-width:0}.cloud-manager>.editor-heading{padding:0;margin-bottom:20px}.cloud-block{border:1px solid var(--border-default);border-radius:12px;padding:20px 24px;margin-bottom:20px;min-width:0}.cloud-block h3{font-size:16px;margin:0}.cloud-block h3 span{font-weight:400;color:var(--text-secondary);font-size:13px;margin-left:6px}.cloud-block-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;flex-wrap:wrap}.cloud-block-heading .editor-help{margin:0}
.cloud-issue fieldset{display:grid;grid-template-columns:minmax(160px,1fr) minmax(160px,1.4fr) 140px auto;gap:14px;align-items:end;margin-top:14px}.cloud-issue label{display:grid;gap:8px;font-size:12px;min-width:0}.cloud-issue .button{min-height:38px}
.cloud-table{border:1px solid var(--border-default);border-radius:8px;overflow:auto;background:#fff}.cloud-table table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;line-height:1.5}.cloud-table th,.cloud-table td{padding:10px 14px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border-subtle);vertical-align:top}.cloud-table th{position:sticky;top:0;background:#f7f8fc;font-weight:600;color:var(--text-secondary);font-size:12px;z-index:1}.cloud-table tbody tr:last-child td{border-bottom:0}.cloud-table small{display:block;font-size:11px;color:var(--text-tertiary);margin-top:4px}.cloud-table code{font-size:11px}.cloud-wrap{white-space:normal;min-width:200px;max-width:420px;overflow-wrap:anywhere}
.cloud-status{display:inline-block;padding:3px 8px;border-radius:999px;font-size:11px;background:#eef0f6;color:var(--text-secondary)}.cloud-status.active,.cloud-status.running,.cloud-status.succeeded{background:#e6f5ec;color:#2f6f4f}.cloud-status.starting,.cloud-status.claimed,.cloud-status.queued,.cloud-status.stopping{background:#fff4dd;color:#7a5b11}.cloud-status.error,.cloud-status.failed,.cloud-status.timed-out{background:#fdecec;color:#9a3c3c}.cloud-status.revoked,.cloud-status.stopped,.cloud-status.cancelled,.cloud-status.expired{background:#eef0f6;color:var(--text-tertiary)}.cloud-error{color:#9a3c3c}
.cloud-action{border:1px solid var(--border-default);border-radius:6px;padding:6px 10px;background:#fff;color:var(--text-secondary);font:inherit;font-size:12px}.cloud-action.danger{color:#a04848}.cloud-action:hover:not(:disabled){background:#f4f2ff;border-color:#c9c1f2}
.cloud-run-filter{display:flex;gap:8px;align-items:center}.cloud-run-filter input{height:36px;width:200px}.cloud-run-filter .button{min-height:36px}
.cloud-token-reveal{display:flex;gap:10px;align-items:center;margin-bottom:12px}.cloud-token-reveal input{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;flex:1}.cloud-disabled{padding:24px;border:1px dashed var(--border-default);border-radius:10px}.cloud-disabled strong{display:block;color:var(--text-primary);margin-bottom:8px}.cloud-disabled code{overflow-wrap:anywhere}
@media(max-width:900px){.cloud-issue fieldset{grid-template-columns:1fr 1fr}.cloud-issue .button{grid-column:1/-1}.cloud-block{padding:16px}}@media(max-width:560px){.cloud-issue fieldset{grid-template-columns:1fr}.cloud-run-filter{width:100%}.cloud-run-filter input{flex:1;width:auto}.cloud-token-reveal{flex-direction:column;align-items:stretch}}
@media(prefers-reduced-motion:reduce){.cloud-manager *{transition:none!important}}
</style>
