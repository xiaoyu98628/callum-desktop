<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import type { ChatStep } from '@shared/chat'
import ActivityDisclosure from './ActivityDisclosure.vue'
import MarkdownMessage from './MarkdownMessage.vue'

const props = defineProps<{ step: ChatStep; active: boolean; connected: boolean }>()
const emit = defineEmits<{ changed: []; inspect: [] }>()
const inProgress = computed(
  () => props.active && ['pending', 'running'].includes(props.step.status),
)
const expanded = ref(false)
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
watch(inProgress, () => {
  expanded.value = false
})
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
watch(
  () => props.step.reasoning,
  () => {
    void nextTick(schedule)
  },
)
onScopeDispose(() => {
  disposed = true
  observer?.disconnect()
  if (frame !== undefined) cancelAnimationFrame(frame)
})
</script>

<template>
  <ActivityDisclosure
    :expanded="inProgress || expanded"
    :collapsible="!inProgress"
    aria-label="思考过程"
    content-label="思考内容"
    @toggle="toggle"
    @changed="schedule"
  >
    <template #label>
      <span :class="inProgress && connected ? 'activity-shimmer' : ''">{{
        inProgress ? (connected ? '思考中' : '思考状态待核对') : '已思考'
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
          v-if="step.reasoning"
          :content="[{ type: 'text', text: step.reasoning, path: '' }]"
          :streaming="inProgress && connected"
          @rendered="schedule"
        />
      </div>
    </div>
    <p v-if="step.reasoningTruncated" class="reasoning-notice">
      思考内容较长，展示已截取；完整记录保留在服务中。
    </p>
    <p v-if="['cancelled', 'interrupted', 'failed'].includes(step.status)" class="reasoning-notice">
      执行未完成，以上为已收到的部分思考内容。
    </p>
    <p v-if="inProgress && !connected" class="reasoning-notice">连接已断开，思考状态待核对。</p>
  </ActivityDisclosure>
</template>
