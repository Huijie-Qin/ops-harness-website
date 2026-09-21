<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiError, guideApi } from '../guide-api'
const emit = defineEmits<{ error: [error: unknown] }>()
type Row = Record<string, string | number | null>
type Result = { rows?: Row[]; total?: number; dataThrough?: string | null; asOf?: string; [key: string]: unknown }
const tabs = [{ id: 'overview', label: '总览' }, { id: 'users', label: '用户明细' }, { id: 'rankings', label: '活跃排名' }, { id: 'features', label: '功能使用' }, { id: 'conversations', label: '对话与 Token' }, { id: 'skills', label: 'Skill 使用' }, { id: 'operations', label: '操作明细' }, { id: 'health', label: '采集状态' }] as const
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const from = ref(new Date(Date.now() + 8 * 3600000 - 29 * 86400000).toISOString().slice(0, 10)), to = ref(today())
const environment = ref(''), version = ref('')
const environmentPreference = 'analytics.environment.v1'
const validEnvironment = (value: unknown): value is string => typeof value === 'string' && ['all', 'production', 'development', 'test'].includes(value)
function rememberEnvironment() {
  try { if (validEnvironment(environment.value)) localStorage.setItem(environmentPreference, environment.value) } catch {}
}
const tab = ref<string>('overview'), busy = ref(false), error = ref(''), data = ref<Result>(), trend = ref<Row[]>([]), health = ref<Result>()
const user = ref<{ id: string; name: string }>(), offset = ref(0)
let controller: AbortController | undefined
const names: Record<string, string> = { tools: '工具', skills: '技能', knowledge: '知识库', experts: '专家', tasks: '定时任务', todos: '目标与待办', conversation: '会话', creation: '内容创作', authentication: '认证', navigation: '页面访问', succeeded: '成功', failed: '失败', cancelled: '已取消', partial: '部分完成', unknown: '未知', user: '人工', agent: '模型', scheduler: '定时执行', system: '系统' }
Object.assign(names, {
  root: '主会话', subagent: '子代理', 'conversation.model.usage': '模型用量', 'skill.load.completed': '加载技能',
  'page.view': '页面访问', 'feature.view': '功能访问', 'auth.login.succeeded': '登录成功', 'auth.logout': '退出登录', 'conversation.message.accepted': '发送消息',
  'tool.add': '添加工具', 'tool.remove': '移除工具', 'tool.config.save': '保存工具配置', 'tool.connection.test': '测试连接', 'tool.invoke': '调用工具',
  'skill.install': '安装技能', 'skill.update': '更新技能', 'skill.uninstall': '卸载技能', 'skill.source.import': '导入技能', 'skill.source.save': '保存技能', 'skill.source.delete': '删除技能',
  'knowledge.add': '添加知识库', 'knowledge.remove': '移除知识库', 'knowledge.bind': '绑定知识库', 'knowledge.unbind': '解绑知识库', 'knowledge.import': '导入知识', 'knowledge.update': '更新知识', 'knowledge.delete': '删除知识', 'knowledge.query': '检索知识',
  'expert.use': '使用专家', 'expert.create': '创建专家', 'expert.clone': '克隆专家', 'expert.update': '更新专家', 'expert.delete': '删除专家',
  'creation.generate': '生成内容', 'creation.publish': '保存作品', 'creation.export': '导出作品',
  'task.create': '创建任务', 'task.update': '更新任务', 'task.pause': '暂停任务', 'task.resume': '恢复任务', 'task.delete': '删除任务', 'task.run': '执行任务',
  'todo.refresh': '刷新待办', 'todo.suggestion.open': '查看建议',
})
const label = (value: unknown) => value == null || value === '' ? '—' : names[String(value)] ?? String(value)
const rows = computed(() => data.value?.rows ?? [])
const peak = computed(() => Math.max(1, ...trend.value.map(row => Number(row.dau))))
const metrics = computed(() => tab.value === 'conversations' ? [
  ['人工对话次数', data.value?.messages, '实际进入处理流程的 Web 用户消息数'],
  ['人工会话数', data.value?.conversations, '所选期间有人工消息的会话去重'],
  ['已报告 Token', data.value?.totalTokens, '所有来源，含缓存；推理不重复相加'],
  ['模型步骤', data.value?.modelSteps, '一次模型步骤可能请求多个工具'],
  ['未报告用量的步骤', data.value?.missingUsage, '不估算 Token，不等于零消耗'],
  ['匿名 Token', data.value?.anonymousTokens, '未记录工号，仍计入总量'],
] : tab.value === 'skills' ? [
  ['加载成功', data.value?.loads, 'Skill 指令已提供给模型'],
  ['显式加载', data.value?.explicitLoads, '通过 /技能名 进入处理流程'],
  ['模型加载', data.value?.modelLoads, '模型调用 skill 工具成功'],
  ['加载失败', data.value?.failures, '有明确结果的模型加载失败'],
  ['已识别使用人数', data.value?.users, '成功加载的登录工号去重'],
  ['使用会话数', data.value?.conversations, '成功加载的会话去重，含子代理'],
] : [
  ['登录用户数', data.value?.loginUsers, '所选期间有前台活动的登录工号去重'],
  ['主动使用人数', data.value?.activeUsers, '所选期间发起业务操作或对话的用户'],
  ['DAU', data.value?.dau, `${to.value} 主动业务使用人数`],
  ['MAU', data.value?.mau, '截至所选日，近 30 天去重'],
  ['DAU / MAU', data.value?.stickiness == null ? '—' : `${(Number(data.value.stickiness) * 100).toFixed(1)}%`, '同一截至日的活跃比率'],
  ['成功操作数', data.value?.successes, '人工操作；变更类需实际生效'],
])
const columns = computed(() => tab.value === 'users' || tab.value === 'rankings'
  ? [['displayName', '用户'], ['account', '工号'], ['activeDays', '活跃天数'], ['interactions', '主动操作'], ['messages', '对话次数'], ['conversations', '会话数'], ['totalTokens', 'Token'], ['skillLoads', 'Skill 加载'], ['successes', '成功操作'], ['features', '使用功能数'], ['lastSeen', '最近活动']]
  : tab.value === 'features' ? [['feature', '功能'], ['users', '使用人数'], ['visitors', '访问人数'], ['uses', '使用次数'], ['successes', '成功操作'], ['failures', '失败操作']]
  : tab.value === 'conversations' ? [['initiator', '来源'], ['sessionKind', '会话类型'], ['messages', '人工消息'], ['conversations', '人工会话'], ['modelSteps', '模型步骤'], ['missingUsage', '用量缺失'], ['inputTokens', '普通输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['outputTokens', '输出'], ['reasoningTokens', '其中推理'], ['totalTokens', 'Token 总量']]
  : tab.value === 'skills' ? [['skillName', 'Skill'], ['loads', '成功加载'], ['users', '已识别人数'], ['installations', '安装实例'], ['conversations', '会话数'], ['explicitLoads', '显式加载'], ['modelLoads', '模型加载'], ['userLoads', '人工回合加载'], ['failures', '加载失败']]
  : tab.value === 'health' ? [['code', '采集提示'], ['count', '记录数']]
  : [['occurredAt', '时间'], ['displayName', '用户'], ['feature', '功能'], ['action', '动作'], ['eventName', '阶段'], ['initiator', '来源'], ['outcome', '结果'], ['durationMs', '耗时（ms）']])
function format(key: string, value: unknown) {
  if (key === 'displayName' && !value) return '未识别 / 未提供姓名'
  if (['occurredAt', 'lastSeen'].includes(key) && value) return new Date(String(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  if (key === 'eventName') return value === 'operation.accepted' ? '受理' : value === 'operation.finished' ? '完成' : label(value)
  return label(value)
}
async function load() {
  controller?.abort(); const request = new AbortController(); controller = request
  if (!from.value || !to.value || from.value > to.value || Date.parse(to.value) - Date.parse(from.value) > 399 * 86400000) { busy.value = false; error.value = '请选择不超过 400 天的有效日期范围。'; return }
  busy.value = true; error.value = ''
  try {
    if (!validEnvironment(environment.value)) {
      const context = await guideApi<{ defaultEnvironment: string }>('/api/admin/analytics/context', { signal: request.signal })
      if (request.signal.aborted) return
      if (!validEnvironment(context.defaultEnvironment)) throw new Error('INVALID_ANALYTICS_CONTEXT')
      let saved: string | null = null
      try { saved = localStorage.getItem(environmentPreference) } catch {}
      environment.value = validEnvironment(saved) ? saved : context.defaultEnvironment
    }
    const query = new URLSearchParams({ from: from.value, to: to.value, environment: environment.value, offset: String(offset.value), limit: '50' })
    if (version.value) query.set('appVersion', version.value)
    if (user.value) query.set('userId', user.value.id)
    const call = (kind: string) => guideApi<Result>(`/api/admin/analytics/${kind}?${query}`, { signal: request.signal })
    const [result, state, trends] = await Promise.all([call(tab.value), call('health'), tab.value === 'overview' ? call('trends') : Promise.resolve(undefined)])
    if (request.signal.aborted) return
    data.value = result; health.value = state; trend.value = trends?.rows ?? []
  } catch (e) {
    if (request.signal.aborted) return
    error.value = '统计暂时无法读取，请稍后重试。已显示的数据可能不是最新。'
    if (e instanceof ApiError && ['AUTH_REQUIRED','CSRF_REJECTED'].includes(e.code)) emit('error', e)
  } finally { if (controller === request) busy.value = false }
}
function switchTab(id: string) { tab.value = id; offset.value = 0; data.value = undefined; void load() }
function apply() { offset.value = 0; data.value = undefined; void load() }
function inspect(row: Row) { user.value = { id: String(row.userId), name: String(row.displayName || row.account) }; switchTab('operations') }
function clearUser() { user.value = undefined; apply() }
function page(direction: number) { offset.value = Math.max(0, offset.value + direction * 50); void load() }
onMounted(load)
onBeforeUnmount(() => controller?.abort())
</script>
<template>
  <section class="analytics" aria-label="运营统计" :aria-busy="busy">
    <header class="analytics-heading"><div><h2>运营统计</h2><p>了解用户活跃与功能使用。按工作助手当前登录工号跨设备去重，时间统一为北京时间。</p></div><button class="button secondary" :disabled="busy" @click="load">{{busy?'正在更新…':'刷新数据'}}</button></header>
    <form class="analytics-filters" @submit.prevent="apply">
      <label>开始日期<input v-model="from" type="date" required /></label><label>结束日期<input v-model="to" type="date" :max="today()" required /></label>
      <label>应用版本<input v-model="version" placeholder="全部版本" maxlength="64" pattern="[0-9][a-zA-Z0-9.+-]{0,63}" /></label>
      <fieldset :disabled="busy"><legend>环境</legend><label v-for="option in [['all','全部环境'],['production','生产'],['development','开发'],['test','测试']]" :key="option[0]"><input v-model="environment" type="radio" name="analytics-environment" :value="option[0]" @change="rememberEnvironment" />{{option[1]}}</label></fieldset>
      <button class="button primary" :disabled="busy">应用筛选</button>
    </form>
    <p v-if="user" class="analytics-user">正在查看：{{user.name}}<button class="button secondary" @click="clearUser">返回全部用户</button></p>
    <nav class="analytics-tabs" aria-label="统计视图"><button v-for="item in tabs" :key="item.id" :aria-pressed="tab===item.id" @click="switchTab(item.id)">{{item.label}}</button></nav>
    <p v-if="error" class="admin-error" role="alert">{{error}}</p>
    <p v-if="busy && !data" role="status">正在读取统计…</p>
    <p v-else-if="health && !Number(health.collected)" class="analytics-empty">当前环境与筛选范围暂无采集记录。请确认上方环境与终端配置一致；本地调试数据请在“开发”环境查看。</p>
    <p v-else-if="health && !Number(health.identifiedEvents)" class="analytics-notice">当前范围的 {{health.anonymousEvents}} 条事件未记录登录工号，仍可查看操作、对话与 Skill 次数。新版工作助手会随打点记录左下角的登录工号；历史匿名记录不归入当前账号。</p>
    <template v-if="data">
      <div v-if="['overview','conversations','skills'].includes(tab)" class="analytics-metrics"><article v-for="metric in metrics" :key="String(metric[0])"><span>{{metric[0]}}</span><strong>{{metric[1]??'—'}}</strong><small>{{metric[2]}}</small></article></div>
      <div v-if="tab==='overview'" class="analytics-chart"><h3>每日主动活跃用户</h3><p v-if="!trend.length" class="analytics-empty">所选范围暂无已识别用户的主动行为。</p><ol v-else aria-label="每日活跃人数"><li v-for="row in trend" :key="String(row.day)"><time>{{row.day}}</time><span class="analytics-bar"><i :style="{width:`${Number(row.dau)/peak*100}%`}"></i></span><strong>{{row.dau}}</strong></li></ol></div>
      <div v-if="tab==='health'" class="analytics-metrics"><article><span>所选范围事件</span><strong>{{data.collected}}</strong><small>按事件 ID 去重；不代表完整采集率</small></article><article><span>已上报的安装实例</span><strong>{{data.installations}}</strong><small>安装实例数与用户人数分别统计</small></article><article><span>所选范围匿名事件</span><strong>{{data.anonymousEvents}}</strong><small>未归入用户活跃指标</small></article></div>
      <template v-if="tab!=='overview'">
        <p v-if="tab==='rankings'" class="analytics-caption">按活跃天数、成功操作数、使用功能数依次排名。</p>
        <p v-if="tab==='operations'" class="analytics-caption">操作明细保留 90 天。受理与完成分别显示；同一操作在统计中只计一次。</p>
        <p v-if="tab==='conversations'" class="analytics-caption">Token = 普通输入 + 缓存读取 + 缓存写入 + 输出；推理已包含在输出中。仅统计已结束步骤报告的用量，模型重试、辅助模型请求和未结束步骤可能未覆盖。</p>
        <p v-if="tab==='skills'" class="analytics-caption">按运行时 Skill 名称聚合，版本与来源暂不拆分。加载成功不代表整个任务成功；安装、目录浏览和未执行的点击不算使用。匿名加载计次数，不计用户人数。</p>
        <div v-if="rows.length" class="analytics-table" role="region" aria-label="统计明细" tabindex="0"><table><thead><tr><th v-if="tab==='rankings'" scope="col">排名</th><th v-for="column in columns" :key="column[0]" scope="col">{{column[1]}}</th></tr></thead><tbody><tr v-for="(row,index) in rows" :key="String(row.userId??row.eventId??row.skillName??row.feature??row.code??`${row.initiator}:${row.sessionKind}`)"><td v-if="tab==='rankings'">{{offset+index+1}}</td><td v-for="column in columns" :key="column[0]"><button v-if="column[0]==='displayName' && (tab==='users'||tab==='rankings')" class="analytics-link" @click="inspect(row)">{{format(column[0]!,row[column[0]!])}}</button><span v-else>{{format(column[0]!,row[column[0]!])}}</span></td></tr></tbody></table></div>
        <p v-else-if="!busy" class="analytics-empty">{{tab==='health'?'暂无拒收记录。':'没有符合筛选条件的记录。'}}</p>
        <div v-if="['users','rankings','operations','skills'].includes(tab)" class="analytics-pages"><button class="button secondary" :disabled="busy||offset===0" @click="page(-1)">上一页</button><span>第 {{offset/50+1}} 页<span v-if="data.total!=null"> · 共 {{data.total}} {{tab==='skills'?'项':'人'}}</span></span><button class="button secondary" :disabled="busy||rows.length<50||(data.total!=null&&offset+50>=data.total)" @click="page(1)">下一页</button></div>
      </template>
      <p class="analytics-caption">人工对话覆盖当前官方 Web 消息入口；其他提交来源保留为未知，子代理单列。用户明细可点击姓名，再切换视图查看该用户的对话与 Skill 使用。</p>
      <p class="analytics-caption">最后收到数据：{{data.dataThrough?new Date(String(data.dataThrough)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚无数据'}} · DAU 只计人工业务受理，后台轮询与自动执行单列。</p>
    </template>
  </section>
</template>
<style scoped>
.analytics{color:var(--text-primary);display:grid;gap:20px}.analytics-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.analytics h2,.analytics h3{margin:0 0 8px}.analytics-heading p,.analytics-caption{color:var(--text-secondary);font-size:13px}.analytics-filters{display:flex;flex-wrap:wrap;gap:16px;align-items:end;padding:18px;border:1px solid var(--border-default);border-radius:12px}.analytics-filters>label{display:grid;gap:7px;font-size:13px}.analytics input:not([type=radio]){padding:8px 10px;border:1px solid var(--border-default);border-radius:6px;background:var(--bg-primary);color:inherit;max-width:180px}.analytics fieldset{border:0;padding:0;display:flex;gap:10px;flex-wrap:wrap}.analytics legend{font-size:13px;margin-bottom:8px}.analytics fieldset label{font-size:13px;display:flex;align-items:center;gap:4px}.analytics-tabs{display:flex;flex-wrap:wrap;gap:8px}.analytics-tabs button{padding:9px 14px;border:1px solid var(--border-default);background:var(--bg-primary);border-radius:8px;cursor:pointer;color:inherit}.analytics-tabs [aria-pressed=true]{color:var(--accent-primary);border-color:var(--accent-primary)}.analytics-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.analytics-metrics article{display:grid;gap:12px;border:1px solid var(--border-default);padding:20px;border-radius:12px}.analytics-metrics strong{font-size:32px;font-variant-numeric:tabular-nums}.analytics-metrics small{color:var(--text-secondary)}.analytics-chart{padding:20px;border:1px solid var(--border-default);border-radius:12px}.analytics-chart ol{list-style:none;padding:0;max-height:350px;overflow:auto}.analytics-chart li{display:grid;grid-template-columns:100px 1fr 55px;gap:15px;align-items:center;margin:10px 0;font-size:13px}.analytics-bar{height:12px;background:var(--border-subtle);border-radius:4px;overflow:hidden}.analytics-bar i{display:block;height:100%;background:var(--accent-primary)}.analytics-table{overflow:auto;border:1px solid var(--border-default);border-radius:10px}.analytics table{border-collapse:collapse;width:100%;font-size:13px}.analytics th,.analytics td{padding:13px 15px;text-align:left;border-bottom:1px solid var(--border-subtle);white-space:nowrap}.analytics th{color:var(--text-secondary);background:var(--border-subtle)}.analytics-link{color:var(--accent-primary);background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}.analytics-empty{padding:26px;color:var(--text-secondary);border:1px dashed var(--border-default);border-radius:10px}.analytics-notice{padding:14px;border-left:3px solid var(--accent-primary);background:var(--border-subtle);font-size:13px}.analytics-pages,.analytics-user{display:flex;justify-content:space-between;align-items:center;gap:12px}.analytics :focus-visible{outline:2px solid var(--accent-primary);outline-offset:3px}@media(max-width:760px){.analytics-metrics{grid-template-columns:1fr}.analytics-heading{align-items:start;flex-direction:column}.analytics-filters{padding:12px}.analytics-filters>label{flex:1 1 130px;min-width:0}.analytics input:not([type=radio]){max-width:100%;min-width:0}.analytics-chart li{grid-template-columns:85px 1fr 30px}}
</style>
