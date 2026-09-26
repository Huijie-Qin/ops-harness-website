<script setup lang="ts">
import AnalyticsManager from './analytics/AnalyticsManager.vue'
import AdminSidebar from './AdminSidebar.vue'
import { adminHash, parseAdminHash, adminSections, type AdminRoute, type AdminSection, type AnalyticsView } from './admin-route'
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { stringify } from 'yaml'
import type { Chapter, ChapterDraft, ChapterSummary, HistoryEntry } from '../shared/guide'
import { validChapterId } from '../shared/guide'
import type { Navigation, NavigationDocument, ContentSyncPreview } from '../shared/admin'
import { guideApi, ApiError, requestMessage } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'
const DirectoryManager = defineAsyncComponent(()=>import('./DirectoryManager.vue'))
const MarkdownBody = defineAsyncComponent(()=>import('./MarkdownBody.vue'))
const MediaLibrary = defineAsyncComponent(()=>import('./MediaLibrary.vue'))
const ReleaseManager = defineAsyncComponent(()=>import('./ReleaseManager.vue'))
const KnowledgeManager = defineAsyncComponent(()=>import('./KnowledgeManager.vue'))
const ExpertManager = defineAsyncComponent(()=>import('./ExpertManager.vue'))
const MarkdownEditor = defineAsyncComponent(()=>import('./MarkdownEditor.vue'))
const authenticated=ref(false),configured=ref(false),initializing=ref(true),busy=ref(false),password=ref(''),csrf=ref(''),error=ref(''),notice=ref('')
const chapters=ref<ChapterSummary[]>([]),filter=ref(''),draft=ref<ChapterDraft>(),revision=ref<string|null>(null),baseline=ref(''),editorKey=ref(0)
const history=ref<HistoryEntry[]>([]),historyPreview=ref<ChapterDraft>(),view=ref<'edit'|'preview'|'history'>('edit')
const confirmation=ref<{title:string;message:string;label?:string;action:()=>void}>()
const route=ref(parseAdminHash(window.location.hash))
const section=ref<AdminSection>(route.value.section),childDirty=ref(false),childBusy=ref(false),childKey=ref(0),entered=ref(false)
const sectionLabel=computed(()=>adminSections.find(item=>item.id===section.value)?.label??'管理后台')
const navigationDoc=ref<NavigationDocument>({groups:[],hidden:[],revision:''})
const managementDialog=ref<{type:string;id:string;groupId:string;value:string;summary?:string;documentId?:string}>(),syncPreview=ref<ContentSyncPreview>()
const activeGroup=computed(()=>navigationDoc.value.groups.find(g=>g.chapters.includes(draft.value?.id??'')))
const editableChapters=computed(()=>navigationDoc.value.groups.flatMap(group=>group.chapters.map(id=>chapters.value.find(c=>c.id===id)).filter((c):c is ChapterSummary=>!!c&&!c.archived).map(c=>({...c,directoryTitle:group.title}))).filter(c=>`${c.title} ${c.directoryTitle}`.toLowerCase().includes(filter.value.trim().toLowerCase())))
const allBusy=computed(()=>busy.value||childBusy.value)
const dirty=computed(()=>childDirty.value||(draft.value!==undefined&&JSON.stringify(draft.value)!==baseline.value))
function setRoute(next:AdminRoute,replace=false){
  route.value=next;section.value=next.section
  const hash=adminHash(next)
  if(location.hash!==hash)window.history[replace?'replaceState':'pushState'](null,'',hash)
}
async function restoreDocument(){
  if(section.value!=='guides'||!authenticated.value)return
  const id=editableChapters.value.find(item=>item.id===route.value.documentId)?.id??editableChapters.value[0]?.id
  if(id&&draft.value?.id!==id)await load(id)
  if(id&&draft.value?.id===id)setRoute({...route.value,documentId:id},true)
}
function goRoute(next:AdminRoute,replace=false){
  guard(()=>{setRoute(next,replace);error.value='';notice.value='';void restoreDocument()})
}
function switchSection(next:AdminSection,view?:AnalyticsView){
  if(next===section.value&&(!view||view===route.value.view))return
  const query=next==='analytics'&&section.value==='analytics'?new URLSearchParams(route.value.query):new URLSearchParams()
  if(view){query.delete('page');query.delete('search');query.delete('sort');query.delete('direction')}
  goRoute({section:next,view:view??'overview',query:query.toString(),...(next==='guides'&&draft.value?{documentId:draft.value.id}:{})})
}
function analyticsNavigate(view:AnalyticsView,query:string,replace=false){setRoute({section:'analytics',view,query},replace)}
function hashChanged(){
  if(location.hash===adminHash(route.value))return
  const next=parseAdminHash(location.hash)
  if(dirty.value||allBusy.value){window.history.replaceState(null,'',adminHash(route.value));goRoute(next)}
  else{setRoute(next,true);void restoreDocument()}
}
function chooseDocument(id:string){guard(()=>void load(id).then(()=>{if(draft.value?.id===id)setRoute({...route.value,documentId:id})}))}

const lifetime=new AbortController()
const exports=new Map<string,ReturnType<typeof setTimeout>>()
let allowLeave=false
function handleError(e:unknown){error.value=requestMessage(e);if(e instanceof ApiError && ['AUTH_REQUIRED','CSRF_REJECTED'].includes(e.code))authenticated.value=false}
async function run(action:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await action()}catch(e){handleError(e)}finally{busy.value=false}}
const call=<T,>(path:string,options:{method?:string;data?:unknown}={})=>guideApi<T>(path,{...options,csrf:csrf.value,signal:lifetime.signal})
function adopt(chapter:Chapter){const {revision:r,source,updatedAt,...value}=chapter;draft.value=value;revision.value=r;baseline.value=JSON.stringify(value);editorKey.value++;history.value=[];historyPreview.value=undefined;view.value='edit'}
async function list(){const [docs,nav]=await Promise.all([call<{chapters:ChapterSummary[]}>('/api/admin/guides'),call<NavigationDocument>('/api/admin/navigation')]);chapters.value=docs.chapters;navigationDoc.value=nav}
async function load(id:string){await run(async()=>adopt((await call<{chapter:Chapter}>(`/api/admin/guides/${id}`)).chapter))}
function guard(action:()=>void){if(allBusy.value)return;if(dirty.value)confirmation.value={title:'离开当前草稿？',message:'当前修改尚未保存。继续后会放弃这些修改，可以先取消并下载草稿。',label:'放弃修改',action:()=>{if(draft.value&&JSON.stringify(draft.value)!==baseline.value){draft.value=baseline.value?JSON.parse(baseline.value):undefined;editorKey.value++}childKey.value++;childDirty.value=false;action()}};else action()}
function accept(){const action=confirmation.value?.action;confirmation.value=undefined;action?.()}
async function login(){await run(async()=>{const secret=password.value;password.value='';const result=await call<{csrf:string}>('/api/admin/login',{method:'POST',data:{password:secret}});csrf.value=result.csrf;authenticated.value=true;entered.value=true;await list();if(section.value==='guides'){const id=editableChapters.value.find(item=>item.id===route.value.documentId)?.id??editableChapters.value[0]?.id;if(id){adopt((await call<{chapter:Chapter}>(`/api/admin/guides/${id}`)).chapter);setRoute({...route.value,documentId:id},true)}}})}
function logout(){guard(()=>void run(async()=>{await call('/api/admin/logout',{method:'POST',data:{}});authenticated.value=false;entered.value=false;childDirty.value=false;childKey.value++;csrf.value='';draft.value=undefined;baseline.value='';chapters.value=[]}))}
async function editDocument(id:string){await run(async()=>{adopt((await call<{chapter:Chapter}>(`/api/admin/guides/${id}`)).chapter);setRoute({section:'guides',view:'overview',query:'',documentId:draft.value?.id});filter.value='';await nextTick();document.getElementById('document-editor-title')?.focus()})}
async function save(){
  const chapter=draft.value
  if(!chapter||chapter.archived||allBusy.value)return
  if(!validChapterId(chapter.id)){error.value='请填写章节标识：以小写字母开头，只使用小写字母、数字和连字符。';return}
  if(!chapter.markdown.trim()){error.value='请填写 Markdown 正文后再保存。';return}
  if(!Number.isSafeInteger(chapter.order)||chapter.order<0||chapter.order>100000){error.value='排序请填写 0–100000 之间的整数。';return}
  await run(async()=>{const result=await call<{chapter:Chapter}>(`/api/admin/guides/${encodeURIComponent(chapter.id)}`,{method:'PUT',data:{chapter,revision:revision.value}});adopt(result.chapter);await list();notice.value='已保存，阅读页现在显示这个版本。'})
}
async function saveNavigation(value:Navigation){navigationDoc.value=await call<NavigationDocument>('/api/admin/navigation',{method:'PUT',data:{navigation:value,revision:navigationDoc.value.revision}});await list();notice.value='目录已保存，阅读页已更新。'}
function swap<T>(items:T[],index:number,next:number){if(index>=0&&next>=0&&next<items.length)[items[index],items[next]]=[items[next]!,items[index]!]}
function newContentId(){
  // getRandomValues also works on internal HTTP origins, unlike randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')
}
function manageAction(type:string,id:string,groupId:string){
  if(allBusy.value)return
  if(type==='archive-document'){archive(id);return}
  if(['create-document','create-directory','rename-directory','edit-document','move-document'].includes(type)){
    error.value='';notice.value=''
    const chapter=chapters.value.find(c=>c.id===id)
    managementDialog.value={type,id,groupId,value:type==='rename-directory'?navigationDoc.value.groups.find(g=>g.id===id)!.title:type==='edit-document'?chapter!.title:type==='move-document'?groupId:'',summary:chapter?.summary??'',documentId:`doc-${newContentId()}`}
    return
  }
  const perform=()=>void run(async()=>{
    const {revision,...value}=JSON.parse(JSON.stringify(navigationDoc.value)) as NavigationDocument
    const group=value.groups.find(g=>g.id===groupId)!
    if(type==='delete-directory')value.groups=value.groups.filter(g=>g.id!==id)
    else if(type==='toggle-visibility')value.hidden=value.hidden.includes(id)?value.hidden.filter(v=>v!==id):[...value.hidden,id]
    else {const delta=type.endsWith('-up')?-1:1;if(type.startsWith('directory-')){const index=value.groups.findIndex(g=>g.id===id);swap(value.groups,index,index+delta)}else{const index=group.chapters.indexOf(id);swap(group.chapters,index,index+delta)}}
    await saveNavigation(value)
    if(type==='delete-directory'){await nextTick();document.getElementById('management-filter')?.focus()}
  })
  if(type==='delete-directory')confirmation.value={title:'删除空目录？',message:'该目录下没有文档，删除后立即更新阅读目录。',label:'删除目录',action:perform};else perform()
}
async function submitManagementDialog(){const item=managementDialog.value;if(!item||!item.value.trim()||(item.type==='move-document'&&item.value===item.groupId))return;await run(async()=>{
  if(item.type==='create-document'){
    if(!validChapterId(item.documentId??''))throw new ApiError('INVALID_CHAPTER')
    const group=navigationDoc.value.groups.find(g=>g.id===item.groupId)!
    const chapter:ChapterDraft={id:item.documentId!,title:item.value.trim(),summary:item.summary??'',group:group.title,order:Math.min(100000,Math.max(0,...chapters.value.map(c=>c.order))+10),archived:false,markdown:'## 操作步骤\n\n在这里编写步骤。\n\n## 完成标志\n\n说明如何确认操作成功。\n'}
    const result=await call<{chapter:Chapter}>(`/api/admin/guides/${chapter.id}`,{method:'PUT',data:{chapter,revision:null,groupId:group.id,navigationRevision:navigationDoc.value.revision}})
    adopt(result.chapter);await list();setRoute({section:'guides',view:'overview',query:'',documentId:draft.value?.id});filter.value='';notice.value='文档已创建，请编辑正文并保存。'
  }else if(item.type==='edit-document'){
    const summary=chapters.value.find(c=>c.id===item.id)!,current=(await call<{chapter:Chapter}>(`/api/admin/guides/${item.id}`)).chapter
    if(current.revision!==summary.revision)throw new ApiError('REVISION_CONFLICT')
    const {revision,source,updatedAt,...chapter}=current
    const result=await call<{chapter:Chapter}>(`/api/admin/guides/${item.id}`,{method:'PUT',data:{chapter:{...chapter,title:item.value.trim(),summary:item.summary??''},revision}})
    if(draft.value?.id===item.id)adopt(result.chapter);await list();notice.value='文档名称与简介已保存。'
  }else{
    const {revision,...value}=JSON.parse(JSON.stringify(navigationDoc.value)) as NavigationDocument
    if(item.type==='create-directory')value.groups.push({id:newContentId(),title:item.value.trim(),chapters:[]})
    else if(item.type==='rename-directory')value.groups.find(g=>g.id===item.id)!.title=item.value.trim()
    else {const source=value.groups.find(g=>g.id===item.groupId)!,target=value.groups.find(g=>g.id===item.value)!;source.chapters=source.chapters.filter(id=>id!==item.id);target.chapters.push(item.id)}
    await saveNavigation(value)
  }
  managementDialog.value=undefined
  if(item.type==='create-document'){await nextTick();document.getElementById('document-editor-title')?.focus()}
})}
async function prepareSync(){if(childDirty.value){error.value='请先保存当前页面的修改。';return}if(dirty.value){await save();if(dirty.value)return}await run(async()=>{const result=await guideApi<ContentSyncPreview>('/api/admin/content-sync',{csrf:csrf.value,signal:lifetime.signal,timeout:30*60*1000});if(result.files.length)syncPreview.value=result;else notice.value='content 已包含全部已保存内容，无需覆盖。'})}
async function syncContent(){const preview=syncPreview.value;if(!preview)return;await run(async()=>{const result=await guideApi<{files:number}>('/api/admin/content-sync',{method:'POST',data:{revision:preview.revision},csrf:csrf.value,signal:lifetime.signal,timeout:30*60*1000});syncPreview.value=undefined;notice.value=`已将 ${result.files} 个文件同步到 content，可检查后提交到主仓。`;await list()})}
function archive(id:string){const chapter=chapters.value.find(c=>c.id===id);if(!chapter)return;const archived=!chapter.archived;confirmation.value={title:archived?'将文档移至回收站？':'恢复这个文档？',message:archived?`“${chapter.title}”将停止公开，内容和历史版本仍会保留。`:`“${chapter.title}”将恢复公开访问，并保留原来的目录位置与可见性。`,label:archived?'移至回收站':'恢复文档',action:()=>void run(async()=>{const result=await call<{chapter:Chapter}>(`/api/admin/guides/${id}/archive`,{method:'POST',data:{archived,revision:chapter.revision}});if(draft.value?.id===id){if(archived){draft.value=undefined;baseline.value='';revision.value=null}else adopt(result.chapter)}await list();notice.value=archived?'已移至回收站。':'文档已恢复。';await nextTick();document.getElementById('management-filter')?.focus()})}}
async function showHistory(){view.value='history';if(!draft.value||!revision.value)return;await run(async()=>{history.value=(await call<{history:HistoryEntry[]}>(`/api/admin/guides/${draft.value!.id}/history`)).history})}
async function inspect(entry:HistoryEntry){await run(async()=>{historyPreview.value=(await call<{chapter:ChapterDraft}>(`/api/admin/guides/${draft.value!.id}/history/${entry.revision}`)).chapter})}
function restore(){confirmation.value={title:'恢复这个版本的正文？',message:'当前正文会保留在历史记录中，未保存的正文将被替换。文档名称、简介及目录设置保持当前值。',label:'恢复正文',action:()=>void run(async()=>{if(!draft.value||!historyPreview.value)return;const result=await call<{chapter:Chapter}>(`/api/admin/guides/${draft.value.id}`,{method:'PUT',data:{chapter:{...draft.value,markdown:historyPreview.value.markdown},revision:revision.value}});adopt(result.chapter);await list();notice.value='历史正文已恢复。'})}}
function exportDraft(){if(!draft.value)return;const {markdown,...meta}=draft.value;const blob=new Blob([`---\n${stringify(meta)}---\n\n${markdown}`],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${draft.value.id||'chapter'}-draft.md`;a.click();exports.set(url,setTimeout(()=>{URL.revokeObjectURL(url);exports.delete(url)},1000))}
function navigation(event:MouseEvent){if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const link=(event.target as HTMLElement).closest('a');if(link?.closest('.admin-navigation')&&link.getAttribute('href')?.startsWith('#'))return;if(!dirty.value&&!allBusy.value)return;if(link?.href && link.target!=='_blank' && !link.hasAttribute('download')){event.preventDefault();guard(()=>{allowLeave=true;location.href=link.href})}}
function beforeUnload(event:BeforeUnloadEvent){if((dirty.value||allBusy.value)&&!allowLeave){event.preventDefault();event.returnValue=''}}
onMounted(async()=>{document.addEventListener('click',navigation,true);window.addEventListener('beforeunload',beforeUnload);window.addEventListener('hashchange',hashChanged);setRoute(route.value,true);try{const result=await call<{configured:boolean;authenticated:boolean;csrf?:string}>('/api/admin/session');configured.value=result.configured;authenticated.value=result.authenticated;csrf.value=result.csrf??'';if(result.authenticated){entered.value=true;await list();await restoreDocument()}}catch(e){handleError(e)}finally{initializing.value=false}})
onBeforeUnmount(()=>{lifetime.abort();document.removeEventListener('click',navigation,true);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('hashchange',hashChanged);for(const [url,timer] of exports){clearTimeout(timer);URL.revokeObjectURL(url)}})
</script>
<template>
  <div class="guide-admin" :class="authenticated?'admin-shell':'container admin-login-page'">
    <AdminSidebar v-if="authenticated" :section="section" :view="route.view" :busy="allBusy" @navigate="switchSection" @logout="logout" />
    <a v-else class="brand admin-login-brand" href="/"><img src="/brand.svg" alt="" />终端云工作助手</a>
    <div class="admin-main">
    <div v-if="section!=='analytics'||!authenticated" class="admin-heading"><div><span class="eyebrow text-only">{{authenticated?'管理后台':'官网 / 管理员'}}</span><h1>{{authenticated?sectionLabel:'管理员登录'}}</h1><p>{{authenticated?'管理软件发布与帮助内容。':'通过密码认证后进入管理工作区。'}}</p></div><div class="admin-actions"><a class="button secondary" href="/guide">返回阅读</a><button v-if="authenticated" class="button secondary" :disabled="allBusy" @click="prepareSync">同步到 content</button></div></div>
    <p v-if="initializing" role="status">正在检查登录状态…</p>
    <div v-if="error" class="admin-error" role="alert">{{ error }}<button v-if="draft && authenticated && section==='guides'" @click="exportDraft">下载当前草稿</button><button v-if="section==='documents' && authenticated" :disabled="allBusy" @click="run(list)">读取最新目录</button><button v-if="draft && revision && authenticated && section==='guides'" :disabled="allBusy" @click="guard(()=>load(draft!.id))">读取最新版本</button></div>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <form v-if="!initializing && !authenticated" class="admin-login" @submit.prevent="login"><h2>密码认证</h2><p v-if="configured">使用管理员密码登录，管理软件发布与帮助内容。</p><div v-else class="admin-setup"><p>管理员登录尚未配置，阅读功能不受影响。</p><p>请在服务启动环境中设置 <code>DSH_OPS_WEBSITE_ADMIN_PASSWORD</code>，然后重启官网服务。本机开发模式至少 6 位，其他环境至少 16 位，最长 256 位。密码不保存在浏览器或文档中。</p></div><label for="admin-password">管理员密码</label><input id="admin-password" v-model="password" type="password" name="password" autocomplete="current-password" maxlength="256" :disabled="!configured||busy" required /><button class="button primary" :disabled="!configured||busy||!password">{{ busy?'正在登录…':'登录' }}</button></form>

    <div v-if="entered" v-show="authenticated" class="admin-section-body"><AnalyticsManager v-if="section==='analytics' && authenticated" :view="route.view" :query="route.query" @navigate="analyticsNavigate" @error="handleError" /><ReleaseManager v-if="section==='releases'" :key="childKey" :csrf="csrf" @error="handleError" @dirty="childDirty=$event" @busy="childBusy=$event" /><KnowledgeManager v-if="section==='knowledge'" :key="childKey" :csrf="csrf" @error="handleError" @dirty="childDirty=$event" @busy="childBusy=$event" /><ExpertManager v-if="section==='experts'" :key="childKey" :csrf="csrf" @error="handleError" @dirty="childDirty=$event" @busy="childBusy=$event" /><MediaLibrary v-if="section==='media'" :key="childKey" :csrf="csrf" @error="handleError" @busy="childBusy=$event" /></div>
    <DirectoryManager v-if="authenticated && section==='documents'" :navigation="navigationDoc" :chapters="chapters" :busy="allBusy" @edit="editDocument" @action="manageAction" />
    <div v-if="authenticated && section==='guides'" class="admin-layout" :aria-busy="busy">
      <aside class="admin-sidebar editor-sidebar"><h2>选择文档</h2><label for="chapter-filter">查找文档</label><input id="chapter-filter" v-model="filter" type="search" placeholder="标题或目录名称" /><nav aria-label="可编辑文档"><button v-for="chapter in editableChapters" :key="chapter.id" :aria-current="draft?.id===chapter.id?'true':undefined" :disabled="allBusy" @click="chooseDocument(chapter.id)"><span>{{chapter.title}}</span><small>{{chapter.directoryTitle}}</small></button></nav><p v-if="!editableChapters.length" class="admin-empty">{{filter?'没有匹配的文档。':'暂无可编辑文档，请到“目录与文档管理”中创建。'}}</p></aside>
      <section v-if="draft" class="admin-workspace"><div class="editor-heading"><div><h2 id="document-editor-title" tabindex="-1">{{ draft.title }}</h2><p>{{activeGroup?.title??draft.group}} · {{ dirty?'有未保存的修改':draft.archived?'已在回收站':'已保存' }}</p></div><div class="admin-actions"><button class="button secondary" @click="exportDraft">下载草稿</button><button class="button primary" :disabled="allBusy||!dirty||draft.archived" @click="save">{{ busy?'处理中…':'保存并发布' }}</button></div></div>
        <div class="admin-editor-tabs" role="group" aria-label="编辑视图"><button :aria-pressed="view==='edit'" @click="view='edit'">编辑内容</button><button :aria-pressed="view==='preview'" @click="view='preview'">阅读预览</button><button :aria-pressed="view==='history'" :disabled="!revision||busy" @click="showHistory">历史版本</button></div>
        <div v-show="view==='edit'" class="editor-content"><div class="editor-label"><strong>Markdown 正文</strong><span>Markdown · 支持图片、表格、链接与代码块</span></div><MarkdownEditor :csrf="csrf" @busy="childBusy=$event" @error="handleError" :document-key="String(editorKey)" v-model="draft.markdown" :disabled="allBusy||draft.archived" @save="save" /><p class="editor-help">可在编辑器工具栏切换分屏、即时渲染和所见即所得。支持上传、粘贴和拖入图片，也可从图片库插入。使用标准 Markdown 保存图文内容。</p></div>
        <article v-if="view==='preview'" class="admin-preview"><h2>{{ draft.title }}</h2><p>{{ draft.summary }}</p><MarkdownBody :markdown="draft.markdown" /></article>
        <div v-if="view==='history'" class="admin-history"><p>每次保存前会保留上一版内容。恢复仅替换正文，文档名称、简介及目录设置保持当前值。</p><p v-if="!history.length && !busy">还没有历史版本。</p><div v-for="entry in history" :key="entry.revision" class="history-row"><div><strong>{{ entry.title }}</strong><small>{{ new Date(entry.savedAt).toLocaleString('zh-CN') }}</small></div><button class="button secondary" :disabled="allBusy" @click="inspect(entry)">查看版本</button></div><article v-if="historyPreview" class="history-preview"><div class="editor-heading"><h3>{{ historyPreview.title }}</h3><button class="button primary" :disabled="allBusy" @click="restore">恢复此版本正文</button></div><MarkdownBody :markdown="historyPreview.markdown" /></article></div>
        <div v-if="revision" class="editor-bottom"><a :href="`/api/admin/guides/${draft.id}/export`" download>下载已保存的 Markdown</a><a v-if="!draft.archived" :href="`/guide#${draft.id}`" target="_blank" rel="noopener">查看阅读页 ↗</a></div>
      </section><div v-else class="admin-empty">从左侧选择文档开始编辑；新建文档请前往“目录与文档管理”。</div>
    </div>
    <WebsiteDialog v-if="managementDialog && authenticated" :title="managementDialog.type==='create-directory'?'新建目录':managementDialog.type==='rename-directory'?'重命名目录':managementDialog.type==='create-document'?'新建文档':managementDialog.type==='edit-document'?'文档名称与简介':'移动文档'" :message="managementDialog.type==='move-document'?'选择目标目录，文档会放在该目录的末尾。':managementDialog.type==='create-document'?'创建后进入文档编辑页，继续编写 Markdown 正文。':'保存后立即更新阅读页。文档链接保持不变。'" :confirm-label="managementDialog.type==='create-document'?'创建并编辑正文':'保存'" :confirm-disabled="busy||!managementDialog.value.trim()||(managementDialog.type==='move-document'&&managementDialog.value===managementDialog.groupId)||(managementDialog.type==='create-document'&&!validChapterId(managementDialog.documentId??''))" @cancel="!busy&&(managementDialog=undefined)" @confirm="submitManagementDialog">
      <fieldset v-if="managementDialog.type==='move-document'" class="choice-list" :disabled="busy"><legend class="editor-help">目标目录</legend><label v-for="group in navigationDoc.groups" :key="group.id" class="check-label"><input v-model="managementDialog.value" type="radio" name="destination" :value="group.id" />{{group.title}}</label></fieldset>
      <fieldset v-else class="management-fields" :disabled="busy"><label>{{managementDialog.type.endsWith('-document')?'文档名称':'目录名称'}}<input v-model="managementDialog.value" :maxlength="managementDialog.type.endsWith('-document')?100:60" @keydown.enter.prevent="submitManagementDialog" /></label><label v-if="managementDialog.type==='create-document'">文档标识<input v-model="managementDialog.documentId" maxlength="64" /><small>仅用小写字母、数字与连字符。保存后链接保持不变。</small></label><label v-if="managementDialog.type==='create-document'||managementDialog.type==='edit-document'">文档简介<textarea v-model="managementDialog.summary" maxlength="500" rows="3"></textarea></label></fieldset>
      <p v-if="error" role="alert" class="admin-error">{{error}}</p>
    </WebsiteDialog>
    <WebsiteDialog v-if="syncPreview && authenticated" title="同步到 content？" message="以下已保存的文档、目录和图片将写入源码目录；同名文件会被覆盖，原文件会备份。同步不会执行 Git 提交。" :confirm-label="busy?'正在同步…':'确认同步'" :confirm-disabled="busy" @cancel="!busy&&(syncPreview=undefined)" @confirm="syncContent"><ul class="sync-file-list"><li v-for="file in syncPreview.files" :key="file.path"><span>{{file.action}}</span><code>{{file.path}}</code></li></ul><p v-if="error" role="alert" class="admin-error">{{error}}</p></WebsiteDialog>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation=undefined" @confirm="accept" />
    </div>
  </div>
</template>
<style src="./guide-admin.css"></style>

<style src="./admin-content.css"></style>

<style src="./admin-shell.css"></style>
