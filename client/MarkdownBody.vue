<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '../shared/markdown'
const props = defineProps<{ markdown: string }>()
const html = computed(() => renderMarkdown(props.markdown))
const notice = ref('')
async function copy(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.markdown-copy')) return
  const text = target.closest('.code-container')?.querySelector('code')?.textContent
  if (!text) return
  try { await navigator.clipboard.writeText(text); notice.value = '示例已复制。' }
  catch { notice.value = '无法自动复制，请选中示例内容复制。' }
}
</script>
<template><div class="markdown-body" @click="copy" v-html="html"></div><p v-if="notice" class="markdown-notice" role="status">{{ notice }}</p></template>
<style>
.markdown-body{font-size:14px;line-height:1.95;color:var(--text-secondary);overflow-wrap:anywhere}.markdown-body>*:first-child{margin-top:0}.markdown-body h1,.markdown-body h2,.markdown-body h3{color:var(--text-primary);line-height:1.6;letter-spacing:-.02em;margin:32px 0 12px}.markdown-body h1{font-size:28px}.markdown-body h2{font-size:21px}.markdown-body h3{font-size:17px}.markdown-body p{margin:0 0 18px}.markdown-body a{color:var(--accent-primary);text-decoration:underline;text-underline-offset:3px}.markdown-body strong{color:var(--text-primary)}.markdown-body ul,.markdown-body ol{padding-left:24px;margin:16px 0}.markdown-body li{margin:7px 0}.markdown-body img{display:block;width:100%;height:auto;border:1px solid var(--border-default);border-radius:10px}.markdown-body blockquote{margin:25px 0;padding:17px 22px;border-left:3px solid var(--accent-primary);background:#f6f5fd;border-radius:0 8px 8px 0}.markdown-body blockquote p:last-child{margin-bottom:0}.markdown-body code{font-size:.92em;background:#f1f2f7;padding:2px 5px;border-radius:4px}.markdown-body pre{padding:22px;margin:0;overflow-x:auto;background:#f5f6fc;white-space:pre-wrap;overflow-wrap:anywhere}.markdown-body pre code{padding:0;background:none}.markdown-body .code-container{border:1px solid var(--border-default);border-radius:9px;overflow:hidden;margin:22px 0}.markdown-copy{display:block;margin:8px 10px 8px auto;padding:5px 10px;border:1px solid var(--border-default);border-radius:5px;background:white;color:var(--accent-primary);font-size:11px}.markdown-body table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:20px 0}.markdown-body th,.markdown-body td{border:1px solid var(--border-default);padding:10px 13px;text-align:left}.markdown-body th{background:#f6f7fb;color:var(--text-primary)}.markdown-notice{font-size:12px;color:var(--accent-primary)}
@media(max-width:700px){.markdown-body{font-size:13px}.markdown-body h2{font-size:18px}.markdown-body pre{padding:16px}}
</style>
