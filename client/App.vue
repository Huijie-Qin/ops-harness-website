<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import HomeChapters from './HomeChapters.vue'
import CinemaHero from './CinemaHero.vue'
import './home-download.css'
import { PhArrowUpRight } from '@phosphor-icons/vue'
import ReleaseTypeBadge from './ReleaseTypeBadge.vue'
import { getReleaseType } from '@dsh-ops/release-contract'
const GuidePage = defineAsyncComponent(() => import('./GuidePage.vue'))
const GuideAdmin = defineAsyncComponent(() => import('./GuideAdmin.vue'))
import development from '../content/development.json'

type Download = { name: string; size: number; sha512: string; platform: 'windows-x64' | 'macos-arm64'; url: string }
type Release = { version: string; title: string; notes: string[]; publishedAt: string; downloads: Download[] }
const page = window.location.pathname === '/admin' ? 'admin' : window.location.pathname === '/guide' ? 'guide' : window.location.pathname === '/releases' ? 'releases' : 'home'
function skipAdmin(event:MouseEvent){if(page==='admin'){event.preventDefault();document.getElementById('main')?.focus()}}
const menuOpen = ref(false)
const menuToggle = ref<HTMLButtonElement | null>(null)
const closeMenuOnEscape = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && menuOpen.value) { menuOpen.value = false; menuToggle.value?.focus() }
}
const releases = ref<Release[]>([])
const loading = ref(true)
const error = ref(false)
let controller: AbortController | undefined
const latest = computed(() => releases.value.find(r => getReleaseType(r.version) === 'stable'))
const downloadPlatforms = [{ key: 'windows-x64', name: 'Windows', detail: 'Windows 10 / 11 · x64', icon: 'windows', extension: '.exe', label: '下载安装包' }, { key: 'macos-arm64', name: 'macOS', detail: 'Apple Silicon · M 系列芯片', icon: 'laptop', extension: '.dmg', label: '下载 DMG' }] as const
function downloadFor(platform: string, extension: string) {
  for (const release of releases.value) {
    if (getReleaseType(release.version) !== 'stable') continue
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
  document.title = `${page === 'admin' ? '官网管理' : page === 'guide' ? '使用指南' : page === 'releases' ? '更新说明' : '让想法成为完成的工作'} · 终端云工作助手`
  if (page === 'home' || page === 'releases') void refresh()
})
onBeforeUnmount(() => { controller?.abort(); controller = undefined; document.removeEventListener('keydown', closeMenuOnEscape) })
</script>

<template>
  <a class="skip-link" href="#main" @click="skipAdmin">跳到正文</a>
  <header v-if="page !== 'admin'" class="site-header" :class="{ 'home-header': page === 'home' }"><div class="header-inner"><a class="brand" href="/" aria-label="终端云工作助手 首页"><img src="/brand.svg" alt="" /><span>终端云工作助手</span></a><button ref="menuToggle" class="menu-toggle" :aria-expanded="menuOpen" aria-controls="site-nav" @click="menuOpen = !menuOpen">{{ menuOpen ? '关闭菜单' : '菜单' }}</button><nav id="site-nav" :class="{ open: menuOpen }" aria-label="主导航"><a href="/" :aria-current="page === 'home' ? 'page' : undefined">产品介绍</a><a href="/guide" :aria-current="page === 'guide' ? 'page' : undefined">使用指南</a><a href="/releases" :aria-current="page === 'releases' ? 'page' : undefined">更新说明</a><a v-if="page === 'home'" class="cinema-download" href="/#download">下载桌面版<PhArrowUpRight :size="17" weight="light" /></a><a v-else class="button small primary" href="/#download"><Icon name="download" :size="16" />下载桌面版</a></nav></div></header>
  <main id="main" tabindex="-1">
    <template v-if="page === 'home'">
      <CinemaHero />
      <HomeChapters />
      <section id="download" class="download-section home-download" aria-labelledby="download-title">
        <div class="container">
          <span class="eyebrow text-only">准备好开始了吗</span>
          <h2 id="download-title">把工作助手，带到你的桌面。</h2>
          <p class="section-subtitle">{{ latest ? `最新稳定版 v${latest.version} · ${date(latest.publishedAt)}` : '支持 Windows x64 与 macOS Apple Silicon' }}</p>
          <div v-if="error" class="notice" role="alert">
            <span>暂时无法获取安装包信息。</span>
            <button class="text-button" @click="refresh">重新加载</button>
          </div>
          <p v-else-if="loading" class="loading-text" role="status">正在获取版本信息…</p>
          <div class="download-grid">
            <article v-for="platform in downloadPlatforms" :key="platform.key" class="download-card">
              <Icon :name="platform.icon" :size="34" />
              <h3>{{ platform.name }}</h3>
              <p>{{ platform.detail }}</p>
              <a v-if="downloadFor(platform.key, platform.extension)" class="button primary" :href="downloadFor(platform.key, platform.extension)!.url">
                <Icon name="download" :size="17" />{{ platform.label }}
              </a>
              <span v-else class="button disabled" aria-disabled="true">{{ loading ? '正在获取…' : '安装包准备中' }}</span>
              <small v-if="downloadFor(platform.key, platform.extension)">{{ size(downloadFor(platform.key, platform.extension)!.size) }} · v{{ downloadFor(platform.key, platform.extension)!.version }}</small>
              <small v-else>发布后将在这里提供下载</small>
              <a v-if="platform.key === 'windows-x64' && downloadFor(platform.key, '.zip')" class="text-link portable" :href="downloadFor(platform.key, '.zip')!.url">下载免安装 ZIP</a>
            </article>
          </div>
          <a class="text-link release-link" href="/releases">查看更新说明<Icon name="arrow" :size="18" /></a>
        </div>
      </section>
    </template>
    <GuidePage v-else-if="page === 'guide'" />
    <GuideAdmin v-else-if="page === 'admin'" />
    <template v-else>
      <section class="page-heading container"><span class="eyebrow text-only">更新说明</span><h1>每次更新，<br />让工作更进一步。</h1><p>了解新增能力、体验改进，以及当前可下载的版本。</p><p class="release-channel-note">应用默认接收正式版。可在桌面应用的“设置 → 帮助”开启测试版更新，接收 Beta / RC；其他预览版本仅供手动下载。</p></section><section class="release-list container"><div v-if="error" class="notice" role="alert">更新记录暂时无法加载。<button class="text-button" @click="refresh">重试</button></div><p v-else-if="loading" role="status">正在加载更新记录…</p><article v-for="release in releases" :id="`v${release.version}`" :key="release.version" class="release-entry"><div class="release-meta"><span class="version-tag">v{{ release.version }}</span><time :datetime="release.publishedAt">{{ date(release.publishedAt) }}</time><ReleaseTypeBadge :version="release.version" /></div><div><h2>{{ release.title }}</h2><ul><li v-for="note in release.notes" :key="note">{{ note }}</li></ul><div class="release-downloads"><a v-for="download in release.downloads" :key="download.name" :href="download.url" class="text-link"><Icon name="download" :size="16" />{{ download.platform === 'windows-x64' ? 'Windows' : 'macOS' }} · {{ download.name.split('.').at(-1)!.toUpperCase() }}<span>{{ size(download.size) }}</span></a></div></div></article><article v-if="!loading && !releases.length" class="release-entry development-entry"><div class="release-meta"><span class="version-tag muted">开发中</span><span class="release-channel">尚未发布安装包</span></div><div><h2>{{ development.title }}</h2><ul><li v-for="note in development.notes" :key="note">{{ note }}</li></ul><p class="muted-note">以下为当前开发内容。正式版本及下载链接将在完成发布后显示。</p></div></article></section>
    </template>
  </main>
  <footer v-if="page !== 'admin'" class="site-footer container" :class="{ 'home-footer': page === 'home' }"><a class="brand" href="/"><img src="/brand.svg" alt="" /><span>终端云工作助手</span></a><p>为日常工作而生。</p><div><a href="/guide">使用指南</a><a href="/releases">更新说明</a><span>© {{ new Date().getFullYear() }} 终端云工作助手</span></div></footer>
</template>
