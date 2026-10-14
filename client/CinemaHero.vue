<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PhPlay, PhArrowDown, PhArrowUpRight } from '@phosphor-icons/vue'
import VideoDialog from './VideoDialog.vue'
import CinemaAtmosphere from './CinemaAtmosphere.vue'
import type { VideoEntry } from '../shared/videos'
const featured = ref<VideoEntry>(), filmOpen = ref(false), pending = ref(true), failed = ref(false)
let controller: AbortController | undefined
const duration = computed(() => { const seconds = Math.round(featured.value?.durationSeconds ?? 0); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}` })
async function loadFilm() {
  controller?.abort(); const request = new AbortController(); controller = request
  const timer = setTimeout(() => request.abort(), 10000); pending.value = true; failed.value = false
  try {
    const response = await fetch('/api/videos', { signal: request.signal })
    if (!response.ok) throw new Error('Unavailable')
    const data = await response.json()
    if (data.schemaVersion !== 1 || !Array.isArray(data.items)) throw new Error('Invalid response')
    if (controller === request) featured.value = data.items.find((item: VideoEntry) => item.featured && item.status === 'published' && item.video)
  } catch { if (controller === request) failed.value = true }
  finally { clearTimeout(timer); if (controller === request) pending.value = false }
}
onMounted(loadFilm)
onBeforeUnmount(() => { controller?.abort(); controller = undefined })
const chapters = ['生产系统对接', '技能市场与分发', '模型资源池', '办公协同']
</script>
<template>
  <section class="cinema-hero" aria-labelledby="cinema-title">
    <img class="cinema-art" src="/assets/product/cinema-hero.webp" alt="" width="1487" height="1058" fetchpriority="high" />
    <CinemaAtmosphere :suspended="filmOpen" />
    <div class="cinema-copy"><p class="cinema-kicker">终端云工作助手 <span>/</span> 产品影片</p><h1 id="cinema-title">让想法，成为<br />完成的工作。</h1>
      <button v-if="featured?.video" class="cinema-play" aria-haspopup="dialog" @click="filmOpen = true"><span class="cinema-play-icon"><PhPlay :size="25" weight="fill" /></span><span>观看产品影片</span><span class="cinema-duration">{{ duration }}</span></button>
      <p v-else-if="pending" class="cinema-pending" role="status">正在准备影片…</p>
      <div v-else-if="failed" class="cinema-unavailable"><span>影片暂时无法加载。</span><button @click="loadFilm">重试</button></div>
      <a v-else class="cinema-guide" href="/guide">开始使用工作助手<PhArrowUpRight :size="20" /></a>
    </div>
    <p class="cinema-statement">连接真实业务。<br />让工作，向前一步。</p>
    <div class="cinema-bottom"><ol aria-label="工作助手能力概览"><li v-for="(chapter, index) in chapters" :key="chapter"><span>{{ String(index + 1).padStart(2, '0') }}</span>{{ chapter }}</li></ol><a href="#product" aria-label="探索工作空间"><PhArrowDown :size="24" weight="light" /></a></div>
    <VideoDialog v-if="filmOpen && featured?.video" :title="featured.title" :src="featured.video.url" :poster="featured.coverUrl" :description="featured.description" @close="filmOpen = false" />
  </section>
</template>
