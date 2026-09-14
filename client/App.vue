<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import WorkspacePreview from './WorkspacePreview.vue'
import HeroAtmosphere from './HeroAtmosphere.vue'
const GuidePage = defineAsyncComponent(() => import('./GuidePage.vue'))
const GuideAdmin = defineAsyncComponent(() => import('./GuideAdmin.vue'))
import development from '../content/development.json'

type Download = { name: string; size: number; sha512: string; platform: 'windows-x64' | 'macos-arm64'; url: string }
type Release = { version: string; title: string; notes: string[]; publishedAt: string; downloads: Download[] }
const page = window.location.pathname === '/admin' ? 'admin' : window.location.pathname === '/guide' ? 'guide' : window.location.pathname === '/releases' ? 'releases' : 'home'
const menuOpen = ref(false)
const menuToggle = ref<HTMLButtonElement | null>(null)
const closeMenuOnEscape = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && menuOpen.value) { menuOpen.value = false; menuToggle.value?.focus() }
}
const releases = ref<Release[]>([])
const loading = ref(true)
const error = ref(false)
let controller: AbortController | undefined
const latest = computed(() => releases.value.find(r => !r.version.includes('-')))
const downloadPlatforms = [{ key: 'windows-x64', name: 'Windows', detail: 'Windows 10 / 11 · x64', icon: 'windows', extension: '.exe', label: '下载安装包' }, { key: 'macos-arm64', name: 'macOS', detail: 'Apple Silicon · M 系列芯片', icon: 'laptop', extension: '.dmg', label: '下载 DMG' }] as const
function downloadFor(platform: string, extension: string) {
  for (const release of releases.value) {
    if (release.version.includes('-')) continue
    const download = release.downloads.find(d => d.platform === platform && d.name.endsWith(extension))
    if (download) return { ...download, version: release.version }
  }
}
function size(bytes: number) { return `${Math.round(bytes / 1024 ** 2)} MB` }
function date(value: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date(value)) }
async function refresh() {
  controller?.abort()
  controller = new AbortController()
  const active = controller
  const timeout = setTimeout(() => active.abort(), 8000)
  loading.value = true
  error.value = false
  try {
    const response = await fetch('/api/releases', { signal: active.signal })
    if (!response.ok) throw new Error('Unavailable')
    const data = await response.json()
    if (data.schemaVersion !== 1 || !Array.isArray(data.releases)) throw new Error('Invalid response')
    if (controller === active) releases.value = data.releases
  } catch { if (controller === active) error.value = true } finally { clearTimeout(timeout); if (controller === active) loading.value = false }
}
onMounted(() => {
  document.addEventListener('keydown', closeMenuOnEscape)
  document.title = `${page === 'admin' ? '官网管理' : page === 'guide' ? '使用指南' : page === 'releases' ? '更新说明' : '让想法成为完成的工作'} · 办公助手`
  if (page === 'home' || page === 'releases') void refresh()
})
onBeforeUnmount(() => { controller?.abort(); controller = undefined; document.removeEventListener('keydown', closeMenuOnEscape) })
const features = [
  { icon: 'spark', title: '把经验变成技能', description: '从技能市场安装工作方法。写简报、整理资料、分析问题，每次开始都有积累。', tag: 'SKILL 市场' },
  { icon: 'book', title: '让知识随时可用', description: '将本地资料加入知识中心，在对话中检索与引用，让回答连接你的工作上下文。', tag: '知识中心' },
  { icon: 'tool', title: '让工具参与执行', description: '按需添加浏览器和自定义工具，从获取信息到完成操作，在同一个工作流中推进。', tag: '工具市场' },
  { icon: 'person', title: '配置你的专业助手', description: '为不同工作创建专家，组合职责、技能、知识与工具，开启各自专注的会话。', tag: '我的专家' },
]
</script>

<template>
  <a class="skip-link" href="#main">跳到正文</a>
  <header class="site-header" :class="{ 'home-header': page === 'home' }"><div class="header-inner"><a class="brand" href="/" aria-label="办公助手 首页"><img src="/brand.svg" alt="" /><span>办公助手</span></a><button ref="menuToggle" class="menu-toggle" :aria-expanded="menuOpen" aria-controls="site-nav" @click="menuOpen = !menuOpen">{{ menuOpen ? '关闭菜单' : '菜单' }}</button><nav id="site-nav" :class="{ open: menuOpen }" aria-label="主导航"><a href="/" :aria-current="page === 'home' ? 'page' : undefined">产品介绍</a><a href="/guide" :aria-current="page === 'guide' ? 'page' : undefined">使用指南</a><a href="/releases" :aria-current="page === 'releases' ? 'page' : undefined">更新说明</a><a class="button small primary" href="/#download"><Icon name="download" :size="16" />下载桌面版</a></nav></div></header>
  <main id="main">
    <template v-if="page === 'home'">
      <section class="hero-stage">
        <HeroAtmosphere />
        <div class="hero container">
          <div class="eyebrow"><span class="live-dot"></span>让每一份工作，都有好方法</div>
          <h1>让想法，成为<br /><span>完成的工作。</span></h1>
          <p class="hero-description">把技能、知识与工具带到同一个工作空间。<br />从整理资料到创作交付，办公助手与你一起推进。</p>
          <div class="hero-actions"><a class="button primary" href="#download"><Icon name="download" :size="19" />下载桌面版</a><a class="button secondary" href="/guide">开始使用<Icon name="arrow" :size="18" /></a></div>
          <p class="hero-footnote">Windows · macOS Apple Silicon <span>本地工作空间</span></p>
          <a class="hero-explore" href="#product">探索工作空间<Icon name="arrow" :size="16" /></a>
        </div>
      </section>
      <section id="product" class="product-section container">
        <div class="section-intro"><span class="eyebrow text-only">在真实的工作空间里</span><h2>工作所需，触手可及。</h2><p>安装技能、连接工具、配置专家。每一步，都在同一个应用中。</p></div>
        <WorkspacePreview />
      </section>
      <section class="features-section container"><div class="section-intro"><span class="eyebrow text-only">一个工作空间，多种工作方式</span><h2>你的知识与能力，<br />在这里协同。</h2><p>用熟悉的对话开始，让每一步都有工具和上下文支持。</p></div><div class="feature-grid"><article v-for="feature in features" :key="feature.title" class="feature"><span class="feature-icon"><Icon :name="feature.icon" :size="25" /></span><span class="feature-tag">{{ feature.tag }}</span><h3>{{ feature.title }}</h3><p>{{ feature.description }}</p></article></div></section>
      <section class="local-section container"><div class="local-visual"><Icon name="shield" :size="55" /><div class="local-file"><Icon name="book" /><span>你的资料与会话</span><Icon name="check" :size="18" /></div><div class="local-file"><Icon name="grid" /><span>你的工作空间</span><Icon name="check" :size="18" /></div><span class="local-caption">保存在你的电脑上</span></div><div><span class="eyebrow text-only">从容开始，持续积累</span><h2>安装即可打开，<br />工作留在本地。</h2><p>应用自动准备工作环境，配置模型后即可开始。会话、配置和工作资料独立于安装目录，应用升级时继续保留。</p><p class="muted-note">使用在线模型和外部工具时，相关内容会发送到你配置的服务。</p><a class="text-link" href="/guide">了解如何开始<Icon name="arrow" :size="18" /></a></div></section>
      <section id="download" class="download-section"><div class="container"><span class="eyebrow text-only">准备好开始了吗</span><h2>为你的电脑，选择办公助手。</h2><p class="section-subtitle">{{ latest ? `最新稳定版 v${latest.version} · ${date(latest.publishedAt)}` : '支持 Windows x64 与 macOS Apple Silicon' }}</p><div v-if="error" class="notice" role="alert">暂时无法获取安装包信息。<button class="text-button" @click="refresh">重新加载</button></div><p v-else-if="loading" class="loading-text" role="status">正在获取版本信息…</p><div class="download-grid"><article v-for="platform in downloadPlatforms" :key="platform.key" class="download-card"><Icon :name="platform.icon" :size="30" /><h3>{{ platform.name }}</h3><p>{{ platform.detail }}</p><a v-if="downloadFor(platform.key, platform.extension)" class="button primary" :href="downloadFor(platform.key, platform.extension)!.url"><Icon name="download" :size="17" />{{ platform.label }}</a><span v-else class="button disabled" aria-disabled="true">{{ loading ? '正在获取…' : '安装包准备中' }}</span><small v-if="downloadFor(platform.key, platform.extension)">{{ size(downloadFor(platform.key, platform.extension)!.size) }} · v{{ downloadFor(platform.key, platform.extension)!.version }}</small><small v-else>发布后将在这里提供下载</small><a v-if="platform.key === 'windows-x64' && downloadFor(platform.key, '.zip')" class="text-link portable" :href="downloadFor(platform.key, '.zip')!.url">下载免安装 ZIP</a></article></div><a class="text-link release-link" href="/releases">查看更新说明<Icon name="arrow" :size="18" /></a></div></section>
    </template>
    <GuidePage v-else-if="page === 'guide'" />
    <GuideAdmin v-else-if="page === 'admin'" />
    <template v-else>
      <section class="page-heading container"><span class="eyebrow text-only">更新说明</span><h1>每次更新，<br />让工作更进一步。</h1><p>了解新增能力、体验改进，以及当前可下载的版本。</p></section><section class="release-list container"><div v-if="error" class="notice" role="alert">更新记录暂时无法加载。<button class="text-button" @click="refresh">重试</button></div><p v-else-if="loading" role="status">正在加载更新记录…</p><article v-for="release in releases" :id="`v${release.version}`" :key="release.version" class="release-entry"><div class="release-meta"><span class="version-tag">v{{ release.version }}</span><time :datetime="release.publishedAt">{{ date(release.publishedAt) }}</time><span class="release-channel">{{ release.version.includes('-') ? '预览版' : '正式版' }}</span></div><div><h2>{{ release.title }}</h2><ul><li v-for="note in release.notes" :key="note">{{ note }}</li></ul><div class="release-downloads"><a v-for="download in release.downloads" :key="download.name" :href="download.url" class="text-link"><Icon name="download" :size="16" />{{ download.platform === 'windows-x64' ? 'Windows' : 'macOS' }} · {{ download.name.split('.').at(-1)!.toUpperCase() }}<span>{{ size(download.size) }}</span></a></div></div></article><article v-if="!loading && !releases.length" class="release-entry development-entry"><div class="release-meta"><span class="version-tag muted">开发中</span><span class="release-channel">尚未发布安装包</span></div><div><h2>{{ development.title }}</h2><ul><li v-for="note in development.notes" :key="note">{{ note }}</li></ul><p class="muted-note">以下为当前开发内容。正式版本及下载链接将在完成发布后显示。</p></div></article></section>
    </template>
  </main>
  <footer class="site-footer container"><a class="brand" href="/"><img src="/brand.svg" alt="" /><span>办公助手</span></a><p>为日常工作而生。</p><div><a href="/guide">使用指南</a><a href="/releases">更新说明</a><span>© {{ new Date().getFullYear() }} 办公助手</span></div></footer>
</template>
