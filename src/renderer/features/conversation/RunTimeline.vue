<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { FileTextIcon, LoaderCircleIcon, PencilIcon, TerminalIcon } from '@lucide/vue'
import type { ChatRun, ChatStep, StepDetails } from '@shared/chat'
import { STEP_PAGE_SIZE, stepLabel, stepParameters, stepResult } from '@shared/steps'
import { TimelineWindow } from '@shared/timeline-window'
import type { TimelineStep } from '@shared/timeline-window'
import { currentOperationGroup, groupTimeline } from '@shared/timeline-groups'
import { getDesktopApi } from '@/lib/desktop'
import MarkdownMessage from './MarkdownMessage.vue'
import ActivityDisclosure from './ActivityDisclosure.vue'
import ReasoningItem from './ReasoningItem.vue'
import OperationGroup from './OperationGroup.vue'
import RunStatus from './RunStatus.vue'
import CompactionStatus from './CompactionStatus.vue'

const props = defineProps<{
  run: ChatRun | null
  conversationId: string
  runId: string
  snapshots: ChatStep[]
  connected: boolean
  expanded: boolean
  active: boolean
}>()
const emit = defineEmits<{ changed: []; inspect: []; expand: [value: boolean] }>()
const showContent = computed(() => props.active || props.expanded)
const viewport = ref<HTMLElement | null>(null)
const beforeRows = ref<HTMLElement | null>(null),
  afterRows = ref<HTMLElement | null>(null)
const rows = shallowRef<TimelineStep[]>([])
const loading = ref(false)
const error = ref('')
const hasMore = ref(false),
  hasPrevious = ref(false)
const opened = ref<string | null>(null)
const detail = shallowRef<{ id: string; version: string; value: StepDetails } | null>(null)
const detailPending = ref<string | null>(null),
  commentPending = ref<string | null>(null)
const failures = ref<Record<string, string>>({})
const commentVersions = new Map<string, string>()
const followTail = ref(true)
const version = (step: ChatStep): string => `${step.status}:${step.updatedAt}`
const visible = computed(() =>
  rows.value.filter(
    (step) =>
      step.type !== 'model_call' ||
      (step.purpose === 'answer' &&
        (step.reasoning ||
          step.reasoningTruncated ||
          (step.commentary && step.text) ||
          failures.value[step.id])),
  ),
)
const items = computed(() => groupTimeline(visible.value))
const currentGroupId = computed(() => {
  if (!props.active) return null
  const latest = [...rows.value, ...props.snapshots]
    .filter(
      (step) =>
        step.runId === props.runId &&
        step.conversationId === props.conversationId &&
        (step.type !== 'model_call' || step.purpose === 'answer'),
    )
    .reduce<ChatStep | undefined>(
      (last, step) => (!last || step.sequence > last.sequence ? step : last),
      undefined,
    )
  return currentOperationGroup(items.value, latest)
})
const live = computed(() =>
  props.snapshots.find(
    (step) =>
      step.id === opened.value &&
      step.runId === props.runId &&
      step.conversationId === props.conversationId,
  ),
)
const savedResult = computed(() => stepResult(detail.value?.value.output ?? ''))
let records: TimelineWindow | undefined
let generation = 0,
  disposed = false,
  readingComments = false,
  readingDetail = false
let scrollFrame: number | undefined
let lastAction: 'start' | 'next' | 'previous' = 'start'
let browsingHistory = false
let navigationRoot: HTMLElement | null = null
let edgeObserver: IntersectionObserver | undefined
let sizeObserver: ResizeObserver | undefined
let nearStart = false,
  nearEnd = false,
  userNavigated = false
let direction: 'previous' | 'next' = 'next'
let lastScrollTop = 0
let lastScrollHeight = 0

function fail(value: unknown): string {
  return value instanceof Error ? value.message : '调用记录读取失败，请重试。'
}
function alive(token: number): boolean {
  return !disposed && showContent.value && token === generation
}
function current(step: ChatStep): boolean {
  return rows.value.some((row) => row.id === step.id && version(row) === version(step))
}
function data(step: ChatStep): StepDetails | undefined {
  const entry = detail.value
  return entry?.id === step.id && entry.version === version(step) ? entry.value : undefined
}
function scroller(): HTMLElement | null {
  return viewport.value?.closest<HTMLElement>('[data-conversation-scroll]') ?? null
}
function updateRows(): void {
  if (!records) return
  records.merge(props.snapshots)
  rows.value = records.steps
  const ids = new Set(rows.value.map((step) => step.id))
  for (const id of commentVersions.keys()) if (!ids.has(id)) commentVersions.delete(id)
  failures.value = Object.fromEntries(Object.entries(failures.value).filter(([id]) => ids.has(id)))
  if (opened.value && !ids.has(opened.value)) {
    const panel = viewport.value?.querySelector('[data-tool-details]')
    if (panel?.contains(document.activeElement)) viewport.value?.focus({ preventScroll: true })
    opened.value = null
    detail.value = null
  }
  hasPrevious.value = records.hasPrevious
  hasMore.value =
    records.hasMore ||
    props.snapshots.some(
      (step) =>
        step.runId === props.runId &&
        step.conversationId === props.conversationId &&
        step.sequence > records!.nextSequence,
    )
  void hydrateComments()
  void readOpened()
  emit('changed')
}
function anchor(): { id: string; top: number; height: number; scroll: number } | null {
  const root = scroller()
  if (!root || !viewport.value) return null
  const bounds = root.getBoundingClientRect()
  const row = [...viewport.value.querySelectorAll<HTMLElement>('[data-step-id]')].find(
    (element) =>
      !element.querySelector('[data-step-id]') &&
      element.getBoundingClientRect().bottom > bounds.top,
  )
  return row
    ? {
        id: row.dataset.stepId!,
        top: row.getBoundingClientRect().top,
        height: root.scrollHeight,
        scroll: root.scrollTop,
      }
    : null
}
async function restore(saved: ReturnType<typeof anchor>, action: string): Promise<void> {
  await nextTick()
  const root = scroller()
  if (!root) return
  if (props.active && followTail.value) emit('changed')
  else if (saved) {
    const element = [...root.querySelectorAll<HTMLElement>('[data-step-id]')].find(
      (row) => row.dataset.stepId === saved.id,
    )
    if (element) root.scrollTop += element.getBoundingClientRect().top - saved.top
    else if (action === 'previous') root.scrollTop = saved.scroll + root.scrollHeight - saved.height
    lastScrollTop = root.scrollTop
    lastScrollHeight = root.scrollHeight
  }
}
// 由主消息区滚动和不可见边缘触发读取；方向用于防止有界窗口在两端反复切换。
function schedule(): void {
  if (scrollFrame !== undefined || !showContent.value || disposed) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined
    if (loading.value || error.value || !props.connected) return
    if (props.active && !browsingHistory && hasMore.value) {
      void load('next')
      return
    }
    if (direction === 'previous' && userNavigated && nearStart && hasPrevious.value) {
      void load('previous')
      return
    }
    // 折叠的长组最多预取一个窗口，展开或实际滚动后再继续，避免后台扫完整段历史。
    const readingGroup = !!viewport.value?.querySelector(
      '[data-operation-group][data-expanded="true"]',
    )
    const canAdvance =
      rows.value.length < STEP_PAGE_SIZE * 3 ||
      userNavigated ||
      readingGroup ||
      !items.value.some((item) => item.kind === 'operations')
    if (direction === 'next' && nearEnd && hasMore.value && canAdvance) void load('next')
  })
}
function scroll(): void {
  const root = navigationRoot
  if (!root) return
  // 操作组收起会夹紧 scrollTop；布局引起的滚动不能触发历史回读。
  if (
    root.scrollHeight === lastScrollHeight &&
    (!props.active || !followTail.value || browsingHistory)
  ) {
    if (root.scrollTop < lastScrollTop - 1) {
      direction = 'previous'
      userNavigated = true
    } else if (root.scrollTop > lastScrollTop + 1) direction = 'next'
  }
  lastScrollTop = root.scrollTop
  lastScrollHeight = root.scrollHeight
  schedule()
}
function pointerNavigation(): void {
  // 滚动条拖动和触屏阅读同样属于显式用户操作，允许据后续滚动定位历史。
  followTail.value = false
  userNavigated = true
}
function wheel(event: WheelEvent): void {
  if (
    event.target instanceof Element &&
    event.target.closest('.reasoning-scroll, [data-tool-details]')
  )
    return
  if (!event.deltaY) return
  direction = event.deltaY < 0 ? 'previous' : 'next'
  userNavigated = true
  schedule()
}
function key(event: KeyboardEvent): void {
  if (
    event.target instanceof Element &&
    event.target.closest(
      'input, textarea, [contenteditable="true"], .reasoning-scroll, [data-tool-details]',
    )
  )
    return
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) direction = 'previous'
  else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) direction = 'next'
  else return
  userNavigated = true
  schedule()
}
function disconnectNavigation(): void {
  edgeObserver?.disconnect()
  sizeObserver?.disconnect()
  navigationRoot?.removeEventListener('scroll', scroll)
  navigationRoot?.removeEventListener('wheel', wheel)
  navigationRoot?.removeEventListener('pointerdown', pointerNavigation)
  navigationRoot?.removeEventListener('keydown', key)
  navigationRoot = null
  nearStart = nearEnd = false
}
function connectNavigation(): void {
  disconnectNavigation()
  if (!showContent.value || disposed) return
  const root = scroller()
  if (!root || !viewport.value || !beforeRows.value || !afterRows.value) return
  navigationRoot = root
  lastScrollTop = root.scrollTop
  lastScrollHeight = root.scrollHeight
  root.addEventListener('scroll', scroll, { passive: true })
  root.addEventListener('wheel', wheel, { passive: true })
  root.addEventListener('pointerdown', pointerNavigation, { passive: true })
  root.addEventListener('keydown', key)
  edgeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.target === beforeRows.value) nearStart = entry.isIntersecting
        if (entry.target === afterRows.value) nearEnd = entry.isIntersecting
      }
      schedule()
    },
    { root, rootMargin: '120px 0px' },
  )
  edgeObserver.observe(beforeRows.value)
  edgeObserver.observe(afterRows.value)
  sizeObserver = new ResizeObserver(schedule)
  sizeObserver.observe(viewport.value)
  sizeObserver.observe(root)
}
function changed(): void {
  schedule()
  emit('changed')
}
watch([viewport, beforeRows, afterRows], connectNavigation, { flush: 'post' })
async function start(): Promise<void> {
  const token = ++generation
  rows.value = []
  opened.value = null
  detail.value = null
  failures.value = {}
  commentVersions.clear()
  hasMore.value = false
  hasPrevious.value = false
  error.value = ''
  lastAction = 'start'
  followTail.value = props.active
  browsingHistory = false
  direction = 'next'
  userNavigated = false
  records = new TimelineWindow(props.conversationId, props.runId, async (cursor) => {
    if (!alive(token)) throw new Error('调用过程已收起')
    const result = await getDesktopApi().listRunSteps(props.conversationId, props.runId, cursor)
    if (!alive(token)) throw new Error('调用过程已收起')
    if (!result.ok) throw new Error(result.error)
    return result.value
  })
  if (!props.connected) return
  loading.value = true
  try {
    const snapshots = props.snapshots
      .filter((step) => step.runId === props.runId && step.conversationId === props.conversationId)
      .sort((a, b) => a.sequence - b.sequence)
    const cursor =
      props.active && snapshots.length > STEP_PAGE_SIZE
        ? snapshots.at(-STEP_PAGE_SIZE)!.sequence - 1
        : 0
    await records.start(cursor)
    if (!alive(token)) return
    updateRows()
    await restore(null, 'start')
  } catch (value) {
    if (alive(token)) error.value = fail(value)
  } finally {
    if (alive(token)) {
      loading.value = false
      schedule()
    }
  }
}
async function load(action: 'next' | 'previous'): Promise<void> {
  if (loading.value || !records || !showContent.value || !props.connected) return
  if (action === 'previous') browsingHistory = true
  const token = generation
  loading.value = true
  error.value = ''
  lastAction = action
  try {
    const cursor = records.nextSequence
    await records[action]()
    if (!alive(token)) return
    if (action === 'next' && records.nextSequence === cursor && hasMore.value)
      throw new Error('调用记录尚未同步，请重试')
    const saved = anchor()
    updateRows()
    if (action === 'next' && !hasMore.value) browsingHistory = false
    // 历史工具组全部收起时，每次导航只推进一批，避免短页面连续预取越过压缩标记。
    if (
      action === 'next' &&
      (!props.active || browsingHistory) &&
      !viewport.value?.querySelector('[data-operation-group][data-expanded="true"]')
    )
      userNavigated = false
    await restore(saved, action)
  } catch (value) {
    if (alive(token)) error.value = fail(value)
  } finally {
    if (alive(token)) {
      loading.value = false
      schedule()
    }
  }
}
function retry(): void {
  if (lastAction === 'start') void start()
  else void load(lastAction)
}
async function hydrateComments(): Promise<void> {
  if (readingComments || !showContent.value || !props.connected) return
  readingComments = true
  const token = generation
  try {
    for (;;) {
      if (!alive(token) || !props.connected) break
      const step = rows.value.find(
        (row) =>
          row.type === 'model_call' &&
          row.purpose === 'answer' &&
          commentVersions.get(row.id) !== version(row) &&
          !failures.value[row.id],
      )
      if (!step) break
      commentPending.value = step.id
      try {
        const result = await getDesktopApi().getStepDetails(
          props.conversationId,
          props.runId,
          step.id,
        )
        if (!alive(token) || !current(step)) continue
        if (!result.ok) throw new Error(result.error)
        if (
          result.value.id !== step.id ||
          result.value.runId !== props.runId ||
          result.value.conversationId !== props.conversationId
        )
          throw new Error('步骤详情归属不匹配')
        commentVersions.set(step.id, version(step))
        records?.setText(step.id, result.value.text ?? '', result.value.textTruncated)
        records?.setReasoning(
          step.id,
          result.value.reasoning ?? '',
          result.value.reasoningTruncated ?? false,
        )
        updateRows()
      } catch (value) {
        if (alive(token) && current(step)) failures.value[step.id] = fail(value)
      }
    }
  } finally {
    readingComments = false
    commentPending.value = null
    if (!disposed && showContent.value && token !== generation) void hydrateComments()
  }
}
async function readOpened(): Promise<void> {
  const step = rows.value.find((row) => row.id === opened.value)
  if (
    !step ||
    disposed ||
    !showContent.value ||
    readingDetail ||
    !props.connected ||
    data(step) ||
    failures.value[step.id]
  )
    return
  const token = generation
  readingDetail = true
  detailPending.value = step.id
  try {
    const result = await getDesktopApi().getStepDetails(props.conversationId, props.runId, step.id)
    if (!alive(token) || opened.value !== step.id || !current(step)) return
    if (!result.ok) throw new Error(result.error)
    if (
      result.value.id !== step.id ||
      result.value.runId !== props.runId ||
      result.value.conversationId !== props.conversationId
    )
      throw new Error('步骤详情归属不匹配')
    detail.value = { id: step.id, version: version(step), value: result.value }
    emit('changed')
  } catch (value) {
    if (alive(token) && opened.value === step.id && current(step))
      failures.value[step.id] = fail(value)
  } finally {
    readingDetail = false
    detailPending.value = null
    if (!disposed && showContent.value) void readOpened()
  }
}
function refresh(step: ChatStep): void {
  delete failures.value[step.id]
  if (step.type === 'model_call') {
    commentVersions.delete(step.id)
    void hydrateComments()
  } else {
    detail.value = null
    void readOpened()
  }
}
function toggleExpanded(): void {
  inspect()
  emit('expand', !props.expanded)
}
function toggle(step: ChatStep): void {
  inspect()
  if (opened.value === step.id) opened.value = null
  else {
    opened.value = step.id
    detail.value = null
    void readOpened()
  }
  emit('changed')
}
function inspect(): void {
  followTail.value = false
  emit('inspect')
}
function clearToolDetail(step: ChatStep): void {
  if (opened.value !== step.id && detail.value?.id === step.id) detail.value = null
}
function closeGroup(steps: ChatStep[]): void {
  if (steps.some((step) => step.id === opened.value)) {
    opened.value = null
    detail.value = null
  }
}
function release(): void {
  if (showContent.value) return
  records = undefined
  rows.value = []
  detail.value = null
  opened.value = null
  failures.value = {}
  commentVersions.clear()
  hasMore.value = false
  hasPrevious.value = false
}
watch(
  () => props.snapshots,
  () => {
    if (!showContent.value || !records) return
    updateRows()
    if (props.active && followTail.value)
      void nextTick(() => {
        emit('changed')
      })
    schedule()
  },
)
watch(
  showContent,
  (visible) => {
    if (visible) {
      void start()
      void nextTick(connectNavigation)
    } else {
      // 立即废弃异步回调，但把当前视图保留到收起动画结束后再释放。
      generation++
      loading.value = false
      disconnectNavigation()
    }
  },
  { immediate: true },
)
watch(
  () => props.connected,
  (connected) => {
    if (connected && showContent.value) void start()
  },
)
onScopeDispose(() => {
  disposed = true
  disconnectNavigation()
  generation++
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
})
</script>

<template>
  <section
    class="activity-run mb-3"
    :class="{ 'activity-run-ended': !active }"
    aria-label="调用过程"
  >
    <ActivityDisclosure
      :expanded="showContent"
      :collapsible="!active"
      :header-separator="true"
      aria-label="调用过程"
      content-label="过程概述"
      @toggle="toggleExpanded"
      @changed="changed"
      @collapsed="release"
    >
      <template #label>
        <RunStatus v-if="run" :run="run" :connected="connected" />
        <span v-else>处理过程</span>
      </template>
      <div
        ref="viewport"
        tabindex="-1"
        class="activity-rows"
        :aria-busy="loading"
        @pointerdown="inspect"
        @keydown="inspect"
      >
        <p v-if="!connected" class="text-xs text-muted-foreground">
          连接已断开，暂时无法读取更多记录。
        </p>
        <p
          v-if="loading && (!rows.length || lastAction === 'previous')"
          role="status"
          class="text-xs text-muted-foreground"
        >
          正在读取调用记录…
        </p>
        <p v-if="error" role="alert" class="text-xs text-destructive">
          {{ error }}
          <button class="ml-2 underline" :disabled="!connected || loading" @click="retry">
            重试
          </button>
        </p>
        <div ref="beforeRows" class="activity-load-edge" aria-hidden="true" />
        <template v-for="(item, index) in items" :key="item.id">
          <div v-if="item.kind === 'model'" :data-step-id="item.step.id">
            <ReasoningItem
              v-if="item.step.reasoning || item.step.reasoningTruncated"
              :step="item.step"
              :active="active"
              :connected="connected"
              @inspect="inspect"
              @changed="changed"
            />
            <MarkdownMessage
              v-if="item.step.commentary && item.step.text"
              class="activity-commentary"
              :content="[{ type: 'text', text: item.step.text, path: '' }]"
              :streaming="false"
              @rendered="emit('changed')"
            />
            <p v-else-if="commentPending === item.step.id" class="text-xs text-muted-foreground">
              正在读取过程说明…
            </p>
            <p v-if="item.step.textTruncated" class="text-xs text-muted-foreground">
              {{
                item.step.text
                  ? '概述较长，已截取；完整记录保留在服务中。'
                  : '原始结果超过读取范围，过程说明暂无法恢复。'
              }}
            </p>
            <p v-if="failures[item.step.id]" role="alert" class="text-xs text-destructive">
              {{ failures[item.step.id] }}
              <button class="ml-2 underline" :disabled="!connected" @click="refresh(item.step)">
                重试
              </button>
            </p>
          </div>
          <CompactionStatus
            v-else-if="item.kind === 'compaction'"
            :group="item"
            :data-step-id="item.steps[0]?.id"
            :connected="connected"
            :run-status="run?.status ?? null"
          />
          <OperationGroup
            v-else
            :group="item"
            :data-step-id="item.steps[0]?.id"
            :current="item.id === currentGroupId"
            :connected="connected"
            :partial="(index === 0 && hasPrevious) || (index === items.length - 1 && hasMore)"
            @inspect="inspect"
            @changed="changed"
            @closing="closeGroup(item.steps)"
          >
            <ActivityDisclosure
              v-for="step in item.steps"
              :key="step.id"
              :data-step-id="step.id"
              :expanded="opened === step.id"
              :aria-label="`工具详情：${stepLabel(step)}`"
              @toggle="toggle(step)"
              @changed="changed"
              @collapsed="clearToolDetail(step)"
            >
              <template #label>
                <span class="activity-tool-label">
                  <LoaderCircleIcon
                    v-if="['running', 'pending'].includes(step.status) && connected"
                    class="animate-spin"
                    aria-hidden="true"
                  />
                  <TerminalIcon v-else-if="step.name === 'run_command'" aria-hidden="true" />
                  <PencilIcon v-else-if="step.name === 'apply_patch'" aria-hidden="true" />
                  <FileTextIcon v-else aria-hidden="true" />
                  <span
                    class="shrink-0"
                    :class="step.status === 'failed' ? 'text-destructive' : ''"
                    >{{ stepLabel(step) }}</span
                  >
                  <span
                    v-if="step.targetLabel"
                    class="activity-tool-target"
                    :title="step.targetLabel"
                    >{{ step.targetLabel }}</span
                  >
                </span>
              </template>
              <div data-tool-details class="activity-tool-details space-y-2">
                <p
                  v-if="
                    !connected &&
                    ['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(
                      step.status,
                    )
                  "
                  class="text-muted-foreground"
                >
                  连接已断开，步骤状态待核对。
                </p>
                <p v-if="step.error" class="text-destructive">{{ step.error }}</p>
                <p v-if="data(step)" class="font-medium">目标与参数</p>
                <pre
                  v-if="data(step)"
                  class="max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  >{{ stepParameters(data(step)!.input) }}</pre>
                <p v-if="data(step)?.inputTruncated" class="text-muted-foreground">
                  参数超过展示范围，已截取；完整记录保留在服务中。
                </p>
                <template v-if="live?.output">
                  <p class="font-medium">实时输出</p>
                  <pre
                    class="max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    >{{ live?.output }}</pre>
                  <p v-if="live?.outputTruncated" class="text-muted-foreground">
                    实时输出有截取或缺失，请核对最终结果。
                  </p>
                </template>
                <p v-if="detailPending === step.id" role="status" class="text-muted-foreground">
                  正在读取结果…
                </p>
                <p v-if="failures[step.id]" role="alert" class="text-destructive">
                  {{ failures[step.id] }}
                </p>
                <template v-if="data(step)">
                  <p class="font-medium">已保存的结果</p>
                  <p v-if="savedResult.outcome" class="text-muted-foreground">
                    {{ savedResult.outcome }}
                  </p>
                  <p
                    v-if="savedResult.exitCode !== null"
                    :class="savedResult.exitCode ? 'text-destructive' : 'text-muted-foreground'"
                  >
                    退出码：{{ savedResult.exitCode }}
                  </p>
                  <pre
                    v-if="data(step)?.output"
                    aria-label="工具结果"
                    class="max-h-80 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    >{{ savedResult.text }}</pre>
                  <p v-else class="text-muted-foreground">尚无已保存的结果。</p>
                  <p v-if="data(step)?.outputTruncated" class="text-muted-foreground">
                    结果超过展示范围，已截取；完整记录保留在服务中。
                  </p>
                </template>
                <details v-if="data(step)" class="text-muted-foreground">
                  <summary class="cursor-pointer py-1">原始记录</summary>
                  <pre
                    class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    >{{ data(step)?.input }}</pre>
                  <pre
                    v-if="data(step)?.output"
                    class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    >{{ data(step)?.output }}</pre>
                </details>
                <button
                  class="underline disabled:opacity-50"
                  :disabled="!connected || detailPending === step.id"
                  @click="refresh(step)"
                >
                  刷新结果
                </button>
              </div>
            </ActivityDisclosure>
          </OperationGroup>
        </template>
        <div ref="afterRows" class="activity-load-edge" aria-hidden="true" />
        <p
          v-if="connected && !active && !loading && !error && !visible.length"
          class="text-xs text-muted-foreground"
        >
          当前没有工具调用记录。
        </p>
        <p
          v-if="loading && rows.length && lastAction === 'next'"
          role="status"
          class="text-xs text-muted-foreground"
        >
          正在读取调用记录…
        </p>
      </div>
    </ActivityDisclosure>
  </section>
</template>
