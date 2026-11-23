<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import type { ChatStep } from '@shared/chat'
import { getDesktopApi } from '@/lib/desktop'
import ActivityDisclosure from './ActivityDisclosure.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import { MAX_MARKDOWN_TEXT } from './markdown/contract'

const props = defineProps<{
  step: ChatStep
  liveReasoning: string | undefined
  keepOpen: boolean
  errorBelow: boolean
  active: boolean
  connected: boolean
}>()
const emit = defineEmits<{ changed: []; inspect: [] }>()
const inProgress = computed(
  () => props.active && ['pending', 'running'].includes(props.step.status),
)
const expanded = ref(props.keepOpen)
const open = computed(() => inProgress.value || expanded.value)
const savedReasoning = ref('')
const readError = ref('')
const reading = ref(false)
const retryCount = ref(0)
const reasoning = computed(() => {
  const preview = props.step.reasoning ?? ''
  const live = props.liveReasoning ?? ''
  const newest = live.length >= preview.length ? live : preview
  return savedReasoning.value.length > newest.length ? savedReasoning.value : newest
})
const needsRead = computed(
  () =>
    !!props.step.reasoningTruncated &&
    !(
      inProgress.value &&
      (props.liveReasoning?.length ?? 0) >= (props.step.reasoning?.length ?? 0) &&
      props.liveReasoning !== undefined
    ),
)
const viewport = ref<HTMLElement | null>(null)
const overflow = ref(false),
  atStart = ref(true),
  atEnd = ref(true)
let followTail = true
let frame: number | undefined
let observer: ResizeObserver | undefined
let disposed = false

function measure(): void {
  const element = viewport.value
  if (!element) return
  overflow.value = element.scrollHeight > element.clientHeight + 1
  atStart.value = element.scrollTop <= 1
  atEnd.value = element.scrollHeight - element.clientHeight - element.scrollTop <= 1
}
function schedule(): void {
  if (disposed || frame !== undefined) return
  frame = requestAnimationFrame(() => {
    frame = undefined
    if (viewport.value && inProgress.value && followTail)
      viewport.value.scrollTop = viewport.value.scrollHeight
    measure()
    emit('changed')
  })
}
function inspect(): void {
  followTail = false
  emit('inspect')
}
function scroll(): void {
  measure()
  // 布局变化触发的 scroll 不能解除跟随；用户输入先通过 inspect 暂停。
  if (atEnd.value) followTail = true
}
function toggle(): void {
  expanded.value = !expanded.value
  emit('inspect')
}
watch([inProgress, () => props.keepOpen], ([running, keepOpen], [wasRunning, wasKept]) => {
  if (running || (!keepOpen && (wasRunning || wasKept))) expanded.value = false
  else if (keepOpen && (!wasKept || wasRunning)) expanded.value = true
})
watch(
  () => [open.value, props.connected, props.step.id, needsRead.value, retryCount.value] as const,
  async ([visible, connected, stepId, required], _, onCleanup) => {
    reading.value = false
    readError.value = ''
    if (!visible || !connected || !required) return
    const { conversationId, runId } = props.step
    let current = true
    onCleanup(() => {
      current = false
    })
    reading.value = true
    try {
      const result = await getDesktopApi().getStepReasoning(conversationId, runId, stepId)
      if (!result.ok) throw new Error(result.error)
      if (current) savedReasoning.value = result.value
    } catch {
      if (current) readError.value = '无法读取思考内容。'
    } finally {
      if (current) reading.value = false
    }
  },
  { immediate: true },
)
watch(viewport, (element) => {
  observer?.disconnect()
  followTail = inProgress.value
  if (element) {
    observer = new ResizeObserver(schedule)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    schedule()
  }
})
watch(reasoning, () => {
  void nextTick(schedule)
})
onScopeDispose(() => {
  disposed = true
  observer?.disconnect()
  if (frame !== undefined) cancelAnimationFrame(frame)
})
</script>

<template>
  <ActivityDisclosure
    :expanded="open"
    :collapsible="!inProgress"
    aria-label="思考过程"
    content-label="思考内容"
    @toggle="toggle"
    @changed="schedule"
    @collapsed="savedReasoning = ''"
  >
    <template #label>
      <span :class="inProgress && connected ? 'activity-shimmer' : ''">{{
        inProgress
          ? connected
            ? '思考中'
            : '思考状态待核对'
          : step.steered
            ? '已按引导切换'
            : '已思考'
      }}</span>
    </template>
    <div
      ref="viewport"
      class="reasoning-scroll"
      tabindex="0"
      aria-label="思考文本"
      :data-overflow="overflow"
      :data-at-start="atStart"
      :data-at-end="atEnd"
      @scroll.passive="scroll"
      @wheel.passive="inspect"
      @pointerdown="inspect"
      @keydown="inspect"
    >
      <div class="reasoning-content">
        <MarkdownMessage
          v-if="reasoning && reasoning.length <= MAX_MARKDOWN_TEXT"
          :content="[{ type: 'text', text: reasoning, path: '' }]"
          :streaming="inProgress && connected"
          @rendered="schedule"
        />
        <div v-else-if="reasoning" class="wrap-anywhere whitespace-pre-wrap">{{ reasoning }}</div>
      </div>
    </div>
    <p v-if="reading" role="status" class="reasoning-notice">正在读取思考内容…</p>
    <p v-else-if="readError" role="alert" class="reasoning-notice">
      {{ readError }}
      <button type="button" class="underline" @click="retryCount++">重试</button>
    </p>
    <p
      v-if="
        !errorBelow && !step.steered && ['cancelled', 'interrupted', 'failed'].includes(step.status)
      "
      class="reasoning-notice"
    >
      执行未完成，以上为已收到的部分思考内容。
    </p>
    <p v-if="inProgress && !connected" class="reasoning-notice">连接已断开，思考状态待核对。</p>
  </ActivityDisclosure>
</template>
