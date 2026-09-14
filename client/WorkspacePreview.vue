<script setup lang="ts">
import { nextTick, ref } from 'vue'
import Icon from './Icon.vue'
import ProductShot from './ProductShot.vue'

const screens = [
  { id: 'tools', title: '工具市场', icon: 'tool', caption: '工具市场 · 选择工具，查看配置与添加状态', alt: '办公助手实际运行的工具市场，展示工具分类、目录及工具详情', src: '/assets/product/tools.jpg' },
  { id: 'skills', title: '我的技能', icon: 'spark', caption: '我的技能 · 查看与管理已经安装的工作方法', alt: '办公助手实际运行的我的技能页面，展示已安装技能及管理入口', src: '/assets/product/skills.jpg' },
  { id: 'experts', title: '我的专家', icon: 'person', caption: '我的专家 · 从默认专家开始，组合自己的工作能力', alt: '办公助手实际运行的我的专家页面，展示默认专家和创建入口', src: '/assets/product/experts.jpg' },
]
const selected = ref(0)
async function navigate(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  selected.value = event.key === 'Home' ? 0 : event.key === 'End' ? screens.length - 1 : (selected.value + (event.key === 'ArrowRight' ? 1 : -1) + screens.length) % screens.length
  await nextTick()
  document.getElementById(`showcase-${screens[selected.value]!.id}`)?.focus()
}
</script>
<template>
  <div class="product-showcase">
    <div class="showcase-tabs" role="tablist" aria-label="查看产品实拍" @keydown="navigate">
      <button v-for="(screen, index) in screens" :id="`showcase-${screen.id}`" :key="screen.id" role="tab" :aria-selected="selected === index" :tabindex="selected === index ? 0 : -1" aria-controls="showcase-panel" @click="selected = index"><Icon :name="screen.icon" :size="17" />{{ screen.title }}</button>
    </div>
    <div id="showcase-panel" role="tabpanel" :aria-labelledby="`showcase-${screens[selected]!.id}`" tabindex="0">
      <ProductShot :key="screens[selected]!.id" :src="screens[selected]!.src" :alt="screens[selected]!.alt" :caption="screens[selected]!.caption" eager />
    </div>
    <p class="capture-note">本项目 Web 版实际界面 · 页面中的能力状态以实际配置为准</p>
  </div>
</template>
<style scoped>
.product-showcase{max-width:1120px;margin:auto}.showcase-tabs{display:flex;justify-content:center;gap:8px;margin-bottom:24px}.showcase-tabs button{display:flex;align-items:center;gap:8px;min-height:42px;border:1px solid transparent;padding:0 19px;border-radius:24px;background:transparent;color:var(--text-secondary);font-size:13px}.showcase-tabs button[aria-selected=true]{background:#eeedff;border-color:#dfdcfa;color:var(--accent-primary)}.showcase-tabs button:hover{background:#f1f2f8}.capture-note{text-align:center;font-size:11px;color:var(--text-tertiary);margin:0}.product-showcase :deep(.product-shot>a){box-shadow:0 25px 70px -25px #1d29452b}
@media(max-width:640px){.showcase-tabs{gap:2px}.showcase-tabs button{padding:0 12px;font-size:12px}.showcase-tabs button svg{width:15px}}
</style>
