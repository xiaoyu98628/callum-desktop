<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import { ChevronRightIcon, FileTextIcon, LoaderCircleIcon, SquareIcon } from '@lucide/vue'
import type { ChatApproval } from '@shared/chat'
import { approvalSummary } from '@shared/approval-summary'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  approval: ChatApproval
  count: number
  deciding: boolean
  cancelling: boolean
  unavailable: boolean
  error: string
}>()
const emit = defineEmits<{
  decide: [id: string, decision: 'approved' | 'rejected']
  stop: [id: string]
  reload: []
}>()
const panel = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const detailsId = useId()
const summary = computed(() => approvalSummary(props.approval.snapshot))
const expanded = ref(!summary.value.recognized)
const target = computed(() =>
  props.approval.toolName === 'read_file'
    ? summary.value.fields.find((field) => field.label === '实际目标')
    : undefined,
)
const filename = computed(() => target.value?.value.split(/[\\/]/).filter(Boolean).at(-1) ?? '')
const otherFields = computed(() => summary.value.fields.filter((field) => field !== target.value))
const heading = computed(() =>
  props.approval.toolName === 'read_file'
    ? '允许读取文件？'
    : `允许 ${props.approval.toolName} 吗？`,
)
const busy = computed(() => props.deciding || props.cancelling)
const disabled = computed(() => busy.value || props.unavailable)
function decide(decision: 'approved' | 'rejected'): void {
  if (!disabled.value) emit('decide', props.approval.id, decision)
}
onMounted(() => {
  // 焦点落在说明区域，Enter 不会默认批准；这是非模态面板，仍可切换会话。
  panel.value?.focus({ preventScroll: true })
})
watch(
  () => summary.value.recognized,
  (recognized) => {
    if (!recognized) expanded.value = true
  },
)
watch(
  () => props.error,
  async (error) => {
    if (!error) return
    await nextTick()
    if (body.value) body.value.scrollTop = 0
  },
)
</script>

<template>
  <section
    ref="panel"
    role="region"
    aria-label="工具审批"
    tabindex="-1"
    class="mx-auto flex max-h-[min(26rem,60vh)] min-h-0 max-w-3xl flex-col overflow-hidden rounded-2xl border bg-card shadow-sm outline-none transition-colors focus-visible:border-foreground/30"
  >
    <header class="flex shrink-0 items-center gap-3 px-4 pb-2 pt-3">
      <h2 class="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
        {{ heading }}
      </h2>
      <span v-if="count > 1" class="shrink-0 text-xs leading-5 text-muted-foreground">
        待确认 {{ count }} 项
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        class="size-7 shrink-0 rounded-full border text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="停止生成"
        :title="cancelling ? '正在停止…' : '停止生成'"
        :aria-busy="cancelling"
        :disabled="disabled"
        @click="emit('stop', approval.id)"
      >
        <LoaderCircleIcon v-if="cancelling" class="size-3.5 animate-spin" aria-hidden="true" />
        <SquareIcon v-else class="size-3 fill-current" aria-hidden="true" />
      </Button>
    </header>
    <div ref="body" class="min-h-0 overflow-y-auto px-4 pb-3 text-xs leading-5">
      <div v-if="error" role="alert" class="mt-2 rounded-lg bg-destructive/5 p-2 text-destructive">
        <p class="break-words [overflow-wrap:anywhere]">{{ error }}</p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          class="mt-2"
          :disabled="busy"
          @click="emit('reload')"
        >
          重新加载审批
        </Button>
      </div>
      <div v-if="target" class="mb-2 min-w-0">
        <p class="mb-1 flex items-center gap-2 text-sm">
          <FileTextIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="break-words font-medium [overflow-wrap:anywhere]">{{ filename }}</span>
        </p>
        <dl class="text-muted-foreground">
          <dt class="sr-only">实际目标</dt>
          <dd class="whitespace-pre-wrap break-words font-mono text-xs [overflow-wrap:anywhere]">
            {{ target.value }}
          </dd>
        </dl>
      </div>
      <dl v-if="otherFields.length" class="space-y-1.5 text-muted-foreground">
        <div
          v-for="field in otherFields"
          :key="field.label"
          class="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2"
        >
          <dt class="text-muted-foreground">{{ field.label }}</dt>
          <dd class="whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">
            {{ field.value }}
          </dd>
        </div>
      </dl>
      <pre
        v-show="expanded"
        :id="detailsId"
        tabindex="0"
        aria-label="完整操作快照"
        class="mt-3 whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3 text-xs leading-5"
        >{{ approval.snapshot }}</pre>
    </div>
    <footer class="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
      <button
        type="button"
        class="mr-auto inline-flex min-h-8 items-center gap-1 rounded-md pr-2 text-xs text-muted-foreground hover:text-foreground"
        :aria-expanded="expanded"
        :aria-controls="detailsId"
        @click="expanded = !expanded"
      >
        <ChevronRightIcon
          class="size-3.5 transition-transform"
          :class="{ 'rotate-90': expanded }"
          aria-hidden="true"
        />
        {{ expanded ? '收起详情' : '查看详情' }}
      </button>
      <span
        v-if="deciding"
        role="status"
        class="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <LoaderCircleIcon class="size-3 animate-spin" aria-hidden="true" />正在提交决定…
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="disabled"
        class="rounded-lg"
        @click="decide('rejected')"
        >拒绝</Button
      >
      <Button
        type="button"
        size="sm"
        class="rounded-lg bg-foreground text-background hover:bg-foreground/90"
        :disabled="disabled"
        @click="decide('approved')"
        >允许一次</Button
      >
    </footer>
  </section>
</template>
