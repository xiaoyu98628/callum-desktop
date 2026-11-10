<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FileTextIcon, LoaderCircleIcon, PencilIcon, TerminalIcon } from '@lucide/vue'
import { operationSummary } from '@shared/timeline-groups'
import type { OperationGroup } from '@shared/timeline-groups'
import ActivityDisclosure from './ActivityDisclosure.vue'

const props = defineProps<{
  group: OperationGroup
  current: boolean
  connected: boolean
  partial: boolean
}>()
const emit = defineEmits<{ inspect: []; changed: []; closing: [] }>()
const manual = ref<boolean | null>(null)
const summary = computed(() => operationSummary(props.group.steps))
const grouped = computed(() => props.partial || props.group.steps.length > 1)
const expanded = computed(
  () => !grouped.value || (manual.value ?? (props.current || summary.value.waiting)),
)
// 分组跨越展示窗口时不把窗口内计数当作整组总数，也不暴露分页提示。
const title = computed(() => (props.partial ? '操作记录' : summary.value.label))
const notice = computed(() =>
  props.partial ? summary.value.notice.replace(/\d+ 项/g, '') : summary.value.notice,
)
const label = computed(() => [title.value, notice.value].filter(Boolean).join(' · '))
const running = computed(() =>
  props.group.steps.some((step) => ['pending', 'running'].includes(step.status)),
)
const icon = computed(() => {
  if (props.connected && running.value) return LoaderCircleIcon
  if (props.group.steps.some((step) => step.name === 'apply_patch')) return PencilIcon
  if (props.group.steps.some((step) => step.name !== 'run_command')) return FileTextIcon
  return TerminalIcon
})
function toggle(): void {
  manual.value = !expanded.value
  emit('inspect')
}
watch(
  () => props.current,
  (current, previous) => {
    // 进入下一阶段时自动收起；用户随后仍可重新打开历史组。
    if (previous && !current) manual.value = null
  },
)
watch(
  () => summary.value.waiting,
  (waiting, previous) => {
    if (waiting && !previous) manual.value = null
  },
)
watch(expanded, (value) => {
  if (!value) emit('closing')
})
</script>

<template>
  <ActivityDisclosure
    :class="{ 'activity-operation-group': grouped }"
    :data-operation-group="grouped ? group.id : undefined"
    :expanded="expanded"
    :show-header="grouped"
    :aria-label="`操作分组：${label}`"
    :content-label="grouped ? '本组操作' : ''"
    @toggle="toggle"
    @changed="emit('changed')"
  >
    <template #label>
      <span class="activity-tool-label activity-group-label">
        <component
          :is="icon"
          :class="connected && running ? 'animate-spin' : ''"
          aria-hidden="true"
        />
        <span>{{ title }}</span>
        <span v-if="notice" :class="summary.danger ? 'text-destructive' : ''">
          · {{ notice }}
        </span>
      </span>
    </template>
    <div :class="{ 'activity-group-operations': grouped }"><slot /></div>
  </ActivityDisclosure>
</template>
