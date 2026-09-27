<script setup lang="ts">
import { computed } from 'vue'
import { SCENARIO_ICON_SHAPES, isScenarioIcon, type ScenarioIcon } from '@dsh-ops/expert-distribution-contract/scenarios'

/**
 * A scenario glyph drawn from the contract's shapes, so the editor shows the same icon as the product's home panel
 * and expert cards. Decorative: the text next to it (or the control's label) names it.
 */
const props = defineProps<{ name: ScenarioIcon; size?: number }>()
const shapes = computed(() => SCENARIO_ICON_SHAPES[isScenarioIcon(props.name) ? props.name : 'document'])
</script>

<template>
  <svg class="scenario-icon" :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><component :is="shape[0]" v-for="(shape, index) in shapes" :key="index" v-bind="shape[1]" /></svg>
</template>

<style scoped>
.scenario-icon{flex:none;display:block}
</style>
