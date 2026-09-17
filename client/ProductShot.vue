<script setup lang="ts">
withDefaults(defineProps<{ src: string; alt: string; caption: string; eager?: boolean; width?: number; height?: number }>(), { width: 1470, height: 746 })
</script>
<template>
  <figure class="product-shot">
    <a :href="src" target="_blank" rel="noopener" :aria-label="`${caption}，在新标签页查看原图`"><img :src="src" :alt="alt" :width="width" :height="height" :loading="eager ? 'eager' : 'lazy'" decoding="async" /></a>
    <figcaption><span>{{ caption }}</span><a :href="src" target="_blank" rel="noopener">查看原图<span class="sr-only">（在新标签页打开）</span></a></figcaption>
  </figure>
</template>
<style scoped>
.product-shot{margin:0;min-width:0}.product-shot>a{display:block;border:1px solid var(--border-default);border-radius:12px;overflow:hidden;background:#f6f7fa}.product-shot img{display:block;width:100%;height:auto}.product-shot figcaption{display:flex;justify-content:space-between;gap:16px;padding:14px 2px;font-size:12px;line-height:1.6;color:var(--text-secondary);text-align:left}.product-shot figcaption a{flex-shrink:0;color:var(--accent-primary)}
</style>
