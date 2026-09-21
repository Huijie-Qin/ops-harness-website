<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { adminSections, analyticsViews, type AdminSection, type AnalyticsView } from './admin-route'
defineProps<{ section: AdminSection; view: AnalyticsView; busy: boolean }>()
const emit = defineEmits<{ navigate: [section: AdminSection, view?: AnalyticsView]; logout: [] }>()
const mobile = ref(false), open = ref(false), panel = ref<HTMLElement>(), toggle = ref<HTMLButtonElement>()
let media: MediaQueryList | undefined
function close() { (panel.value as HTMLDialogElement | undefined)?.close?.(); open.value = false; toggle.value?.focus() }
async function show() { open.value = true; await nextTick(); (panel.value as HTMLDialogElement).showModal() }
function navigate(event: MouseEvent, section: AdminSection, view?: AnalyticsView) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault(); emit('navigate', section, view); if (mobile.value) close()
}
function resize() { if (open.value) close(); mobile.value = media?.matches ?? false }
onMounted(() => { media = matchMedia('(max-width: 900px)'); resize(); media.addEventListener('change', resize) })
onBeforeUnmount(() => { media?.removeEventListener('change', resize) })
</script>
<template>
  <div class="admin-mobile-bar"><a class="brand" href="/"><img src="/brand.svg" alt="" />终端云工作助手</a><button ref="toggle" class="button secondary" :aria-expanded="open" aria-controls="admin-navigation" @click="show">管理导航</button></div>
  <component :is="mobile ? 'dialog' : 'aside'" id="admin-navigation" ref="panel" class="admin-navigation" aria-label="管理导航" @cancel.prevent="close">
    <a class="admin-nav-brand" href="/"><img src="/brand.svg" alt="" /><span>终端云工作助手<small>管理后台</small></span></a>
    <button v-if="mobile" class="admin-nav-close button secondary" @click="close">关闭导航</button>
    <nav aria-label="管理功能">
      <template v-for="item in adminSections" :key="item.id">
        <a :href="item.id === 'analytics' ? '#analytics/overview' : `#${item.id}`" :class="{active: section === item.id}" :aria-current="section === item.id && item.id !== 'analytics' ? 'page' : undefined" :aria-disabled="busy" @click="busy ? $event.preventDefault() : navigate($event, item.id)"><Icon :name="item.icon" :size="19" /><span>{{ item.label }}</span></a>
        <div v-if="item.id === 'analytics' && section === 'analytics'" class="admin-stat-nav">
          <a v-for="entry in analyticsViews" :key="entry.id" :href="`#analytics/${entry.id}`" :aria-current="view === entry.id ? 'page' : undefined" @click="navigate($event, 'analytics', entry.id)">{{ entry.label }}</a>
        </div>
      </template>
    </nav>
    <div class="admin-nav-bottom"><a href="/"><Icon name="arrow" :size="18" />返回官网</a><div class="admin-account"><Icon name="person" :size="26" /><span>管理员<small>已安全登录</small></span><button :disabled="busy" @click="emit('logout')">退出</button></div></div>
  </component>
</template>
<style scoped>
.admin-navigation{position:fixed;inset:0 auto 0 0;width:224px;height:100dvh;padding:24px 12px 18px;background:#f8f9fd;border:0;border-right:1px solid var(--border-default);display:flex;flex-direction:column;overflow:auto;z-index:12;color:var(--text-primary)}
.admin-nav-brand{display:flex;align-items:flex-start;gap:10px;padding:0 10px 28px;font-size:17px;font-weight:700;white-space:nowrap}.admin-nav-brand img{width:31px;height:31px}.admin-nav-brand small{display:block;color:var(--text-secondary);font-size:12px;font-weight:400;margin-top:5px}.admin-navigation nav{display:grid;gap:5px}.admin-navigation nav>a{display:flex;gap:14px;align-items:center;min-height:46px;padding:10px 14px;font-size:14px;font-weight:550;border-radius:7px}.admin-navigation nav>a.active{color:var(--accent-primary)}.admin-navigation a:hover{background:#f0eefc}.admin-navigation [aria-disabled=true]{opacity:.5;cursor:wait}.admin-stat-nav{display:grid;gap:4px}.admin-stat-nav a{padding:11px 12px 11px 48px;font-size:14px;color:var(--text-secondary);border-radius:7px;position:relative}.admin-stat-nav a[aria-current]{color:var(--accent-primary);background:#eeebff;font-weight:600}.admin-stat-nav a[aria-current]::before{content:'';position:absolute;left:25px;top:18px;width:6px;height:6px;border-radius:50%;background:var(--accent-primary)}.admin-nav-bottom{margin-top:auto;padding:28px 12px 0;display:grid;gap:24px}.admin-nav-bottom>a{display:flex;gap:12px;font-size:14px;color:var(--text-secondary)}.admin-account{display:flex;gap:12px;align-items:center;font-size:14px}.admin-account>svg{color:var(--text-secondary)}.admin-account small{display:block;font-size:11px;color:var(--text-secondary);margin-top:4px}.admin-account button{margin-left:auto;border:0;background:none;color:var(--text-secondary);font-size:12px;padding:8px}.admin-mobile-bar{display:none}.admin-nav-close{margin:0 10px 16px}
@media(max-width:900px){.admin-mobile-bar{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border-default);gap:12px;background:white;position:sticky;top:0;z-index:10}.admin-mobile-bar .brand{font-size:16px}.admin-mobile-bar .brand img{width:27px;height:27px}.admin-mobile-bar .button{min-height:36px;padding:0 12px;font-size:12px}dialog.admin-navigation{inset:0 auto 0 0;margin:0;max-height:100dvh;width:280px;max-width:90vw;border-radius:0}dialog.admin-navigation:not([open]){display:none}dialog.admin-navigation::backdrop{background:#17233f66}.admin-navigation:not(dialog){display:none}}
</style>
