<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import {
  ChevronDownIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PencilIcon,
  TerminalIcon,
} from '@lucide/vue'
import type { ChatStep, StepDetails } from '@shared/chat'
import { STEP_PAGE_SIZE, stepLabel, stepTarget, stepParameters, stepResult } from '@shared/steps'
import { getDesktopApi } from '@/lib/desktop'
import MarkdownMessage from './MarkdownMessage.vue'

const props = defineProps<{
  conversationId: string
  runId: string
  snapshots: ChatStep[]
  connected: boolean
  expanded: boolean
}>()
const emit = defineEmits<{ changed: []; inspect: []; expand: [value: boolean] }>()
const rows = shallowRef<ChatStep[]>([])
const loading = ref(false)
const error = ref('')
const after = ref(0)
const hasMore = ref(false)
const previous = ref<number[]>([])
const details = shallowRef<Record<string, { version: string; value: StepDetails }>>({})
const failures = ref<Record<string, string>>({})
const opened = ref<Record<string, boolean>>({})
const pending = ref<Record<string, string>>({})
const outputs = computed(() =>
  Object.fromEntries(
    Object.entries(details.value).map(([id, entry]) => [id, stepResult(entry.value.output)]),
  ),
)
const emptyOutput = { text: '', outcome: '', exitCode: null }
function result(step: ChatStep): ReturnType<typeof stepResult> {
  return data(step) ? (outputs.value[step.id] ?? emptyOutput) : emptyOutput
}

let generation = 0
let disposed = false
const version = (step: ChatStep): string => `${step.status}:${step.updatedAt}`
const visible = computed(() =>
  rows.value.filter(
    (step) =>
      step.type !== 'model_call' ||
      (step.purpose === 'answer' &&
        step.commentary &&
        (step.text || step.textTruncated || !details.value[step.id] || failures.value[step.id])),
  ),
)
function fail(value: unknown): string {
  return value instanceof Error ? value.message : '步骤读取失败，请重试。'
}
function mergeSnapshots(): void {
  if (!props.expanded || loading.value) return
  const merged = new Map(rows.value.map((step) => [step.id, step]))
  const end = rows.value.at(-1)?.sequence ?? after.value
  for (const live of props.snapshots) {
    if (
      live.runId !== props.runId ||
      live.conversationId !== props.conversationId ||
      live.sequence <= after.value ||
      (hasMore.value && live.sequence > end)
    )
      continue
    const old = merged.get(live.id)
    if (old && old.updatedAt > live.updatedAt) continue
    merged.set(live.id, {
      ...live,
      text: live.text || old?.text || '',
      commentary: live.commentary || old?.commentary || false,
      textTruncated: live.textTruncated || old?.textTruncated || false,
    })
  }
  const sorted = [...merged.values()].sort((a, b) => a.sequence - b.sequence)
  if (sorted.length > STEP_PAGE_SIZE) hasMore.value = true
  rows.value = sorted.slice(0, STEP_PAGE_SIZE)
  hydrate()
  emit('changed')
}
async function load(cursor = after.value): Promise<boolean> {
  const token = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await getDesktopApi().listRunSteps(props.conversationId, props.runId, cursor)
    if (disposed || token !== generation) return false
    if (!result.ok) throw new Error(result.error)
    if (
      result.value.afterSequence !== cursor ||
      result.value.steps.some(
        (step) => step.runId !== props.runId || step.conversationId !== props.conversationId,
      )
    )
      throw new Error('步骤归属不匹配')
    rows.value = result.value.steps
    after.value = cursor
    hasMore.value = result.value.hasMore
    details.value = {}
    failures.value = {}
    opened.value = {}
    pending.value = {}
    return true
  } catch (value) {
    if (token === generation) error.value = fail(value)
    return false
  } finally {
    if (token === generation) {
      loading.value = false
      mergeSnapshots()
    }
  }
}
async function read(step: ChatStep): Promise<void> {
  const stamp = version(step)
  if (pending.value[step.id] === stamp || details.value[step.id]?.version === stamp) return
  const token = generation
  pending.value[step.id] = stamp
  delete failures.value[step.id]
  try {
    const result = await getDesktopApi().getStepDetails(props.conversationId, props.runId, step.id)
    if (
      disposed ||
      token !== generation ||
      !rows.value.some((row) => row.id === step.id && version(row) === stamp)
    )
      return
    if (!result.ok) throw new Error(result.error)
    const data = result.value
    if (
      data.id !== step.id ||
      data.runId !== props.runId ||
      data.conversationId !== props.conversationId
    )
      throw new Error('步骤详情归属不匹配')
    details.value = { ...details.value, [step.id]: { version: stamp, value: data } }
    if (step.type === 'model_call' && data.text !== null)
      rows.value = rows.value.map((row) =>
        row.id === step.id
          ? { ...row, text: data.text ?? row.text, textTruncated: data.textTruncated }
          : row,
      )
    emit('changed')
  } catch (value) {
    if (!disposed && token === generation) failures.value[step.id] = fail(value)
  } finally {
    if (token === generation && pending.value[step.id] === stamp) delete pending.value[step.id]
  }
}
// 历史过程文字串行读取；工具详情只在展开时查询，不预读整份模型原始响应。
let hydrating = false
async function hydrate(): Promise<void> {
  if (hydrating) return
  hydrating = true
  const token = generation
  try {
    for (const step of rows.value) {
      if (disposed || !props.expanded || token !== generation) break
      if (
        step.type === 'model_call' &&
        step.commentary &&
        step.purpose === 'answer' &&
        !step.text &&
        !failures.value[step.id]
      )
        await read(step)
      else if (opened.value[step.id] && !failures.value[step.id]) await read(step)
    }
  } finally {
    hydrating = false
    if (!disposed && props.expanded && token !== generation) void hydrate()
  }
}
function toggleExpanded(): void {
  emit('inspect')
  emit('expand', !props.expanded)
}
function toggle(step: ChatStep, event: Event): void {
  if (!(event.target instanceof HTMLDetailsElement)) return
  opened.value[step.id] = event.target.open
  if (event.target.open) {
    emit('inspect')
    void read(step)
  }
  emit('changed')
}
function refresh(step: ChatStep): void {
  const next = { ...details.value }
  delete next[step.id]
  details.value = next
  void read(step)
}
function data(step: ChatStep): StepDetails | undefined {
  const entry = details.value[step.id]
  return entry?.version === version(step) ? entry.value : undefined
}
async function next(): Promise<void> {
  emit('inspect')
  const cursor = rows.value.at(-1)?.sequence
  if (!cursor) return
  const old = after.value
  if (await load(cursor)) previous.value = [...previous.value, old].slice(-128)
}
async function restart(): Promise<void> {
  emit('inspect')
  if (await load(0)) previous.value = []
}
async function back(): Promise<void> {
  emit('inspect')
  const cursor = previous.value.at(-1) ?? 0
  if (await load(cursor)) previous.value = previous.value.slice(0, -1)
}
watch(() => props.snapshots, mergeSnapshots)
watch(
  () => props.expanded,
  (expanded) => {
    if (expanded) void load(0)
    else {
      generation++
      loading.value = false
      rows.value = []
      details.value = {}
      failures.value = {}
      pending.value = {}
      opened.value = {}
      previous.value = []
      after.value = 0
      hasMore.value = false
    }
  },
  { immediate: true },
)
watch(
  () => props.connected,
  (connected) => {
    if (connected && props.expanded) void load()
  },
)
onScopeDispose(() => {
  disposed = true
  generation++
})
</script>

<template>
  <section class="mb-3 text-sm" aria-label="调用过程">
    <button
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
    <div v-if="expanded" class="mt-2 space-y-3">
      <p v-if="loading" role="status" class="text-xs text-muted-foreground">正在读取调用步骤…</p>
      <p v-if="error" role="alert" class="text-xs text-destructive">
        {{ error }}
        <button class="ml-2 underline" :disabled="!connected || loading" @click="load()">
          重试
        </button>
      </p>
      <template v-for="step in visible" :key="step.id">
        <div v-if="step.type === 'model_call'">
          <MarkdownMessage
            v-if="step.text"
            :content="[{ type: 'text', text: step.text, path: '' }]"
            :streaming="false"
            @rendered="emit('changed')"
          />
          <p v-else-if="pending[step.id]" class="text-xs text-muted-foreground">
            正在读取过程说明…
          </p>
          <p v-if="step.textTruncated" class="text-xs text-muted-foreground">
            {{
              step.text
                ? '过程说明超过展示范围，已截取；完整记录保留在服务中。'
                : '原始结果超过读取范围，过程说明暂无法恢复。'
            }}
          </p>
          <p v-if="failures[step.id]" role="alert" class="text-xs text-destructive">
            {{ failures[step.id] }}
            <button class="ml-2 underline" :disabled="!connected" @click="read(step)">重试</button>
          </p>
        </div>
        <details v-else class="group min-w-0" @toggle="toggle(step, $event)">
          <summary
            class="flex cursor-pointer list-none items-center gap-1.5 rounded py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2"
          >
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
            <span class="min-w-0 truncate" :title="stepTarget(step)">{{ stepTarget(step) }}</span>
          </summary>
          <div class="mt-2 min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3 text-xs">
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
            <p class="font-medium">目标与参数</p>
            <pre
              class="max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              >{{ stepParameters(step.input) }}</pre>
            <p v-if="step.inputTruncated" class="text-muted-foreground">
              参数超过展示范围，已截取；完整记录保留在服务中。
            </p>
            <template v-if="step.output">
              <p class="font-medium">实时输出</p>
              <pre
                class="max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                >{{ step.output }}</pre>
              <p v-if="step.outputTruncated" class="text-muted-foreground">
                实时输出有截取或缺失，请核对最终结果。
              </p>
            </template>
            <p v-if="pending[step.id]" role="status" class="text-muted-foreground">正在读取结果…</p>
            <p v-if="failures[step.id]" role="alert" class="text-destructive">
              {{ failures[step.id] }}
            </p>
            <template v-if="data(step)">
              <p class="font-medium">已保存的结果</p>
              <p v-if="result(step).outcome" class="text-muted-foreground">
                {{ result(step).outcome }}
              </p>
              <p
                v-if="result(step).exitCode !== null"
                :class="result(step).exitCode ? 'text-destructive' : 'text-muted-foreground'"
              >
                退出码：{{ result(step).exitCode }}
              </p>
              <pre
                v-if="data(step)?.output"
                aria-label="工具结果"
                class="max-h-80 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                >{{ result(step).text }}</pre>
              <p v-else class="text-muted-foreground">尚无已保存的结果。</p>
              <p v-if="data(step)?.outputTruncated" class="text-muted-foreground">
                结果超过展示范围，已截取；完整记录保留在服务中。
              </p>
            </template>
            <details class="text-muted-foreground">
              <summary class="cursor-pointer py-1">原始记录</summary>
              <pre
                class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                >{{ step.input }}</pre>
              <pre
                v-if="data(step)?.output"
                class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                >{{ data(step)?.output }}</pre>
            </details>
            <button
              class="underline disabled:opacity-50"
              :disabled="!connected || !!pending[step.id]"
              @click="refresh(step)"
            >
              刷新结果
            </button>
          </div>
        </details>
      </template>
      <p v-if="!loading && !error && !visible.length" class="text-xs text-muted-foreground">
        当前没有工具调用记录。
      </p>
      <div v-if="after || hasMore" class="flex gap-3 text-xs text-muted-foreground">
        <button
          :disabled="loading || !connected || !after"
          class="underline disabled:opacity-50"
          @click="back"
        >
          较早步骤
        </button>
        <button
          :disabled="loading || !connected || !hasMore"
          class="underline disabled:opacity-50"
          @click="next"
        >
          后续步骤
        </button>
        <button
          v-if="after"
          :disabled="loading || !connected"
          class="underline disabled:opacity-50"
          @click="restart"
        >
          从头查看
        </button>
      </div>
    </div>
  </section>
</template>
