<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { ChevronRightIcon, FileTextIcon, LoaderCircleIcon } from '@lucide/vue'
import type { ApprovalScope, ChatApproval } from '@shared/chat'
import { approvalSummary } from '@shared/approval-summary'
import { Button } from '@/components/ui/button'
import InteractionCard from './InteractionCard.vue'

const props = defineProps<{
  approval: ChatApproval
  count: number
  deciding: boolean
  cancelling: boolean
  unavailable: boolean
  error: string
  collapsed: boolean
}>()
const emit = defineEmits<{
  decide: [id: string, decision: 'approved' | 'rejected', scope: ApprovalScope]
  reload: []
  'update:collapsed': [value: boolean]
}>()
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
    : props.approval.toolName === 'apply_patch'
      ? '允许修改文件？'
      : props.approval.toolName === 'run_command'
        ? '允许运行命令？'
        : `允许 ${props.approval.toolName} 吗？`,
)
const busy = computed(() => props.deciding || props.cancelling)
const disabled = computed(() => busy.value || props.unavailable)
function decide(decision: 'approved' | 'rejected', scope: ApprovalScope = 'once'): void {
  if (!disabled.value) emit('decide', props.approval.id, decision, scope)
}
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
  <InteractionCard
    label="需要审批"
    region-label="工具审批"
    :collapsed="collapsed"
    :busy="busy"
    :count="count"
    :error="!!error"
    @update:collapsed="emit('update:collapsed', $event)"
  >
    <div ref="body" class="min-h-0 overflow-y-auto px-4 pb-3 text-xs leading-5">
      <h2 class="mb-3 mt-1 break-words text-sm font-medium leading-6 [overflow-wrap:anywhere]">
        {{ heading }}
      </h2>
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
      <p
        v-if="summary.executionNotice"
        class="mb-3 rounded-lg bg-muted/60 p-3 text-muted-foreground"
      >
        {{ summary.executionNotice }}
      </p>
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
          v-for="(field, index) in otherFields"
          :key="`${field.label}:${index}`"
          class="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2"
        >
          <dt class="text-muted-foreground">{{ field.label }}</dt>
          <dd class="whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">
            {{ field.value }}
          </dd>
        </div>
      </dl>
      <div
        v-if="approval.directoryScope"
        class="mt-3 rounded-lg bg-muted/60 p-2 text-muted-foreground"
      >
        <p>
          本会话允许此目录及子目录{{
            approval.directoryScope.access === 'read' ? '读取' : '读取和普通修改'
          }}，重启后保留，可随时撤销。
        </p>
        <p class="break-all font-mono">{{ approval.directoryScope.rootPath }}</p>
      </div>
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
        class="rounded-full"
        @click="decide('rejected')"
        >拒绝</Button
      >
      <Button
        type="button"
        size="sm"
        class="rounded-full bg-foreground text-background hover:bg-foreground/90"
        :disabled="disabled"
        @click="decide('approved')"
        >仅本次允许</Button
      >
      <Button
        v-if="approval.directoryScope"
        type="button"
        variant="outline"
        size="sm"
        class="rounded-full"
        :disabled="disabled"
        @click="decide('approved', 'conversation_directory')"
        >本会话允许此目录</Button
      >
    </footer>
  </InteractionCard>
</template>
