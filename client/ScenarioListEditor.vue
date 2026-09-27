<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRaw, useId, watch } from 'vue'
import {
  SCENARIO_ICONS, SCENARIO_ICON_LABELS, SCENARIO_LIMITS, SCENARIO_MODE_IDS, SCENARIO_MODE_LABELS, canonicalScenario, countScenarioPlaceholders,
  isScenarioIcon, newScenarioId, scenarioIconFor, scenarioIssues, scenarioTextLength, type ExpertScenario, type ScenarioIcon, type ScenarioModeId,
} from '@dsh-ops/expert-distribution-contract/scenarios'
import ScenarioGlyph from './ScenarioGlyph.vue'
import WebsiteDialog from './WebsiteDialog.vue'

/**
 * 常用场景 of one expert: an ordered list edited row by row. A row opens an inline form (never a nested dialog);
 * the list the parent receives is always valid by the contract rules the server applies again on save.
 * Shared by the cloud expert form and the built-in expert overrides. `expertIcon` is the expert's appearance icon:
 * a scenario without its own icon or mode borrows its glyph in the product, so the editor shows the same one.
 */
const props = defineProps<{ modelValue: ExpertScenario[]; disabled?: boolean; expertIcon?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: ExpertScenario[]]; editing: [value: boolean] }>()
type Field = 'title' | 'summary' | 'prompt' | 'modeId' | 'icon'
type Draft = { title: string; summary: string; prompt: string; modeId: '' | ScenarioModeId; icon: '' | ScenarioIcon }

const uid = useId()
const modes: Array<{ value: '' | ScenarioModeId; label: string }> = [{ value: '', label: '日常办公' }, ...SCENARIO_MODE_IDS.map(id => ({ value: id, label: SCENARIO_MODE_LABELS[id] }))]
/** 自动 first (no icon of its own), then every icon the contract allows, named as the contract names them. */
const icons: Array<{ value: '' | ScenarioIcon; label: string }> = [{ value: '', label: '自动' }, ...SCENARIO_ICONS.map(name => ({ value: name, label: SCENARIO_ICON_LABELS[name] }))]
/** The open form: `index` is the row being edited, absent for a new scenario (added at the end). */
const editing = ref<{ index?: number; form: Draft }>()
const errors = ref<Partial<Record<Field | 'list', string>>>({})
const removing = ref<number>()
const full = computed(() => props.modelValue.length >= SCENARIO_LIMITS.perExpert)
/** Position of the open form: the edited row, or one past the end for a new scenario. */
const formIndex = computed(() => editing.value ? editing.value.index ?? props.modelValue.length : undefined)
const rows = computed(() => [
  ...props.modelValue.map((scenario, index) => ({ key: scenario.id, index, scenario: scenario as ExpertScenario | undefined })),
  ...(editing.value && editing.value.index === undefined ? [{ key: '', index: props.modelValue.length, scenario: undefined }] : []),
])
const count = (value: string) => scenarioTextLength(value.trim())
watch(() => editing.value !== undefined, value => emit('editing', value))
onBeforeUnmount(() => emit('editing', false))
/** The last list this editor handed out; any other list comes from the parent (another expert, a reload, a discard). */
let emitted: readonly ExpertScenario[] | undefined
function update(list: ExpertScenario[]) { emitted = list; emit('update:modelValue', list) }
watch(() => props.modelValue, (value) => {
  // The parents hold the list in a ref, so it comes back as a reactive proxy of what was emitted.
  if (toRaw(value) === emitted) return
  // A form left open over another list would save into the wrong expert.
  editing.value = undefined; errors.value = {}; removing.value = undefined
})

const rowId = (index: number, action: string) => `${uid}-row-${index}-${action}`
function focus(id: string) { void nextTick(() => document.getElementById(id)?.focus()) }
function modeLabel(modeId?: ScenarioModeId) { return modeId ? SCENARIO_MODE_LABELS[modeId] ?? modeId : '' }
const describedBy = (field: Field, extra = '') => [extra, errors.value[field] ? `${uid}-${field}-error` : ''].filter(Boolean).join(' ') || undefined
/** The glyph the product draws for a scenario: its own icon, else its mode's, else the expert's. */
const iconOf = (scenario: { icon?: unknown; modeId?: unknown }) => scenarioIconFor(scenario, props.expertIcon)
/** What 自动 resolves to for the open form (follows the mode picked above it). */
const autoIcon = computed(() => iconOf({ modeId: editing.value?.form.modeId || undefined }))
const iconId = (value: '' | ScenarioIcon) => `${uid}-icon-choice-${value || 'auto'}`

function open(index?: number) {
  if (props.disabled || editing.value) return
  const scenario = index === undefined ? undefined : props.modelValue[index]
  editing.value = {
    ...(index === undefined ? {} : { index }),
    form: {
      title: scenario?.title ?? '', summary: scenario?.summary ?? '', prompt: scenario?.prompt ?? '', modeId: scenario?.modeId ?? '',
      icon: isScenarioIcon(scenario?.icon) ? scenario.icon : '',
    },
  }
  errors.value = {}
  void nextTick(() => { document.getElementById(`${uid}-form`)?.scrollIntoView({ block: 'nearest' }); document.getElementById(`${uid}-title`)?.focus() })
}
function cancel() {
  const index = editing.value?.index
  editing.value = undefined; errors.value = {}
  focus(index === undefined ? `${uid}-add` : rowId(index, 'edit'))
}
function save() {
  const state = editing.value
  if (!state) return
  const previous = state.index === undefined ? undefined : props.modelValue[state.index]
  const summary = state.form.summary.trim()
  const candidate: ExpertScenario = {
    id: previous?.id ?? newScenarioId(props.modelValue.map(scenario => scenario.id)),
    title: state.form.title, prompt: state.form.prompt,
    ...(summary ? { summary } : {}), ...(state.form.modeId ? { modeId: state.form.modeId } : {}),
    ...(state.form.icon ? { icon: state.form.icon } : {}),
  }
  const index = state.index ?? props.modelValue.length
  const list = [...props.modelValue]
  list.splice(index, state.index === undefined ? 0 : 1, candidate)
  // Only this row's problems (and list-level ones) can be fixed here; the other rows were valid already.
  const found: Partial<Record<Field | 'list', string>> = {}
  for (const issue of scenarioIssues(list)) {
    if (issue.index !== undefined && issue.index !== index) continue
    const key = issue.field && issue.field !== 'id' ? issue.field : 'list'
    found[key] ??= issue.message
  }
  // The contract reports a repeated name on the later row; renaming an earlier row after a later one is this row's
  // problem too (stored titles are already canonical).
  const title = canonicalScenario(candidate).title
  if (!found.title && title && props.modelValue.some((scenario, position) => position !== state.index && scenario.title === title)) found.title = `场景名称「${title}」重复`
  errors.value = found
  const first = (['title', 'summary', 'prompt'] as const).find(field => found[field])
  if (first) { focus(`${uid}-${first}`); return }
  // An icon problem lands on the picker: the checked choice holds the group's tab stop.
  if (found.icon) { focus(iconId(state.form.icon)); return }
  if (found.modeId || found.list) { focus(`${uid}-list-error`); return }
  list[index] = canonicalScenario(candidate)
  update(list)
  editing.value = undefined
  focus(rowId(index, 'edit'))
}
/** Enter in a one-line field or on a mode saves the row, never a surrounding form; Enter that commits an IME candidate is left alone. */
function saveOnEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  save()
}
/** Escape closes the row form, but not while it only dismisses an IME candidate list (the typed row would be lost). */
function cancelOnEscape(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  cancel()
}
function pickIcon(value: '' | ScenarioIcon) { if (editing.value) editing.value.form.icon = value }
/**
 * The icon picker is one radio group with a single tab stop (the checked choice): arrows move the choice and the
 * focus together, wrapping at the ends, Home/End jump; Space picks (button click); Enter saves the row, as on the
 * mode radios above it.
 */
function iconKeydown(event: KeyboardEvent) {
  const state = editing.value
  if (!state) return
  if (event.key === 'Enter') { saveOnEnter(event); return }
  const last = icons.length - 1
  const at = Math.max(0, icons.findIndex(choice => choice.value === state.form.icon))
  const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at === last ? 0 : at + 1)
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at === 0 ? last : at - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined
  if (target === undefined) return
  event.preventDefault()
  const value = icons[target]!.value
  state.form.icon = value
  focus(iconId(value))
}
function move(index: number, delta: -1 | 1) {
  const target = index + delta
  if (props.disabled || editing.value || target < 0 || target >= props.modelValue.length) return
  const list = [...props.modelValue]
  const [row] = list.splice(index, 1)
  list.splice(target, 0, row!)
  update(list)
  // Keep the keyboard on the row that moved; at an edge the other direction is the one still available.
  const edge = target === 0 || target === list.length - 1
  focus(rowId(target, edge ? (delta < 0 ? 'down' : 'up') : delta < 0 ? 'up' : 'down'))
}
function confirmRemove() {
  const index = removing.value
  removing.value = undefined
  if (index === undefined) return
  const remaining = props.modelValue.filter((_, position) => position !== index)
  update(remaining)
  focus(remaining.length ? rowId(Math.min(index, remaining.length - 1), 'edit') : `${uid}-add`)
}
</script>

<template>
  <div class="scenario-editor">
    <p v-if="!rows.length" class="editor-help">还没有常用场景。</p>
    <ol v-else class="scenario-rows" :aria-label="`常用场景（${modelValue.length} / ${SCENARIO_LIMITS.perExpert}）`">
      <li v-for="row in rows" :key="row.key" class="scenario-row" :class="{ 'is-editing': formIndex === row.index }">
        <div v-if="editing && formIndex === row.index" :id="`${uid}-form`" class="scenario-form" role="group" :aria-label="row.scenario ? `编辑场景「${row.scenario.title}」` : '添加场景'" @keydown.esc="cancelOnEscape">
          <div class="chapter-fields">
            <label>场景名称<input :id="`${uid}-title`" v-model="editing.form.title" :maxlength="SCENARIO_LIMITS.titleLength" :aria-invalid="Boolean(errors.title)" :aria-describedby="describedBy('title', `${uid}-title-count`)" @keydown.enter="saveOnEnter" /><small :id="`${uid}-title-count`">{{ count(editing.form.title) }} / {{ SCENARIO_LIMITS.titleLength }}</small><small v-if="errors.title" :id="`${uid}-title-error`" class="scenario-error">{{ errors.title }}</small></label>
            <label>简介（可选）<input :id="`${uid}-summary`" v-model="editing.form.summary" :maxlength="SCENARIO_LIMITS.summaryLength" :aria-invalid="Boolean(errors.summary)" :aria-describedby="describedBy('summary', `${uid}-summary-count`)" @keydown.enter="saveOnEnter" /><small :id="`${uid}-summary-count`">{{ count(editing.form.summary) }} / {{ SCENARIO_LIMITS.summaryLength }}</small><small v-if="errors.summary" :id="`${uid}-summary-error`" class="scenario-error">{{ errors.summary }}</small></label>
            <label class="chapter-summary-field">提问模板<textarea :id="`${uid}-prompt`" v-model="editing.form.prompt" rows="4" :maxlength="SCENARIO_LIMITS.promptLength" :aria-invalid="Boolean(errors.prompt)" :aria-describedby="describedBy('prompt', `${uid}-prompt-hint`)"></textarea><small :id="`${uid}-prompt-hint`">{{ count(editing.form.prompt) }} / {{ SCENARIO_LIMITS.promptLength }} · 用【】标出需要使用者填写的内容，最多 {{ SCENARIO_LIMITS.placeholders }} 处（当前 {{ countScenarioPlaceholders(editing.form.prompt) }} 处）；不要放密钥或令牌。</small><small v-if="errors.prompt" :id="`${uid}-prompt-error`" class="scenario-error">{{ errors.prompt }}</small></label>
          </div>
          <fieldset class="scenario-modes" :aria-describedby="describedBy('modeId')"><legend>工作模式（选择场景时切换到这个模式）</legend><label v-for="mode in modes" :key="mode.value" class="check-label"><input v-model="editing.form.modeId" type="radio" :name="`${uid}-mode`" :value="mode.value" @keydown.enter="saveOnEnter" />{{ mode.label }}</label><small v-if="errors.modeId" :id="`${uid}-modeId-error`" class="scenario-error">{{ errors.modeId }}</small></fieldset>
          <div class="scenario-icon-field">
            <span :id="`${uid}-icon-label`" class="scenario-icon-label">图标</span>
            <div class="scenario-icons" role="radiogroup" :aria-labelledby="`${uid}-icon-label`" :aria-describedby="describedBy('icon', `${uid}-icon-help`)" :aria-invalid="Boolean(errors.icon) || undefined" @keydown="iconKeydown">
              <button
                v-for="choice in icons" :id="iconId(choice.value)" :key="choice.value || 'auto'" type="button" role="radio" class="scenario-icon-choice" :class="{ 'is-auto': !choice.value }"
                :aria-checked="editing.form.icon === choice.value" :tabindex="editing.form.icon === choice.value ? 0 : -1"
                :aria-label="choice.value ? choice.label : undefined" :title="choice.value ? choice.label : `自动：${SCENARIO_ICON_LABELS[autoIcon]}`" @click="pickIcon(choice.value)"
              ><ScenarioGlyph :name="choice.value || autoIcon" :size="18" /><span v-if="!choice.value">{{ choice.label }}</span></button>
            </div>
            <small :id="`${uid}-icon-help`" class="scenario-icon-help">不选时按工作模式或专家自动配图标</small>
            <small v-if="errors.icon" :id="`${uid}-icon-error`" class="scenario-error">{{ errors.icon }}</small>
          </div>
          <p v-if="errors.list" :id="`${uid}-list-error`" class="scenario-error" role="alert" tabindex="-1">{{ errors.list }}</p>
          <div class="admin-actions"><button type="button" class="button secondary" @click="cancel">取消</button><button type="button" class="button primary" @click="save">保存场景</button></div>
        </div>
        <template v-else-if="row.scenario">
          <div class="scenario-main">
            <ScenarioGlyph class="scenario-row-icon" :name="iconOf(row.scenario)" :size="18" />
            <div class="scenario-summary">
              <strong>{{ row.index + 1 }}. {{ row.scenario.title }}<span v-if="row.scenario.modeId" class="scenario-mode">{{ modeLabel(row.scenario.modeId) }}</span></strong>
              <small v-if="row.scenario.summary">{{ row.scenario.summary }}</small>
              <p class="scenario-prompt">{{ row.scenario.prompt }}</p>
            </div>
          </div>
          <div class="scenario-actions">
            <button :id="rowId(row.index, 'edit')" type="button" class="management-action" :disabled="disabled || Boolean(editing)" :aria-label="`编辑场景「${row.scenario.title}」`" @click="open(row.index)">编辑</button>
            <button :id="rowId(row.index, 'up')" type="button" class="management-action" :disabled="disabled || Boolean(editing) || row.index === 0" :aria-label="`上移场景「${row.scenario.title}」`" @click="move(row.index, -1)">上移</button>
            <button :id="rowId(row.index, 'down')" type="button" class="management-action" :disabled="disabled || Boolean(editing) || row.index === modelValue.length - 1" :aria-label="`下移场景「${row.scenario.title}」`" @click="move(row.index, 1)">下移</button>
            <button type="button" class="management-action danger" :disabled="disabled || Boolean(editing)" :aria-label="`删除场景「${row.scenario.title}」`" @click="removing = row.index">删除</button>
          </div>
        </template>
      </li>
    </ol>
    <div class="admin-actions scenario-add">
      <button :id="`${uid}-add`" type="button" class="button secondary" :disabled="disabled || full || Boolean(editing)" @click="open()">添加场景</button>
      <small class="editor-help">{{ full ? `已达到 ${SCENARIO_LIMITS.perExpert} 个上限，删除一个后才能添加。` : `${modelValue.length} / ${SCENARIO_LIMITS.perExpert}` }}</small>
    </div>
    <WebsiteDialog v-if="removing !== undefined && modelValue[removing]" :title="`删除场景「${modelValue[removing]!.title}」？`" message="只从当前列表中移除。保存并发布后，使用者才会看不到它。" confirm-label="删除场景" @cancel="removing = undefined" @confirm="confirmRemove" />
  </div>
</template>

<style scoped>
.scenario-editor{display:grid;gap:12px}
.scenario-rows{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.scenario-row{display:flex;justify-content:space-between;gap:14px;padding:12px 14px;border:1px solid var(--border-subtle);border-radius:8px;font-size:12px}
.scenario-row.is-editing{display:block;border-color:#dcd7f8;background:#fbfaff}
.scenario-main{min-width:0;flex:1;display:flex;align-items:flex-start;gap:10px}
.scenario-row-icon{margin-top:1px;color:var(--text-secondary)}
.scenario-summary{min-width:0;flex:1;display:grid;gap:4px}
.scenario-summary strong{font-size:13px;line-height:20px;overflow-wrap:anywhere}
.scenario-summary small{color:var(--text-secondary);font-size:11px;overflow-wrap:anywhere}
/* The mode as the product tags it on the home cards (teal pill). */
.scenario-mode{display:inline-flex;align-items:center;height:20px;box-sizing:border-box;margin-left:8px;padding:0 8px;border-radius:999px;background:#e6f6f4;color:#0e6f66;font-size:11px;font-weight:600;line-height:1;white-space:nowrap;vertical-align:1px}
.scenario-icon-field{display:grid;gap:8px;min-width:0}
.scenario-icon-label{font-size:12px}
.scenario-icons{display:flex;flex-wrap:wrap;gap:6px}
.scenario-icon-choice{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:34px;height:34px;padding:0;border:1px solid var(--border-default);border-radius:8px;background:#fff;color:var(--text-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:border-color .12s,background-color .12s,color .12s,box-shadow .12s}
.scenario-icon-choice.is-auto{padding:0 10px}
.scenario-icon-choice.is-auto :deep(svg){opacity:.45}
.scenario-icon-choice:hover{background:#f4f2ff;border-color:#c9c1f2}
/* Checked: a 1.5px accent edge drawn inside the box, so choosing never moves the others. */
.scenario-icon-choice[aria-checked="true"]{border-color:var(--accent-primary);box-shadow:inset 0 0 0 .5px var(--accent-primary);background:#eeedff;color:var(--accent-primary)}
.scenario-icon-help{font-size:12px;line-height:1.6;color:var(--text-secondary)}
@media(prefers-reduced-motion:reduce){.scenario-icon-choice{transition:none}}
.scenario-prompt{margin:0;color:var(--text-tertiary);font-size:11px;line-height:1.7;white-space:pre-line;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.scenario-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;justify-content:flex-end;max-width:260px}
.scenario-form{display:grid;gap:12px}
.scenario-modes{display:flex;flex-wrap:wrap;gap:10px 20px;margin:4px 0;padding:0;border:0;min-width:0}
.scenario-modes legend{font-size:12px;margin-bottom:10px;width:100%;padding:0}
.scenario-modes .scenario-error{width:100%}
.scenario-error{color:#973d3d!important;font-size:11px!important;margin:0}
.scenario-error:focus{outline:none}
.scenario-add small{margin:0}
@media(max-width:760px){.scenario-row{flex-direction:column}.scenario-actions{justify-content:flex-start;max-width:none}}
</style>
