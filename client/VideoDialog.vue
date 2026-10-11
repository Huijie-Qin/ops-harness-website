<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { PhX, PhArrowClockwise } from '@phosphor-icons/vue'
defineProps<{ title: string; src: string; poster?: string; description?: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>(), player = ref<HTMLVideoElement>(), closeButton = ref<HTMLButtonElement>()
const loading = ref(true), failed = ref(false)
let previous: HTMLElement | null = null, previousOverflow = ''
function play() { void player.value?.play().catch(() => { loading.value = false }) }
function retry() { failed.value = false; loading.value = true; player.value?.load(); play() }
function backdrop(event: MouseEvent) {
  if (event.target !== dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('close')
}
onMounted(() => {
  previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'
  dialog.value?.showModal(); closeButton.value?.focus({ preventScroll: true }); play()
})
onBeforeUnmount(() => {
  if (player.value) { player.value.pause(); player.value.removeAttribute('src'); player.value.load() }
  dialog.value?.close(); document.body.style.overflow = previousOverflow
  if (previous?.isConnected) previous.focus({ preventScroll: true })
})
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="film-dialog" aria-labelledby="film-title" @cancel.prevent="emit('close')" @click="backdrop">
    <header class="film-dialog-heading"><div><p>终端云工作助手 / 产品影片</p><h2 id="film-title">{{ title }}</h2></div><button ref="closeButton" class="film-close" aria-label="关闭影片" @click="emit('close')"><PhX :size="24" weight="light" /></button></header>
    <div class="film-player"><video ref="player" :src="src" :poster="poster || undefined" :aria-label="title" controls autoplay playsinline preload="metadata" @loadeddata="loading = false" @canplay="loading = false" @playing="loading = false" @waiting="loading = true" @error="failed = true; loading = false" />
      <p v-if="loading && !failed" class="film-loading" role="status">正在加载影片…</p>
      <div v-if="failed" class="film-error" role="alert"><p>影片暂时无法播放，请重试。</p><button @click="retry"><PhArrowClockwise :size="18" />重新加载</button></div>
    </div>
    <footer class="film-dialog-footer"><p>{{ description || '让想法，成为完成的工作。' }}</p><span>按 Esc 关闭</span></footer>
  </dialog></Teleport>
</template>
<style scoped>
.film-dialog{position:fixed;inset:0;margin:auto;padding:0;width:min(1120px,calc(100vw - 80px));max-width:none;max-height:calc(100dvh - 64px);overflow:auto;background:#0c121b;color:#edf0f4;border:1px solid #ffffff1c;border-radius:12px;box-shadow:0 24px 100px #0009;animation:film-enter .25s ease-out}.film-dialog::backdrop{background:#02060ddb;backdrop-filter:blur(12px)}
.film-dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:22px 28px}.film-dialog-heading p{color:#8f9aa9;font-size:11px;letter-spacing:.12em;margin:0 0 7px}.film-dialog-heading h2{font-size:18px;line-height:1.45;letter-spacing:0;font-weight:500;margin:0}.film-close{width:44px;height:44px;display:grid;place-items:center;background:transparent;color:#b8c1cd;border:1px solid transparent;border-radius:50%;flex-shrink:0}.film-close:hover{background:#ffffff0d;color:white}.film-close:focus-visible{outline:2px solid white;outline-offset:3px}
.film-player{position:relative;background:#000;aspect-ratio:16/9;max-height:calc(100dvh - 250px);min-height:160px}.film-player video{display:block;width:100%;height:100%;object-fit:contain}.film-loading{position:absolute;inset:45% 0 auto;margin:0;text-align:center;color:white;pointer-events:none;font-size:14px;text-shadow:0 1px 8px black}.film-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#080e17}.film-error p{font-size:15px;margin-bottom:16px}.film-error button{display:flex;align-items:center;gap:8px;padding:10px 18px;border:1px solid #ffffff50;border-radius:6px;color:#fff;background:transparent}
.film-dialog-footer{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px 28px;color:#a2adbd;font-size:12px}.film-dialog-footer p{margin:0;max-width:70ch}.film-dialog-footer span{white-space:nowrap;color:#737e8f}
@keyframes film-enter{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@media(max-width:640px){.film-dialog{width:calc(100vw - 24px);max-height:calc(100dvh - 24px);border-radius:9px}.film-dialog-heading{padding:16px;gap:12px}.film-dialog-heading h2{font-size:16px}.film-dialog-heading p{font-size:9px}.film-dialog-footer{padding:14px 16px}.film-dialog-footer span{display:none}.film-player{min-height:0;max-height:calc(100dvh - 190px)}}
@media(prefers-reduced-motion:reduce){.film-dialog{animation:none}}
</style>
