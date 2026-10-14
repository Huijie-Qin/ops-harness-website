<script setup lang="ts">
import { computed } from 'vue'
import { getReleaseType } from '@dsh-ops/release-contract'
import { releaseTypeLabel } from './release-display'

const props = defineProps<{ version: string }>()
const type = computed(() => getReleaseType(props.version))
</script>

<template><span class="release-type-badge" :data-release-type="type">{{ releaseTypeLabel(version) }}</span></template>

<style scoped>
.release-type-badge{display:inline-flex;align-items:center;justify-content:center;max-width:100%;padding:4px 9px;border:1px solid var(--border-default);border-radius:6px;font-size:11px;font-weight:500;line-height:1.5;white-space:nowrap;color:var(--text-secondary);background:var(--bg-primary)}
.release-type-badge[data-release-type=beta],.release-type-badge[data-release-type=rc]{color:var(--accent-primary);background:#f5f4ff;border-color:#dedbfc}
</style>
