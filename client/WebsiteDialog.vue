<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
defineProps<{title:string; message:string; confirmLabel?:string; confirmDisabled?:boolean}>()
const emit = defineEmits<{confirm:[];cancel:[]}>()
const dialog = ref<HTMLDialogElement>(), cancel = ref<HTMLButtonElement>()
let previous: HTMLElement | null = null
onMounted(() => { previous = document.activeElement as HTMLElement; dialog.value?.showModal(); cancel.value?.focus() })
onBeforeUnmount(() => { dialog.value?.close(); previous?.focus() })
</script>
<template><dialog ref="dialog" class="website-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description" @cancel.prevent="emit('cancel')"><h2 id="dialog-title">{{ title }}</h2><p id="dialog-description">{{ message }}</p><slot /><div><button ref="cancel" class="button secondary" @click="emit('cancel')">取消</button><button class="button primary" :disabled="confirmDisabled" @click="emit('confirm')">{{ confirmLabel ?? '确认' }}</button></div></dialog></template>
<style scoped>.website-dialog{border:1px solid var(--border-default);border-radius:14px;padding:28px;max-height:90dvh;overflow:auto;width:min(700px,calc(100vw - 36px));color:var(--text-primary);box-shadow:0 20px 100px #15264733}.website-dialog::backdrop{background:#18213766}.website-dialog h2{font-size:21px;line-height:1.5}.website-dialog p{font-size:14px;line-height:1.9;color:var(--text-secondary);margin:16px 0 24px}.website-dialog>div{display:flex;justify-content:flex-end;gap:10px}</style>
