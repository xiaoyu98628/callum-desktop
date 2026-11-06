<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import {
  ChevronDownIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PencilIcon,
  TerminalIcon,
} from '@lucide/vue'
import type { ChatStep, StepDetails } from '@shared/chat'
import { STEP_PAGE_SIZE, stepLabel, stepParameters, stepResult } from '@shared/steps'
import { TimelineWindow } from '@shared/timeline-window'
import type { TimelineStep } from '@shared/timeline-window'
import { getDesktopApi } from '@/lib/desktop'
import MarkdownMessage from './MarkdownMessage.vue'

const props = defineProps<{
  conversationId: string
  runId: string
  snapshots: ChatStep[]
  connected: boolean
  expanded: boolean
  active: boolean
}>()
const emit = defineEmits<{ changed: []; inspect: []; expand: [value: boolean] }>()
const trigger = ref<HTMLButtonElement | null>(null)
const viewport = ref<HTMLElement | null>(null)
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
        step.commentary &&
        (step.text ||
          step.textTruncated ||
          commentVersions.get(step.id) !== version(step) ||
          failures.value[step.id])),
  ),
)
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
let lastTop = 0,
  direction: 'up' | 'down' = 'down'
let lastAction: 'start' | 'next' | 'previous' = 'start'

function fail(value: unknown): string {
  return value instanceof Error ? value.message : '调用记录读取失败，请重试。'
}
function alive(token: number): boolean {
  return !disposed && props.expanded && token === generation
}
function current(step: ChatStep): boolean {
  return rows.value.some((row) => row.id === step.id && version(row) === version(step))
}
function data(step: ChatStep): StepDetails | undefined {
  const entry = detail.value
  return entry?.id === step.id && entry.version === version(step) ? entry.value : undefined
}
function setScroll(top: number): void {
  if (!viewport.value) return
  viewport.value.scrollTop = top
  lastTop = viewport.value.scrollTop
}
function focusBeforeHiding(): void {
  if (viewport.value?.contains(document.activeElement))
    trigger.value?.focus({ preventScroll: true })
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
  const root = viewport.value
  if (!root) return null
  const bounds = root.getBoundingClientRect()
  const row = [...root.querySelectorAll<HTMLElement>('[data-step-id]')].find(
    (element) => element.getBoundingClientRect().bottom > bounds.top,
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
  const root = viewport.value
  if (!root) return
  if (props.active && followTail.value) setScroll(root.scrollHeight)
  else if (saved) {
    const element = [...root.querySelectorAll<HTMLElement>('[data-step-id]')].find(
      (row) => row.dataset.stepId === saved.id,
    )
    if (element) setScroll(root.scrollTop + element.getBoundingClientRect().top - saved.top)
    else if (action === 'previous') setScroll(saved.scroll + root.scrollHeight - saved.height)
  }
}
function schedule(): void {
  if (scrollFrame !== undefined || !props.expanded || disposed) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined
    const root = viewport.value
    if (!root || loading.value || error.value || !props.connected) return
    const bottom = root.scrollHeight - root.scrollTop - root.clientHeight
    if (props.active && followTail.value && hasMore.value) void load('next')
    else if (
      root.scrollTop < 60 &&
      hasPrevious.value &&
      (direction === 'up' || root.scrollHeight <= root.clientHeight + 2)
    )
      void load('previous')
    else if (bottom < 80 && hasMore.value) void load('next')
  })
}
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
  direction = 'down'
  lastTop = 0
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
  if (loading.value || !records || !props.expanded || !props.connected) return
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
  if (readingComments || !props.expanded || !props.connected) return
  readingComments = true
  const token = generation
  try {
    for (;;) {
      if (!alive(token) || !props.connected) break
      const step = rows.value.find(
        (row) =>
          row.type === 'model_call' &&
          row.commentary &&
          row.purpose === 'answer' &&
          !row.text &&
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
        updateRows()
      } catch (value) {
        if (alive(token) && current(step)) failures.value[step.id] = fail(value)
      }
    }
  } finally {
    readingComments = false
    commentPending.value = null
    if (!disposed && props.expanded && token !== generation) void hydrateComments()
  }
}
async function readOpened(): Promise<void> {
  const step = rows.value.find((row) => row.id === opened.value)
  if (
    !step ||
    disposed ||
    !props.expanded ||
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
    if (!disposed && props.expanded) void readOpened()
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
  emit('inspect')
  emit('expand', !props.expanded)
}
function toggle(step: ChatStep, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLDetailsElement) || target !== event.currentTarget) return
  if (target.open) {
    opened.value = step.id
    detail.value = null
    followTail.value = false
    emit('inspect')
    void readOpened()
  } else if (opened.value === step.id) {
    opened.value = null
    detail.value = null
  }
  emit('changed')
}
function inspect(): void {
  followTail.value = false
  emit('inspect')
}
function scroll(): void {
  const root = viewport.value
  if (!root) return
  if (root.scrollTop !== lastTop) {
    direction = root.scrollTop < lastTop ? 'up' : 'down'
    lastTop = root.scrollTop
    followTail.value = props.active && root.scrollHeight - root.scrollTop - root.clientHeight < 60
    emit('inspect')
  }
  schedule()
}
function wheel(event: WheelEvent): void {
  inspect()
  direction = event.deltaY < 0 ? 'up' : 'down'
  schedule()
}
watch(
  () => props.snapshots,
  () => {
    if (!props.expanded || !records) return
    updateRows()
    if (props.active && followTail.value)
      void nextTick(() => {
        if (viewport.value) setScroll(viewport.value.scrollHeight)
      })
    schedule()
  },
)
watch(
  () => props.expanded,
  (expanded) => {
    if (expanded) void start()
    else {
      focusBeforeHiding()
      generation++
      loading.value = false
      records = undefined
      rows.value = []
      detail.value = null
      opened.value = null
      failures.value = {}
      commentVersions.clear()
      hasMore.value = false
      hasPrevious.value = false
    }
  },
  { immediate: true },
)
watch(
  () => props.connected,
  (connected) => {
    if (connected && props.expanded) void start()
  },
)
onScopeDispose(() => {
  disposed = true
  generation++
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
})
</script>

<template>
  <section class="mb-3 text-sm" aria-label="调用过程">
    <button
      ref="trigger"
      aria-label="调用过程"
      class="inline-flex items-center gap-1.5 rounded py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <ChevronDownIcon
        class="size-3.5 transition-transform"
        :class="expanded ? '' : '-rotate-90'"
      />
      调用过程
    </button>
    <div
      v-if="expanded"
      ref="viewport"
      role="region"
      aria-label="过程概述"
      tabindex="0"
      class="mt-2 max-h-[min(32rem,60vh)] space-y-3 overflow-y-auto overscroll-contain pr-2 focus-visible:outline-2"
      :aria-busy="loading"
      @scroll="scroll"
      @wheel.passive="wheel"
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
      <template v-for="step in visible" :key="step.id">
        <div v-if="step.type === 'model_call'" :data-step-id="step.id">
          <MarkdownMessage
            v-if="step.text"
            :content="[{ type: 'text', text: step.text, path: '' }]"
            :streaming="false"
            @rendered="emit('changed')"
          />
          <p v-else-if="commentPending === step.id" class="text-xs text-muted-foreground">
            正在读取过程说明…
          </p>
          <p v-if="step.textTruncated" class="text-xs text-muted-foreground">
            {{
              step.text
                ? '概述较长，已截取；完整记录保留在服务中。'
                : '原始结果超过读取范围，过程说明暂无法恢复。'
            }}
          </p>
          <p v-if="failures[step.id]" role="alert" class="text-xs text-destructive">
            {{ failures[step.id] }}
            <button class="ml-2 underline" :disabled="!connected" @click="refresh(step)">
              重试
            </button>
          </p>
        </div>
        <details
          v-else
          :data-step-id="step.id"
          :open="opened === step.id"
          class="group min-w-0"
          @toggle="toggle(step, $event)"
        >
          <summary
            class="flex cursor-pointer list-none items-center gap-1.5 rounded py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2"
          >
            <ChevronDownIcon
              class="size-3 shrink-0 transition-transform"
              :class="opened === step.id ? '' : '-rotate-90'"
              aria-hidden="true"
            />
            <LoaderCircleIcon
              v-if="['running', 'pending'].includes(step.status) && connected"
              class="size-3.5 shrink-0 animate-spin"
            />
            <TerminalIcon v-else-if="step.name === 'run_command'" class="size-3.5 shrink-0" />
            <PencilIcon v-else-if="step.name === 'apply_patch'" class="size-3.5 shrink-0" />
            <FileTextIcon v-else class="size-3.5 shrink-0" />
            <span class="shrink-0" :class="step.status === 'failed' ? 'text-destructive' : ''">{{
              stepLabel(step)
            }}</span>
            <span v-if="step.targetLabel" class="min-w-0 truncate" :title="step.targetLabel">{{
              step.targetLabel
            }}</span>
          </summary>
          <div
            v-if="opened === step.id"
            data-tool-details
            class="mt-2 min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3 text-xs"
          >
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
        </details>
      </template>
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
  </section>
</template>
