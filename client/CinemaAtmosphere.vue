<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhPause, PhPlay } from '@phosphor-icons/vue'

const props = defineProps<{ suspended: boolean }>()
const canvas = ref<HTMLCanvasElement>()
const paused = ref(false), available = ref(false)
let updatePlayback = () => {}, dispose = () => {}
watch(() => props.suspended, () => updatePlayback())
function toggleMotion() { paused.value = !paused.value; updatePlayback() }

onMounted(() => {
  const element = canvas.value!
  const context = element.getContext('2d')
  if (!context) return
  const surface = element.parentElement!
  const artwork = surface.querySelector<HTMLImageElement>('.cinema-art')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
  let width = 1, height = 1, frame = 0, last = 0, elapsed = 0, inView = true
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, strength: 0, inside: false }
  // Fixed distribution keeps the composition stable across resize and remount.
  let seed = 73
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const particles = Array.from({ length: 170 }, () => ({
    u: random(), v: .12 + random() * .75, depth: random(), phase: random() * Math.PI * 2,
    radius: .45 + random() * .8, opacity: .16 + random() * .28, ox: 0, oy: 0,
  }))
  const smooth = (from: number, to: number, value: number) => {
    const p = Math.min(1, Math.max(0, (value - from) / (to - from)))
    return p * p * (3 - 2 * p)
  }
  function fieldOpacity(x: number, y: number) {
    const top = Math.min(1, Math.max(0, (y / height - .1) / .12))
    const bottom = Math.min(1, Math.max(0, (.91 - y / height) / .09))
    // Keep the light product panel and the headline optically clean.
    const panel = 1 - smooth(.24, .4, x / width) * (1 - smooth(.62, .78, y / height)) * .8
    const copy = 1 - (1 - smooth(.32, .46, x / width)) * smooth(.43, .57, y / height) * .75
    return top * bottom * panel * copy
  }
  function paint(dt = 0) {
    const ctx = context!
    const ease = 1 - Math.exp(-dt / 145), t = elapsed / 1000
    pointer.x += (pointer.tx - pointer.x) * ease
    pointer.y += (pointer.ty - pointer.y) * ease
    pointer.strength += ((pointer.inside ? 1 : 0) - pointer.strength) * ease
    ctx.clearRect(0, 0, width, height)
    const strength = available.value && !props.suspended ? pointer.strength : 0
    if (strength > .005) {
      const radius = Math.min(290, width * .22)
      const halo = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, radius)
      const alpha = strength * .065 * fieldOpacity(pointer.x, pointer.y)
      halo.addColorStop(0, `rgba(166,197,215,${alpha})`)
      halo.addColorStop(.42, `rgba(119,156,185,${alpha * .42})`)
      halo.addColorStop(1, 'rgba(119,156,185,0)')
      ctx.fillStyle = halo
      ctx.fillRect(pointer.x - radius, pointer.y - radius, radius * 2, radius * 2)
    }
    const count = width < 700 ? 38 : Math.min(particles.length, Math.round(width / 8.5))
    for (let i = 0; i < count; i++) {
      const p = particles[i]!
      const x = p.u * width + Math.sin(t * .085 + p.phase) * (9 + p.depth * 11)
      const y = p.v * height + Math.cos(t * .11 + p.phase) * (7 + p.depth * 9)
      const dx = x - pointer.x, dy = y - pointer.y, distance = Math.hypot(dx, dy)
      const influence = Math.max(0, 1 - distance / 185) ** 2 * strength
      const force = influence * (24 + p.depth * 12)
      p.ox += ((dx / Math.max(1, distance)) * force - p.ox) * ease
      p.oy += ((dy / Math.max(1, distance)) * force - p.oy) * ease
      const alpha = (p.opacity + influence * .38) * fieldOpacity(x, y) * (width < 700 ? .45 : 1)
      ctx.fillStyle = `rgba(192,212,223,${alpha})`
      ctx.beginPath(); ctx.arc(x + p.ox, y + p.oy, p.radius, 0, Math.PI * 2); ctx.fill()
    }
    if (artwork) {
      const x = (pointer.x / width - .5) * strength * 9
      const y = (pointer.y / height - .5) * strength * 6
      artwork.style.transform = strength > .001 ? `translate3d(${x}px,${y}px,0) scale(${1 + strength * .008})` : ''
    }
  }
  function tick(now: number) {
    if (!last) last = now
    const dt = now - last
    // 30 fps is enough for slow atmospheric motion; bound work after a stalled frame.
    if (dt >= 1000 / 30) { const step = Math.min(dt, 64); elapsed += step; last = now; paint(step) }
    frame = requestAnimationFrame(tick)
  }
  updatePlayback = () => {
    cancelAnimationFrame(frame); frame = 0; last = 0
    available.value = !reduced.matches && fine.matches && width >= 700
    const running = available.value && !paused.value && !props.suspended && !document.hidden && inView
    element.dataset.motion = running ? 'running' : 'paused'
    if (running) frame = requestAnimationFrame(tick)
    else {
      pointer.inside = false; pointer.strength = 0
      for (const p of particles) { p.ox = 0; p.oy = 0 }
      paint()
    }
  }
  function resize() {
    const rect = element.getBoundingClientRect()
    width = Math.max(1, rect.width); height = Math.max(1, rect.height)
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    element.width = Math.round(width * ratio); element.height = Math.round(height * ratio)
    context!.setTransform(ratio, 0, 0, ratio, 0, 0)
    paint(); updatePlayback()
  }
  function pointerMoved(event: PointerEvent) {
    if (event.pointerType === 'touch' || !available.value || paused.value || props.suspended) return
    const rect = element.getBoundingClientRect()
    pointer.tx = event.clientX - rect.left; pointer.ty = event.clientY - rect.top
    if (!pointer.inside) { pointer.x = pointer.tx; pointer.y = pointer.ty }
    pointer.inside = true
  }
  function pointerLeft() { pointer.inside = false }
  const resizer = new ResizeObserver(resize)
  const observer = new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? false; updatePlayback() })
  resizer.observe(element); observer.observe(element)
  surface.addEventListener('pointermove', pointerMoved, { passive: true })
  surface.addEventListener('pointerleave', pointerLeft)
  document.addEventListener('visibilitychange', updatePlayback)
  reduced.addEventListener('change', updatePlayback); fine.addEventListener('change', updatePlayback)
  resize()
  dispose = () => {
    cancelAnimationFrame(frame); resizer.disconnect(); observer.disconnect()
    surface.removeEventListener('pointermove', pointerMoved); surface.removeEventListener('pointerleave', pointerLeft)
    document.removeEventListener('visibilitychange', updatePlayback)
    reduced.removeEventListener('change', updatePlayback); fine.removeEventListener('change', updatePlayback)
    if (artwork) artwork.style.transform = ''
  }
})
onBeforeUnmount(() => dispose())
</script>

<template>
  <canvas ref="canvas" class="cinema-atmosphere" aria-hidden="true" />
  <button v-if="available" class="cinema-motion" :aria-label="paused ? '播放背景动效' : '暂停背景动效'" :title="paused ? '播放背景动效' : '暂停背景动效'" @click="toggleMotion">
    <PhPlay v-if="paused" :size="14" weight="fill" /><PhPause v-else :size="14" weight="light" />
  </button>
</template>

<style scoped>
.cinema-atmosphere{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}
.cinema-motion{position:absolute;right:4.35vw;bottom:31px;z-index:2;display:grid;place-items:center;width:40px;height:40px;padding:0;border:1px solid #bccbd929;border-radius:50%;color:#aab8c6;background:transparent;transition:border-color .2s,color .2s}
.cinema-motion:hover{color:#f0f1ef;border-color:#bccbd97a}.cinema-motion:focus-visible{outline:2px solid #f0f1ef;outline-offset:4px}
@media(min-width:1700px){.cinema-motion{right:max(64px,calc((100vw - 1600px)/2))}}
@media(prefers-reduced-motion:reduce){.cinema-motion{transition:none}}
</style>
