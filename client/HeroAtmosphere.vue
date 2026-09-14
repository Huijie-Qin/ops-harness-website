<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

// Original animation inspired by deepseek.com/harness: light field and rotating point cloud.
// No upstream scripts, remote assets, or animation dependency are loaded.
const canvas = ref<HTMLCanvasElement | null>(null)
const paused = ref(false)
const reducedMotion = ref(false)
let updatePlayback = () => {}
let dispose = () => {}
function toggleMotion() { paused.value = !paused.value; updatePlayback() }

onMounted(() => {
  const element = canvas.value!
  const context = element.getContext('2d')
  if (!context) return // Keep the CSS background when Canvas is unavailable.
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let width = 1, height = 1, frame = 0, elapsed = 0, last = 0, inView = true
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, strength: 0, inside: false }
  const trails: Array<{ x: number; y: number; born: number }> = []
  const surface = element.parentElement!
  const glow = document.createElement('canvas')
  const light = glow.getContext('2d')!
  const points: Array<[number, number, number]> = []
  for (let x = -1; x <= 1.01; x += .1) {
    for (let y = -1; y <= 1.01; y += .1) points.push([x, y, -1], [x, y, 1], [-1, x, y], [1, x, y])
  }
  function draw() {
    if (!context) return
    const t = elapsed / 1000
    const interactive = !paused.value && !reducedMotion.value
    pointer.x += (pointer.targetX - pointer.x) * .14
    pointer.y += (pointer.targetY - pointer.y) * .14
    pointer.strength += ((pointer.inside && interactive ? 1 : 0) - pointer.strength) * .12
    context.clearRect(0, 0, width, height)
    const w = glow.width, h = glow.height
    light.clearRect(0, 0, w, h)
    // Render diffuse light at quarter resolution and composite it once per frame.
    for (let band = 0; band < 4; band++) {
      const x = w * (.15 + band * .26 + Math.sin(t * .14 + band * 2) * .16)
      const y = h * (.3 + Math.cos(t * .19 + band * 1.9) * .24)
      const gradient = light.createRadialGradient(x, y, 0, x, y, w * .43)
      gradient.addColorStop(0, band % 2 ? 'rgba(137,175,230,.3)' : 'rgba(63,113,208,.48)')
      gradient.addColorStop(.45, 'rgba(65,112,191,.13)')
      gradient.addColorStop(1, 'rgba(30,68,135,0)')
      light.fillStyle = gradient
      light.fillRect(0, 0, w, h)
    }
    light.save()
    light.filter = 'blur(14px)'
    light.strokeStyle = 'rgba(200,220,244,.22)'
    light.lineWidth = 17
    light.beginPath()
    for (let x = -20; x <= w + 20; x += 4) {
      const y = h * .36 + Math.sin(x / w * 7 + t * .22) * h * .22 + Math.cos(x / w * 3 - t * .16) * h * .09
      if (x === -20) light.moveTo(x, y)
      else light.lineTo(x, y)
    }
    light.stroke()
    light.restore()
    context.drawImage(glow, 0, 0, width, height)
    if (pointer.strength > .01) {
      const halo = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 230)
      halo.addColorStop(0, `rgba(170,207,255,${pointer.strength * .2})`)
      halo.addColorStop(.35, `rgba(101,159,246,${pointer.strength * .12})`)
      halo.addColorStop(1, 'rgba(95,150,240,0)')
      context.fillStyle = halo; context.fillRect(0, 0, width, height)
    }
    while (trails.length && elapsed - trails[0]!.born > 1500) trails.shift()
    for (const trail of interactive ? trails : []) {
      const age = (elapsed - trail.born) / 1500
      context.save()
      context.strokeStyle = `rgba(192,222,255,${(1 - age) ** 2 * .25})`
      context.lineWidth = 1.5
      context.shadowColor = '#9ecaff'; context.shadowBlur = 12
      context.beginPath(); context.ellipse(trail.x, trail.y, 12 + age * 100, 7 + age * 62, -.25, 0, Math.PI * 2); context.stroke()
      context.restore()
    }
    context.strokeStyle = 'rgba(177,205,248,.035)'
    context.lineWidth = 1
    context.beginPath()
    for (let x = 0; x < width; x += 80) { context.moveTo(x, 0); context.lineTo(x, height) }
    for (let y = 0; y < height; y += 80) { context.moveTo(0, y); context.lineTo(width, y) }
    context.stroke()
    const size = Math.min(width * .25, height * .27, 215)
    const shiftX = (pointer.x / width - .5) * pointer.strength
    const shiftY = (pointer.y / height - .5) * pointer.strength
    const cx = (width < 700 ? width * .77 : width * .76) + shiftX * 24, cy = height * .48 + shiftY * 18
    const ay = t * .075 + .6 + shiftX * .35, ax = -.32 + Math.sin(t * .1) * .12 + shiftY * .2
    for (const [px, py, pz] of points) {
      const x = px * Math.cos(ay) + pz * Math.sin(ay)
      const z0 = -px * Math.sin(ay) + pz * Math.cos(ay)
      const y = py * Math.cos(ax) - z0 * Math.sin(ax), z = py * Math.sin(ax) + z0 * Math.cos(ax)
      const perspective = 3.8 / (3.8 - z)
      const alpha = (.06 + (z + 1.8) * .065) * (width < 700 ? .55 : 1)
      context.fillStyle = `rgba(189,215,255,${alpha})`
      const dot = (1 + perspective) * .9
      let screenX = cx + x * size * perspective, screenY = cy + y * size * perspective
      const dx = screenX - pointer.x, dy = screenY - pointer.y
      const distance = Math.hypot(dx, dy)
      const force = Math.max(0, 1 - distance / 180) ** 2 * 42 * pointer.strength
      if (distance > 0) { screenX += dx / distance * force; screenY += dy / distance * force }
      context.fillRect(screenX, screenY, dot + force / 28, dot + force / 28)
    }
  }
  function tick(now: number) {
    if (last === 0) last = now
    if (now - last >= 1000 / 30) { elapsed += Math.min(now - last, 80); last = now; draw() }
    frame = requestAnimationFrame(tick)
  }
  updatePlayback = () => {
    cancelAnimationFrame(frame)
    last = 0
    if (!paused.value && !reducedMotion.value && !document.hidden && inView) frame = requestAnimationFrame(tick)
    else draw()
  }
  function resize() {
    const rect = element.getBoundingClientRect()
    width = rect.width; height = rect.height
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    element.width = Math.round(width * ratio); element.height = Math.round(height * ratio)
    context!.setTransform(ratio, 0, 0, ratio, 0, 0)
    glow.width = Math.max(1, Math.round(width / 4)); glow.height = Math.max(1, Math.round(height / 4))
    draw()
  }
  function preferenceChanged() { reducedMotion.value = media.matches; updatePlayback() }
  function pointerMoved(event: PointerEvent) {
    if (event.pointerType === 'touch' || paused.value || reducedMotion.value) return
    const rect = element.getBoundingClientRect()
    pointer.targetX = event.clientX - rect.left; pointer.targetY = event.clientY - rect.top
    if (!pointer.inside) { pointer.x = pointer.targetX; pointer.y = pointer.targetY }
    pointer.inside = true
    const previous = trails.at(-1)
    if (!previous || Math.hypot(previous.x - pointer.targetX, previous.y - pointer.targetY) > 22) {
      trails.push({ x: pointer.targetX, y: pointer.targetY, born: elapsed })
      if (trails.length > 24) trails.shift()
    }
  }
  function pointerLeft() { pointer.inside = false }
  const resizer = new ResizeObserver(resize)
  const observer = new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? false; updatePlayback() })
  resizer.observe(element); observer.observe(element)
  document.addEventListener('visibilitychange', updatePlayback)
  media.addEventListener('change', preferenceChanged)
  surface.addEventListener('pointermove', pointerMoved, { passive: true })
  surface.addEventListener('pointerleave', pointerLeft)
  resize(); preferenceChanged()
  dispose = () => {
    cancelAnimationFrame(frame); resizer.disconnect(); observer.disconnect()
    document.removeEventListener('visibilitychange', updatePlayback)
    media.removeEventListener('change', preferenceChanged)
    surface.removeEventListener('pointermove', pointerMoved)
    surface.removeEventListener('pointerleave', pointerLeft)
  }
})
onBeforeUnmount(() => dispose())
</script>

<template>
  <canvas ref="canvas" class="hero-atmosphere" aria-hidden="true"></canvas>
  <button v-if="!reducedMotion" class="motion-control" :aria-pressed="paused" @click="toggleMotion">{{ paused ? '播放背景动效' : '暂停背景动效' }}</button>
</template>
<style scoped>
.hero-atmosphere{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;mask-image:linear-gradient(#000 65%,transparent)}
.motion-control{position:absolute;right:32px;bottom:32px;z-index:2;border:1px solid #ffffff30;border-radius:20px;padding:8px 13px;color:#c4d0e4;background:#101d32b3;font-size:11px}.motion-control:hover{background:#263958}
@media(max-width:640px){.motion-control{right:22px;bottom:23px}}
</style>
