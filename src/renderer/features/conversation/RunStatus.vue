<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { isActiveRun } from '@shared/chat'
import type { ChatRun, RunStatus } from '@shared/chat'
import { elapsedRunTime, formatRunTime } from '@shared/run-time'

const props = defineProps<{ run: ChatRun | null; connected: boolean }>()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
const labels: Record<RunStatus, string> = {
  pending: '正在准备',
  running: '正在处理',
  awaiting_approval: '等待审批',
  awaiting_user_input: '等待补充输入',
  completed: '已处理',
  failed: '回答失败',
  cancelled: '生成已停止',
  interrupted: '回答已中断',
}
const disconnected = computed(() => props.run && isActiveRun(props.run) && !props.connected)
const label = computed(() =>
  disconnected.value ? '连接已断开' : props.run ? labels[props.run.status] : '',
)
const elapsed = computed(() =>
  props.run && !disconnected.value ? elapsedRunTime(props.run, now.value) : null,
)
const duration = computed(() => (elapsed.value === null ? '' : formatRunTime(elapsed.value)))
const prefix = computed(() =>
  props.run && ['failed', 'cancelled'].includes(props.run.status) ? '· 用时 ' : '',
)
function stopClock(): void {
  clearInterval(clock)
  clock = undefined
}
watch(
  () => [props.run?.id, props.run?.createdAt, props.run?.status, props.connected],
  () => {
    stopClock()
    now.value = Date.now()
    // 仅为当前挂载的活动执行计时，终态、断连、切换页面时均释放定时器。
    if (props.run && isActiveRun(props.run) && props.connected)
      clock = setInterval(() => {
        now.value = Date.now()
      }, 1000)
  },
  { immediate: true },
)
onScopeDispose(stopClock)
</script>

<template>
  <div
    v-if="run"
    role="group"
    aria-label="执行状态"
    aria-live="off"
    :title="
      duration
        ? '从本次请求创建起的总用时，包含等待审批；结束后固定。'
        : '缺少准确的执行时间，不显示推测用时。'
    "
    class="mb-3 flex flex-wrap items-center gap-x-1 border-b pb-2 text-xs leading-5 text-muted-foreground"
  >
    <span>{{ label }}</span>
    <span v-if="duration" class="tabular-nums">{{ ' ' + prefix + duration }}</span>
  </div>
</template>
