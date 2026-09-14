<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  download: 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4',
  check: 'm5 12 4 4L19 6',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  book: 'M12 5v15M3 4h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z',
  tool: 'M14 5a5 5 0 0 0-6 6L3 16a3 3 0 0 0 5 5l5-5a5 5 0 0 0 6-6l-4 4-4-4Z',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  shield: 'm12 3 8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6Zm-4 9 3 3 5-5',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  grid: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  windows: 'M3 5 10 4v7H3Zm10-1 8-1v8h-8ZM3 13h7v7l-7-1Zm10 0h8v8l-8-1Z',
  laptop: 'M5 4h14v12H5ZM3 20h18l-2-4H5Z',
  chevron: 'm9 5 7 7-7 7',
}
</script>
<template><svg :width="size || 22" :height="size || 22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.spark" /></svg></template>
