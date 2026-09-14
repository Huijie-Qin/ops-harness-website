<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, nextTick } from 'vue'
import type { Chapter, ChapterSummary } from '../shared/guide'
import { guideApi, requestMessage } from './guide-api'
import MarkdownBody from './MarkdownBody.vue'

const chapters = ref<ChapterSummary[]>([]), results = ref<ChapterSummary[]>([])
const current = ref<Chapter>(), query = ref(''), error = ref(''), loading = ref(true), searching = ref(false)
const groups = computed(() => [...new Map(chapters.value.map(c => [c.navigationGroup ?? c.group, { id: c.navigationGroup ?? c.group, title: c.group }])).values()])
const position = computed(() => chapters.value.findIndex(chapter => chapter.id === current.value?.id))
let request: AbortController | undefined, searchRequest: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const aliases: Record<string, string> = { 'step-1':'installation','step-2':'models','step-3':'conversation','step-4':'skills' }
async function loadChapter() {
  const hash = location.hash.slice(1), id = (hash === 'main' ? current.value?.id : aliases[hash] ?? hash) || chapters.value[0]?.id
  if (!id) { loading.value = false; return }
  if (aliases[hash]) history.replaceState(null, '', `#${id}`)
  clearTimeout(timer); query.value = ''; searchRequest?.abort(); searching.value = false
  request?.abort(); const active = new AbortController(); request = active
  loading.value = true; error.value = ''
  try { const data = await guideApi<{chapter:Chapter}>(`/api/guide/${encodeURIComponent(id)}`,{signal:active.signal}); if (!active.signal.aborted) current.value = data.chapter }
  catch (e) { if (!active.signal.aborted) { error.value = requestMessage(e); current.value = undefined } }
  finally { if (!active.signal.aborted) loading.value = false }
}
async function initialize() {
  loading.value = true; error.value = ''
  request?.abort(); request = new AbortController()
  try {
    chapters.value = (await guideApi<{chapters:ChapterSummary[]}>('/api/guide',{signal:request.signal})).chapters
    if (!disposed) await loadChapter()
  } catch (e) { if (!disposed) { error.value = requestMessage(e); loading.value = false } }
}
function choose(id: string) { query.value = ''; if (location.hash === `#${id}`) void loadChapter(); else location.hash = id }
function search() {
  clearTimeout(timer); searchRequest?.abort(); error.value = ''
  if (!query.value.trim()) { results.value = []; searching.value = false; return }
  searching.value = true
  timer = setTimeout(async () => {
    const active = new AbortController(); searchRequest = active
    try { const data = await guideApi<{chapters:ChapterSummary[]}>(`/api/guide?q=${encodeURIComponent(query.value.trim())}`,{signal:active.signal}); if (!active.signal.aborted) results.value = data.chapters }
    catch (e) { if (!active.signal.aborted) error.value = requestMessage(e) }
    finally { if (!active.signal.aborted) searching.value = false }
  },250)
}
async function changed() {
  if(location.hash==='#main')return
  await loadChapter(); await nextTick()
  const heading = document.getElementById('chapter-title')
  heading?.focus({preventScroll:true})
  heading?.scrollIntoView({block:'start',behavior:'instant'})
}
onMounted(() => { window.addEventListener('hashchange',changed); void initialize() })
onBeforeUnmount(() => { disposed = true; request?.abort(); searchRequest?.abort(); clearTimeout(timer); window.removeEventListener('hashchange',changed) })
</script>
<template>
  <section class="handbook-heading container"><span class="eyebrow text-only">使用指南 / HANDBOOK</span><h1>从第一次打开，<br />到完成每天的工作。</h1><p>分章节了解每一步操作，随时查找你需要的答案。</p><div class="guide-path"><a href="#installation" @click.prevent="choose('installation')">安装应用</a><span>→</span><a href="#models" @click.prevent="choose('models')">配置模型</a><span>→</span><a href="#conversation" @click.prevent="choose('conversation')">完成第一项工作</a></div></section>
  <div class="handbook-layout container">
    <aside class="handbook-sidebar"><label for="guide-search">搜索指南</label><div class="guide-search"><input id="guide-search" v-model="query" type="search" maxlength="120" placeholder="例如：模型、知识库" @input="search" @keydown.esc="query='';search()" /><button v-if="query" aria-label="清空搜索" @click="query='';search()">清空</button></div>
      <nav aria-label="指南目录"><div v-for="group in groups" :key="group.id" class="guide-nav-group"><span>{{ group.title }}</span><a v-for="chapter in chapters.filter(item=>(item.navigationGroup??item.group)===group.id)" :key="chapter.id" :href="`#${chapter.id}`" :aria-current="!query && current?.id===chapter.id ? 'page':undefined" @click.prevent="choose(chapter.id)">{{ chapter.title }}</a></div></nav>
      <a class="guide-admin-link" href="/admin">管理员模式 ↗</a>
    </aside>
    <div class="handbook-content">
      <div v-if="error" role="alert" class="notice">{{ error }} <button @click="query ? search() : initialize()">重新加载</button></div>
      <template v-if="query.trim()"><p role="status" class="guide-loading">{{ searching ? '正在搜索…' : `找到 ${results.length} 个相关章节` }}</p><div v-if="!searching && !results.length && !error" class="guide-empty"><h2>没有找到相关内容</h2><p>试试“模型”“浏览器”“知识库”等关键词。</p><button class="button secondary" @click="query='';search()">返回章节</button></div><a v-for="chapter in results" v-show="!searching" :key="chapter.id" class="guide-result" :href="`#${chapter.id}`" @click.prevent="choose(chapter.id)"><small>{{ chapter.group }}</small><h2>{{ chapter.title }}</h2><p>{{ chapter.summary }}</p><span>阅读章节 →</span></a></template>
      <p v-else-if="loading" role="status" class="guide-loading">正在加载章节…</p>
      <article v-else-if="current" class="guide-chapter"><div class="chapter-meta">{{chapters.find(c=>c.id===current?.id)?.group??current.group}}<span v-if="position>=0">{{ String(position+1).padStart(2,'0') }} / {{ chapters.length }}</span></div><h2 id="chapter-title" tabindex="-1">{{ current.title }}</h2><p class="chapter-summary">{{ current.summary }}</p><MarkdownBody :key="current.revision" :markdown="current.markdown" /><div class="chapter-pagination"><a v-if="chapters[position-1]" :href="`#${chapters[position-1]!.id}`" @click.prevent="choose(chapters[position-1]!.id)">← {{ chapters[position-1]!.title }}</a><a v-if="chapters[position+1]" :href="`#${chapters[position+1]!.id}`" @click.prevent="choose(chapters[position+1]!.id)">{{ chapters[position+1]!.title }} →</a></div></article>
      <div v-else-if="!error" class="guide-empty"><h2>文档正在准备中</h2><p>章节发布后会显示在这里。</p></div>
    </div>
  </div>
</template>
<style scoped>
.handbook-heading{padding-top:58px;padding-bottom:43px}.handbook-heading h1{font-size:50px;line-height:1.35;margin:20px 0}.handbook-heading>p{font-size:14px;color:var(--text-secondary)}.guide-path{display:flex;gap:13px;font-size:12px;color:var(--accent-primary);margin-top:24px}.handbook-layout{display:grid;grid-template-columns:235px minmax(0,1fr);gap:62px;padding-bottom:80px}.handbook-sidebar{position:sticky;top:112px;align-self:start;max-height:calc(100dvh - 134px);overflow:auto;padding-right:5px;scrollbar-width:thin}.handbook-sidebar>label{display:block;font-size:12px;font-weight:600;margin-bottom:10px}.guide-search{position:relative}.guide-search input{width:100%;height:38px;border:1px solid var(--border-default);border-radius:7px;padding:0 48px 0 12px;background:#f8f9fc;font:inherit;font-size:12px}.guide-search button{position:absolute;right:5px;top:5px;height:28px;border:0;border-radius:4px;background:#eef0f8;color:var(--text-secondary);font-size:10px}.guide-nav-group{display:flex;flex-direction:column;margin-top:24px;gap:3px}.guide-nav-group>span{font-size:10px;color:var(--text-tertiary);padding:0 10px;margin-bottom:6px}.guide-nav-group>a{padding:9px 10px;font-size:12px;line-height:1.5;color:var(--text-secondary);border-left:2px solid transparent;border-radius:0 5px 5px 0}.guide-nav-group>a:hover{background:#f5f5fa}.guide-nav-group>a[aria-current]{color:var(--accent-primary);background:#f0effc;border-left-color:var(--accent-primary);font-weight:600}.guide-admin-link{display:block;margin:26px 10px 5px;color:var(--text-tertiary);font-size:11px}.handbook-content{min-width:0}.guide-chapter{border-top:1px solid var(--border-default);padding-top:32px}.chapter-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--accent-primary);margin-bottom:17px}.guide-chapter>h2{font-size:30px;margin-bottom:15px;line-height:1.4}.chapter-summary{font-size:14px;color:var(--text-secondary);padding-bottom:24px;border-bottom:1px solid var(--border-subtle);margin-bottom:28px}.chapter-pagination{display:flex;justify-content:space-between;gap:20px;padding-top:26px;border-top:1px solid var(--border-default);margin-top:45px;color:var(--accent-primary);font-size:12px}.guide-result{display:block;padding:24px 0;border-bottom:1px solid var(--border-default)}.guide-result small{font-size:11px;color:var(--accent-primary)}.guide-result h2{font-size:23px;margin:10px 0}.guide-result p,.guide-empty p{font-size:13px;color:var(--text-secondary)}.guide-result>span{color:var(--accent-primary);font-size:12px}.guide-loading{font-size:13px;color:var(--text-secondary);padding:16px 0}.guide-empty{padding:30px 0;min-height:300px}
@media(max-width:950px){.handbook-layout{grid-template-columns:200px minmax(0,1fr);gap:30px}.handbook-heading h1{font-size:43px}}@media(max-width:700px){.handbook-heading{padding-top:38px;padding-bottom:27px}.handbook-heading h1{font-size:34px}.handbook-heading>p{font-size:13px}.handbook-layout{grid-template-columns:1fr;gap:28px}.handbook-sidebar{position:static;max-height:none;padding:0}.handbook-sidebar nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.guide-nav-group{margin-top:20px}.guide-nav-group>a{font-size:11px;padding:7px}.guide-admin-link{margin-top:18px}.guide-chapter>h2{font-size:25px}.guide-path{gap:7px;font-size:11px}.chapter-pagination{flex-direction:column}}
</style>
