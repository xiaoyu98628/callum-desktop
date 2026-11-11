<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, provide, ref, watch } from 'vue'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LaptopIcon,
  LoaderCircleIcon,
  SparklesIcon,
  SquareIcon,
} from '@lucide/vue'
import { isActiveRun, MAX_MESSAGE_LENGTH } from '@shared/chat'
import {
  isCompactCommand,
  matchesCompactCommand,
  messageCompactions,
} from '@shared/manual-compaction'
import type { ApprovalScope, ChatMessage, ChatRun } from '@shared/chat'
import { Button } from '@/components/ui/button'
import { getDesktopApi } from '@/lib/desktop'
import { useConversations } from './useConversations'
import { useContextUsage } from './useContextUsage'
import ModelSelector from './ModelSelector.vue'
import ProjectSelector from './ProjectSelector.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import RunTimeline from './RunTimeline.vue'
import ApprovalComposer from './ApprovalComposer.vue'
import UserInputCard from './UserInputCard.vue'
import MessageActions from './MessageActions.vue'
import MessageEditor from './MessageEditor.vue'
import AttachmentPicker from './AttachmentPicker.vue'
import AttachmentList from './AttachmentList.vue'
import { dragFiles, dropFiles, pasteFiles } from './attachment-files'
import type { AttachmentItem } from './attachment-files'
import { AttachmentPreviews, attachmentPreviewsKey } from './attachment-previews'
import ContextUsageControl from './ContextUsageControl.vue'
import ApprovalModeSelector from './ApprovalModeSelector.vue'
import ComposerCommands from './ComposerCommands.vue'
import type { ContextUsageInput } from '@shared/context-usage'
import ManualCompactionStatus from './ManualCompactionStatus.vue'
defineEmits<{ configureModels: [] }>()

const {
  state,
  draft,
  draftAttachments,
  imageInput,
  addAttachments,
  removeAttachment,
  workspace,
  activeRun,
  compactUnavailable,
  compact,
  lastUserMessage,
  editUnavailable,
  startEditing,
  cancelEditing,
  resend,
  pendingApprovals,
  pendingInputs,
  inputReply,
  setInputReply,
  submitInput,
  setCardCollapsed,
  refreshOverview,
  refreshModels,
  send,
  cancel,
  decide,
  openConversation,
  earlier,
} = useConversations()
const messages = computed(() => state.detail?.messages ?? [])
const previews = new AttachmentPreviews(async (item) => {
  const api = getDesktopApi()
  const result =
    item.source instanceof File
      ? await api.previewDraftAttachment({ bytes: new Uint8Array(await item.source.arrayBuffer()) })
      : await api.previewAttachment(item.source)
  if (!result.ok) throw new Error(result.error)
  return result.value
})
provide(attachmentPreviewsKey, previews)
watch(
  () => state.selectedId,
  () => previews.clear(),
  { flush: 'sync' },
)
onScopeDispose(() => previews.close())
const draftItems = computed<AttachmentItem[]>(() =>
  draftAttachments.value.map((file) => ({ label: file.name || '粘贴的图片', source: file })),
)
function historyAttachment(item: ChatMessage, index: number): AttachmentItem {
  return {
    key: `history:${item.conversationId}/${item.id}/${item.runId}/${index}`,
    label: `图片 ${item.content.slice(0, index + 1).filter((block) => block.type === 'image').length}`,
    source: { conversationId: item.conversationId, messageId: item.id, index },
  }
}
const historyImages = computed(
  () =>
    new Map(
      messages.value
        .filter((item) => item.role === 'user')
        .map((item) => [
          item.id,
          item.content.flatMap((block, index) =>
            block.type === 'image' ? [historyAttachment(item, index)] : [],
          ),
        ]),
    ),
)
const editItems = computed<AttachmentItem[]>(() => {
  const edit = state.editing
  const message = lastUserMessage.value
  if (!edit || !message || message.id !== edit.messageId) return []
  return [
    ...edit.retainedAttachments.map((index) => historyAttachment(message, index)),
    ...edit.files.map((file) => ({ label: file.name || '粘贴的图片', source: file })),
  ]
})
const messageTimeline = computed(() => {
  const runs = state.detail?.runs ?? []
  const ids = runs.map((run) => run.id).toSorted()
  return messageCompactions(
    messages.value,
    runs,
    ids.length ? { oldestRunId: ids[0]!, newestRunId: ids.at(-1)! } : undefined,
  )
})
const approvals = computed(() =>
  pendingApprovals.value.filter((item) => item.conversationId === state.selectedId),
)
const currentApproval = computed(() => approvals.value[0] ?? null)
const currentInput = computed(
  () => pendingInputs.value.find((item) => item.conversationId === state.selectedId) ?? null,
)
const currentInteraction = computed(
  () => currentApproval.value?.id ?? currentInput.value?.id ?? null,
)
const inputUnavailable = computed(
  () =>
    state.loading ||
    state.loadingList ||
    !!state.serviceError ||
    !activeRun.value ||
    activeRun.value.id !== currentInput.value?.runId,
)
const inputError = computed(
  () =>
    state.serviceError ||
    state.modelError ||
    state.error ||
    (currentInput.value && !state.loading && activeRun.value?.id !== currentInput.value.runId
      ? '执行状态已变化，请重新加载问题后核对。'
      : ''),
)
const approvalUnavailable = computed(
  () =>
    state.loading ||
    state.loadingList ||
    !!state.serviceError ||
    !activeRun.value ||
    activeRun.value.id !== currentApproval.value?.runId,
)
const approvalError = computed(
  () =>
    state.serviceError ||
    state.modelError ||
    state.error ||
    (currentApproval.value && !state.loading && activeRun.value?.id !== currentApproval.value.runId
      ? '执行状态已变化，请重新加载审批后核对。'
      : ''),
)
const messageRuns = computed(() => {
  const runs = new Map(state.detail?.runs.map((run) => [run.id, run]))
  const shown = new Set<string>()
  const result = new Map<string, ChatRun>()
  for (const item of messages.value) {
    if (item.role !== 'assistant' || shown.has(item.runId)) continue
    shown.add(item.runId)
    const run = runs.get(item.runId)
    if (run) result.set(item.id, run)
  }
  return result
})
const scroller = ref<HTMLElement | null>(null)
const messageTimeNow = ref(Date.now())
let messageTimeTimer: number | undefined
const composer = ref<HTMLElement | null>(null)
const scrollbarVisible = ref(false)
let scrollbarTimer: number | undefined
const messageInput = ref<HTMLTextAreaElement | null>(null)
const commandInputFocused = ref(false)
const commandsDismissed = ref(false)
const commandsOpen = computed(
  () =>
    commandInputFocused.value &&
    !commandsDismissed.value &&
    !draftItems.value.length &&
    matchesCompactCommand(draft.value),
)
const requestingCompact = computed(
  () => !draftItems.value.length && (isCompactCommand(draft.value) || commandsOpen.value),
)
const usageInput = computed<ContextUsageInput | null>(() =>
  state.loading || state.modelsLoading || !state.modelId
    ? null
    : {
        conversationId: state.selectedId,
        workspaceId: state.selectedId ? null : state.workspaceId,
        modelId: state.modelId,
        draft: requestingCompact.value ? '' : draft.value,
        ...(draftItems.value.length ? { draftImages: draftItems.value.length } : {}),
      },
)
const usageHintOpen = ref(false)
const {
  value: contextUsage,
  error: contextUsageError,
  loading: contextUsageLoading,
} = useContextUsage(
  usageInput,
  computed(() => state.contextUsageEvent),
  computed(() => state.usageActivityRevision),
  computed(() => state.serviceError),
  computed(() => usageHintOpen.value || commandsOpen.value),
)
const displayedUsage = computed(() =>
  state.serviceError || contextUsageError.value ? null : contextUsage.value,
)
const reviewing = computed(
  () =>
    activeRun.value &&
    state.detail?.steps.some(
      (step) =>
        step.runId === activeRun.value?.id &&
        step.purpose === 'approval_review' &&
        step.status === 'running',
    ),
)
const compactingRun = computed(() => !!activeRun.value?.compaction)
const stopLabel = computed(() => (compactingRun.value ? '停止压缩' : '停止生成'))
let inputResizeObserver: ResizeObserver | undefined
let inputResizeFrame: number | undefined
let conversationResizeObserver: ResizeObserver | undefined
const follow = ref(true)
const awayFromLatest = ref(false)
const showLoadingMessages = computed(() => state.loading && (!state.detail || !state.sending))
const canReturnToLatest = computed(
  () =>
    !!state.selectedId &&
    !state.loading &&
    (state.historical || (!follow.value && awayFromLatest.value)),
)
const showRunningIndicator = computed(
  () =>
    !state.loading &&
    !state.serviceError &&
    (activeRun.value?.status === 'pending' || activeRun.value?.status === 'running'),
)
const availableModel = computed(() => state.models.some((item) => item.id === state.modelId))
const composerNotice = computed(() =>
  state.loadingList || state.modelsLoading
    ? '正在读取模型…'
    : !state.models.length && !state.serviceError
      ? '尚未配置可用模型，配置完成后即可开始对话。'
      : '',
)
const attachmentBusy = computed(
  () =>
    state.loading ||
    state.sending ||
    state.resending ||
    !!state.editing ||
    !!state.compacting ||
    !!currentInteraction.value ||
    !!state.serviceError ||
    state.modelsLoading ||
    !!state.modelError,
)
function receiveFiles(files: File[]): void {
  if (!attachmentBusy.value) addAttachments(files)
}
const canSend = computed(
  () =>
    !state.loading &&
    !state.loadingList &&
    !state.executionSettingsSaving &&
    !state.sending &&
    !state.resending &&
    !state.compacting &&
    !state.editing &&
    !activeRun.value &&
    !currentInteraction.value &&
    !state.serviceError &&
    !state.modelsLoading &&
    !state.modelError &&
    availableModel.value &&
    (!requestingCompact.value || !compactUnavailable.value) &&
    (draftItems.value.length ? imageInput.value : !!draft.value.trim()),
)
const runLabels = {
  pending: '正在准备回答…',
  running: '正在回答…',
  awaiting_approval: '等待你的审批',
  awaiting_user_input: '需要补充输入，可停止本次回答',
  completed: '回答完成',
  failed: '回答失败',
  cancelled: '已停止生成',
  interrupted: '回答已中断',
}
const latestRun = computed(() => state.detail?.runs.at(-1))
const expandedRunId = ref<string | null>(null)
watch(
  [() => state.selectedId, () => latestRun.value?.id],
  () => {
    expandedRunId.value =
      latestRun.value && isActiveRun(latestRun.value) ? latestRun.value.id : null
  },
  { immediate: true },
)
watch(
  () => latestRun.value?.status,
  () => {
    const run = latestRun.value
    if (run && !isActiveRun(run) && expandedRunId.value === run.id) expandedRunId.value = null
  },
)
function keydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  // 悬停提示打开时先由 Tooltip 处理 Esc，保留输入框中的命令候选。
  if (event.key === 'Escape' && usageHintOpen.value) return
  if (commandsOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      commandsDismissed.value = true
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && !isCompactCommand(draft.value)) {
      event.preventDefault()
      draft.value = '/compact'
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submitMessage()
  }
}
function submitMessage(): void {
  if (!canSend.value) return
  if (requestingCompact.value) void compact(true)
  else {
    if (!awayFromLatest.value) follow.value = true
    void send()
  }
}
function focusCommands(): void {
  commandInputFocused.value = true
  commandsDismissed.value = false
}
function updateDistance(): void {
  const element = scroller.value
  awayFromLatest.value =
    !!element && element.scrollHeight - element.scrollTop - element.clientHeight > 24
}
function trackScroll(): void {
  updateDistance()
  const element = scroller.value
  if (!element) return
  scrollbarVisible.value = true
  window.clearTimeout(scrollbarTimer)
  scrollbarTimer = window.setTimeout(() => {
    scrollbarVisible.value = false
  }, 700)
  if (scrollPositionChanged(element)) {
    if (scrollFrame !== undefined) pauseFollowing()
    else follow.value = !awayFromLatest.value
  }
  rememberScrollPosition(element)
}
function stopFollowing(event: WheelEvent): void {
  if (event.deltaY < 0) pauseFollowing()
}
function pauseFollowing(): void {
  follow.value = false
  cancelScrollAnimation()
}
function cancelScrollAnimation(): void {
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
  scrollFrame = undefined
}
function scrollKey(event: KeyboardEvent): void {
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollowing()
}
function showLatest(): void {
  follow.value = true
  if (state.historical && state.selectedId) void openConversation(state.selectedId)
  else scrollToBottom()
}
let scrollFrame: number | undefined
let previousFrame = 0
let lastScrollTop: number | undefined
let lastScrollHeight = 0
let lastViewportHeight = 0
function rememberScrollPosition(element: HTMLElement): void {
  lastScrollTop = element.scrollTop
  lastScrollHeight = element.scrollHeight
  lastViewportHeight = element.clientHeight
}
function scrollPositionChanged(element: HTMLElement): boolean {
  // 高度变化可能夹紧滚动位置；只有尺寸相同时才用位移识别滚动条拖动等操作。
  return (
    lastScrollTop !== undefined &&
    element.scrollHeight === lastScrollHeight &&
    element.clientHeight === lastViewportHeight &&
    Math.abs(element.scrollTop - lastScrollTop) > 1
  )
}
function pinToBottom(): void {
  const element = scroller.value
  if (element && follow.value && !state.historical) {
    if (scrollPositionChanged(element)) pauseFollowing()
    else {
      cancelScrollAnimation()
      element.scrollTop = element.scrollHeight
      rememberScrollPosition(element)
    }
  }
  updateDistance()
}
function syncComposerLayout(): void {
  const viewport = scroller.value
  const footer = composer.value
  if (!viewport || !footer) return
  // 轨道贯穿对话区，先同步固定输入区的占位，再定位最后一条消息。
  viewport.style.setProperty(
    '--conversation-composer-height',
    `${footer.getBoundingClientRect().height}px`,
  )
  pinToBottom()
}
function followRunLayout(runId: string): void {
  if (activeRun.value?.id === runId) scrollToBottom()
  else pinToBottom()
}
function scrollToBottom(): void {
  updateDistance()
  if (scrollFrame !== undefined || !follow.value || state.historical) return
  previousFrame = 0
  const advance = (time: number): void => {
    const element = scroller.value
    if (!element || !follow.value || state.historical) {
      scrollFrame = undefined
      return
    }
    if (scrollPositionChanged(element)) {
      pauseFollowing()
      return
    }
    const target = element.scrollHeight - element.clientHeight
    const position = element.scrollTop
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const elapsed = previousFrame ? Math.min(time - previousFrame, 64) : 16
    previousFrame = time
    if (!reduced) element.scrollTop = position + (target - position) * (1 - Math.exp(-elapsed / 65))
    // 浏览器可能将最后几帧的位移舍入为零，停滞时直接贴底。
    const finished =
      reduced || element.scrollTop === position || Math.abs(target - element.scrollTop) < 1
    if (finished) element.scrollTop = target
    rememberScrollPosition(element)
    updateDistance()
    scrollFrame = finished ? undefined : requestAnimationFrame(advance)
  }
  scrollFrame = requestAnimationFrame(advance)
}
function resizeMessageInput(): void {
  const input = messageInput.value
  if (!input) return
  // 根据附件状态恢复 rows 的一行或两行高度，删除内容或移除附件后重新测量。
  input.style.overflowY = 'hidden'
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
  input.style.overflowY = ''
  syncComposerLayout()
}
watch([draft, () => draftItems.value.length > 0], resizeMessageInput, { flush: 'post' })
watch(draft, () => {
  commandsDismissed.value = false
})
watch(
  () => currentInteraction.value,
  async (id, previous) => {
    if (id) return
    await nextTick()
    if (currentInteraction.value) return
    resizeMessageInput()
    const input = messageInput.value
    // 审批面板移除时恢复输入；切换会话或设置时不抢走其他控件的焦点。
    if (previous && input && !input.disabled && document.activeElement === document.body)
      input.focus({ preventScroll: true })
  },
  { flush: 'post' },
)
function decideCurrent(id: string, decision: 'approved' | 'rejected', scope: ApprovalScope): void {
  if (
    id !== currentApproval.value?.id ||
    approvalUnavailable.value ||
    state.deciding ||
    state.cancelling
  )
    return
  void decide(id, decision, scope)
}
function submitCurrentInput(id: string, skipped: boolean): void {
  if (id !== currentInput.value?.id || inputUnavailable.value || state.replying || state.cancelling)
    return
  void submitInput(id, skipped)
}
function reloadApproval(): void {
  if (state.serviceError) void refreshOverview()
  else if (state.modelError) void refreshModels()
  else if (state.selectedId) void openConversation(state.selectedId)
}
async function cancelMessageEdit(): Promise<void> {
  const messageId = state.editing?.messageId
  cancelEditing()
  await nextTick()
  if (messageId && !state.editing)
    scroller.value
      ?.querySelector<HTMLButtonElement>(
        `[data-message-id="${messageId}"] button[aria-label="编辑提问"]`,
      )
      ?.focus({ preventScroll: true })
}
watch(
  () => messageTimeline.value,
  () => {
    if (activeRun.value) scrollToBottom()
    else pinToBottom()
  },
  { flush: 'post' },
)
watch(
  [() => state.detail, () => state.historical, showRunningIndicator],
  ([, historical], [, wasHistorical]) => {
    if (wasHistorical && !historical) follow.value = true
    // 新消息页和执行指示器的占位在绘制前定位，只有流式增长需要追赶动画。
    syncComposerLayout()
  },
  { flush: 'post' },
)
watch(
  () => state.selectedId,
  () => {
    cancelScrollAnimation()
    lastScrollTop = undefined
    follow.value = true
    awayFromLatest.value = false
    state.directoriesOffset = 0
    state.directoriesError = ''
  },
)
onMounted(() => {
  messageTimeTimer = window.setInterval(() => {
    messageTimeNow.value = Date.now()
  }, 60_000)
  resizeMessageInput()
  let previousWidth = 0
  inputResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width
    if (width === undefined || width === previousWidth) return
    previousWidth = width
    // 只响应宽度变化，并延后布局写入，避免高度变化反复触发 ResizeObserver。
    if (inputResizeFrame !== undefined) return
    inputResizeFrame = requestAnimationFrame(() => {
      inputResizeFrame = undefined
      resizeMessageInput()
    })
  })
  if (messageInput.value) inputResizeObserver.observe(messageInput.value)
  const viewport = scroller.value
  const footer = composer.value
  if (viewport && footer) {
    conversationResizeObserver = new ResizeObserver(syncComposerLayout)
    conversationResizeObserver.observe(viewport, { box: 'border-box' })
    conversationResizeObserver.observe(footer, { box: 'border-box' })
  }
})
onScopeDispose(() => {
  window.clearInterval(messageTimeTimer)
  window.clearTimeout(scrollbarTimer)
  cancelScrollAnimation()
  inputResizeObserver?.disconnect()
  conversationResizeObserver?.disconnect()
  if (inputResizeFrame !== undefined) cancelAnimationFrame(inputResizeFrame)
})
</script>

<template>
  <section
    class="conversation-page relative flex h-full min-h-0 flex-col justify-end"
    aria-label="对话内容"
  >
    <div
      ref="scroller"
      data-conversation-scroll
      :data-scrolling="scrollbarVisible ? '' : undefined"
      :data-running="showRunningIndicator ? '' : undefined"
      class="absolute inset-0 overflow-y-auto px-6 pt-6 [overflow-anchor:none] lg:px-12"
      @scroll="trackScroll"
      @wheel.passive="stopFollowing"
      @touchstart.passive="pauseFollowing"
      @pointerdown="pauseFollowing"
      @keydown="scrollKey"
    >
      <div class="conversation-messages mx-auto w-full max-w-3xl">
        <div v-if="!state.selectedId" class="flex flex-col items-center pb-8 pt-[min(16vh,140px)]">
          <div
            class="mb-7 flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-accent text-primary"
          >
            <SparklesIcon class="size-7" aria-hidden="true" />
          </div>
          <h1 class="text-center text-3xl font-semibold tracking-tight">开始一段新对话</h1>
          <p class="mt-4 text-center text-sm leading-7 text-muted-foreground">
            {{ workspace ? `在 ${workspace.name} 中开始对话。` : '每个想法，都从这里开始。' }}
          </p>
        </div>
        <h1 v-else class="sr-only">{{ state.detail?.conversation.title || '对话' }}</h1>
        <div
          v-if="showLoadingMessages"
          role="status"
          class="flex justify-center gap-2 py-6 text-sm text-muted-foreground"
        >
          <LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />正在加载消息…
        </div>
        <div
          v-if="state.selectedId && !showLoadingMessages && state.detail?.history?.hasMore"
          class="mb-4 flex justify-center"
        >
          <Button
            variant="ghost"
            size="sm"
            :disabled="state.loading || !!state.editing || state.resending"
            @click="earlier"
            >更早的消息</Button
          >
        </div>
        <div class="space-y-4" aria-label="消息记录">
          <ManualCompactionStatus
            v-for="run in messageTimeline.before"
            :key="run.id"
            :run="run"
            :connected="!state.serviceError"
            @changed="followRunLayout(run.id)"
          />
          <template v-for="{ message: item, compactions } in messageTimeline.rows" :key="item.id">
            <article
              class="group/message"
              :data-message-id="item.id"
              :aria-label="item.role === 'user' ? '你的消息' : 'Callum 的回答'"
              :class="
                item.role === 'user'
                  ? state.editing?.messageId === item.id
                    ? 'ml-auto w-full max-w-[88%]'
                    : 'ml-auto w-fit max-w-[88%]'
                  : 'py-1'
              "
            >
              <RunTimeline
                v-if="item.role === 'assistant' && messageRuns.has(item.id)"
                :run="messageRuns.get(item.id) ?? null"
                :conversation-id="item.conversationId"
                :run-id="item.runId"
                :snapshots="state.detail?.steps ?? []"
                :connected="!state.serviceError"
                :expanded="expandedRunId === item.runId"
                :active="activeRun?.id === item.runId"
                @expand="expandedRunId = $event ? item.runId : null"
                @inspect="pauseFollowing"
                @changed="followRunLayout(item.runId)"
              />
              <MarkdownMessage
                v-if="item.role === 'assistant'"
                :content="item.content"
                :streaming="activeRun?.id === item.runId"
                @rendered="followRunLayout(item.runId)"
              />
              <MessageEditor
                v-else-if="state.editing?.messageId === item.id"
                v-model="state.editing.text"
                :busy="state.resending"
                :disabled="editUnavailable || !!state.modelError || state.modelsLoading"
                :error="state.editing.error"
                :attachments="editItems"
                :image-input="imageInput"
                @files="addAttachments($event, true)"
                @remove="removeAttachment($event, true)"
                @cancel="cancelMessageEdit"
                @submit="resend"
              />
              <div v-else class="flex max-w-full flex-col items-end gap-1">
                <AttachmentList
                  :items="historyImages.get(item.id) ?? []"
                  class="justify-end"
                  @changed="nextTick(() => followRunLayout(item.runId))"
                />
                <div
                  v-if="item.content.some((block) => block.type !== 'image')"
                  data-user-message-text
                  class="w-fit max-w-full rounded-2xl border bg-muted/60 px-3 py-2"
                >
                  <div
                    v-for="(block, index) in item.content.filter((block) => block.type !== 'image')"
                    :key="index"
                    class="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]"
                  >
                    <template v-if="block.type === 'text'">{{ block.text }}</template>
                    <p v-else class="text-muted-foreground">暂不支持展示的内容</p>
                  </div>
                </div>
              </div>
              <MessageActions
                v-if="
                  state.editing?.messageId !== item.id &&
                  (item.role === 'user' || activeRun?.id !== item.runId)
                "
                :message="item"
                :now="messageTimeNow"
                :always-show-copy="
                  !state.historical &&
                  messages.at(-1)?.id === item.id &&
                  item.role === 'assistant' &&
                  item.status === 'completed'
                "
                :editable="
                  item.role === 'user' &&
                  lastUserMessage?.id === item.id &&
                  item.content.every((block) => block.type === 'text' || block.type === 'image')
                "
                :edit-disabled="editUnavailable"
                :class="item.role === 'user' ? 'justify-end' : ''"
                @edit="startEditing(item.id)"
              />
              <span
                v-if="
                  item.role === 'assistant' &&
                  !item.content.length &&
                  activeRun?.id === item.runId &&
                  !messageRuns.has(item.id)
                "
                class="text-sm text-muted-foreground"
                >正在思考…</span
              >
              <p
                v-if="
                  ['cancelled', 'failed', 'interrupted'].includes(item.status) &&
                  !messageRuns.has(item.id)
                "
                class="mt-2 text-xs text-muted-foreground"
              >
                {{
                  item.status === 'cancelled'
                    ? '生成已停止'
                    : item.status === 'failed'
                      ? '回答未完成'
                      : '回答已中断'
                }}
              </p>
            </article>
            <ManualCompactionStatus
              v-for="run in compactions"
              :key="run.id"
              :run="run"
              :connected="!state.serviceError"
              @changed="followRunLayout(run.id)"
            />
          </template>
        </div>
        <p
          v-if="
            latestRun &&
            !latestRun.compaction &&
            !activeRun &&
            ['failed', 'interrupted'].includes(latestRun.status)
          "
          role="alert"
          class="mt-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6"
        >
          {{ latestRun.error || runLabels[latestRun.status] }}
        </p>
        <div
          v-if="!currentInteraction && (state.error || state.serviceError || state.modelError)"
          role="alert"
          class="mt-5 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6"
        >
          <p>{{ state.serviceError || state.modelError || state.error }}</p>
          <Button
            v-if="state.modelError && !state.serviceError"
            variant="outline"
            size="sm"
            class="mt-3"
            :disabled="state.modelsLoading"
            @click="refreshModels"
            >重新加载模型</Button
          >
          <Button
            v-if="!state.serviceError && state.selectedId"
            variant="outline"
            size="sm"
            class="mt-3"
            @click="openConversation(state.selectedId)"
            >重新加载对话</Button
          >
          <Button
            v-if="state.serviceError"
            variant="outline"
            size="sm"
            class="mt-3"
            @click="refreshOverview()"
            >重试加载</Button
          >
        </div>
      </div>
    </div>
    <div
      ref="composer"
      data-conversation-composer
      class="relative z-10 me-[var(--conversation-scrollbar-width)] shrink-0 bg-background px-6 pb-3 lg:px-12"
    >
      <Button
        v-if="canReturnToLatest || showRunningIndicator"
        type="button"
        variant="outline"
        size="icon-sm"
        class="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-full bg-card shadow-none disabled:opacity-100 dark:bg-card"
        :aria-label="canReturnToLatest ? '回到最新消息' : '正在执行'"
        :title="canReturnToLatest ? '回到最新消息' : undefined"
        :disabled="!canReturnToLatest"
        @click="showLatest"
      >
        <span
          v-if="showRunningIndicator"
          class="conversation-progress-dots flex items-center gap-1 text-muted-foreground"
          aria-hidden="true"
        >
          <span v-for="dot in 3" :key="dot" class="size-1 rounded-full bg-current" />
        </span>
        <ArrowDownIcon v-else class="size-4" aria-hidden="true" />
      </Button>
      <ApprovalComposer
        v-if="currentApproval"
        :key="currentApproval.id"
        :approval="currentApproval"
        :count="approvals.length"
        :deciding="!!state.deciding"
        :cancelling="state.cancelling"
        :unavailable="approvalUnavailable"
        :error="approvalError"
        :collapsed="!!state.collapsedCards[currentApproval.id]"
        @decide="decideCurrent"
        @update:collapsed="setCardCollapsed(currentApproval.id, $event)"
        @reload="reloadApproval"
      />
      <UserInputCard
        v-else-if="currentInput"
        :key="currentInput.id"
        :input="currentInput"
        :reply="inputReply(currentInput.id)"
        :collapsed="!!state.collapsedCards[currentInput.id]"
        :submitting="state.replying === currentInput.id"
        :cancelling="state.cancelling"
        :unavailable="inputUnavailable"
        :error="inputError"
        @update:collapsed="setCardCollapsed(currentInput.id, $event)"
        @update:reply="setInputReply(currentInput.id, $event)"
        @submit="submitCurrentInput"
        @reload="reloadApproval"
      />
      <div
        v-if="!state.selectedId"
        class="mx-auto flex h-10 w-[calc(100%-1.5rem)] max-w-[calc(48rem-1.5rem)] items-center gap-2 rounded-t-2xl bg-muted/60 px-3"
        aria-label="对话项目"
      >
        <ProjectSelector />
        <span class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <LaptopIcon class="size-3.5" aria-hidden="true" />此计算机
        </span>
      </div>
      <form
        class="relative mx-auto max-w-3xl rounded-2xl border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-foreground/30"
        @submit.prevent="submitMessage"
        @dragover="dragFiles"
        @drop="dropFiles($event, receiveFiles)"
        @paste="pasteFiles($event, receiveFiles)"
      >
        <ComposerCommands
          v-if="commandsOpen"
          :disabled-reason="compactUnavailable"
          :busy="!!state.compacting"
          :usage="displayedUsage"
          @select="compact(true)"
        />
        <AttachmentList
          :items="draftItems"
          removable
          :disabled="state.sending"
          @remove="removeAttachment"
        />
        <p v-if="draftItems.length && !imageInput" class="mb-1 text-xs text-muted-foreground">
          当前模型未启用图片输入，请在模型设置中启用、切换模型，或移除图片。
        </p>
        <label for="new-message" class="sr-only">消息</label>
        <textarea
          id="new-message"
          ref="messageInput"
          v-model="draft"
          :rows="draftItems.length ? 1 : 2"
          :maxlength="MAX_MESSAGE_LENGTH"
          :disabled="
            !!currentInteraction ||
            state.loading ||
            state.sending ||
            state.resending ||
            !!state.compacting ||
            !!state.editing ||
            state.modelsLoading ||
            !!state.modelError ||
            !!state.serviceError ||
            !availableModel
          "
          placeholder="你想聊些什么？"
          aria-describedby="conversation-hint"
          aria-autocomplete="list"
          :aria-controls="commandsOpen ? 'composer-commands' : undefined"
          :aria-activedescendant="commandsOpen ? 'composer-compact-command' : undefined"
          class="block max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-6 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          :class="draftItems.length ? 'min-h-6' : 'min-h-12'"
          @input="resizeMessageInput"
          @focus="focusCommands"
          @blur="commandInputFocused = false"
          @keydown="keydown"
        ></textarea>
        <div class="mt-2 flex items-center gap-2">
          <AttachmentPicker :disabled="attachmentBusy || !imageInput" @files="receiveFiles" />
          <ApprovalModeSelector class="mr-auto" />
          <div class="flex min-w-0 items-center gap-2">
            <ContextUsageControl
              :usage="displayedUsage"
              :error="contextUsageError"
              :loading="contextUsageLoading"
              :configured="!!usageInput"
              :service-error="state.serviceError"
              @update:open="usageHintOpen = $event"
            />

            <Button
              v-if="!state.models.length"
              type="button"
              variant="ghost"
              size="sm"
              class="h-7"
              :disabled="state.loadingList || state.modelsLoading || !!state.serviceError"
              @click="$emit('configureModels')"
              >{{ state.loadingList || state.modelsLoading ? '正在读取模型…' : '配置模型' }}</Button
            >
            <ModelSelector
              v-else
              v-model="state.modelId"
              :models="state.models"
              :disabled="
                !!activeRun ||
                state.loadingList ||
                state.modelsLoading ||
                state.sending ||
                state.resending ||
                !!state.compacting ||
                !!state.serviceError
              "
            />
          </div>
          <Button
            v-if="activeRun"
            type="button"
            variant="ghost"
            size="icon"
            class="size-7 shrink-0 rounded-full border bg-background text-foreground hover:bg-muted"
            :aria-label="stopLabel"
            :title="state.cancelling ? '正在停止…' : stopLabel"
            :aria-busy="state.cancelling"
            :disabled="
              state.cancelling || !!state.deciding || !!state.replying || !!state.serviceError
            "
            @click="cancel"
            ><LoaderCircleIcon
              v-if="state.cancelling"
              class="size-3.5 animate-spin"
              aria-hidden="true" />
            <SquareIcon v-else class="size-3 fill-current" aria-hidden="true"
          /></Button>
          <Button
            v-else
            type="submit"
            size="icon"
            class="size-7 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
            :disabled="!canSend"
            :aria-label="requestingCompact ? '压缩上下文' : '发送消息'"
            ><LoaderCircleIcon
              v-if="state.sending"
              class="size-4 animate-spin"
              aria-hidden="true" /><ArrowUpIcon v-else class="size-4" aria-hidden="true"
          /></Button>
        </div>
      </form>
      <p
        v-if="reviewing && !state.serviceError"
        role="status"
        class="mx-auto mt-1 max-w-3xl px-1 text-xs text-muted-foreground"
      >
        AI 正在审核工具操作…
      </p>
      <p
        id="conversation-hint"
        :class="
          !activeRun && composerNotice
            ? 'mx-auto mt-2 min-h-5 max-w-3xl text-center text-xs leading-5 text-muted-foreground'
            : 'sr-only'
        "
        role="status"
      >
        {{
          activeRun
            ? state.serviceError
              ? '连接已断开'
              : compactingRun
                ? '正在压缩上下文…'
                : runLabels[activeRun.status]
            : composerNotice || 'Enter 发送，Shift + Enter 换行'
        }}
      </p>
    </div>
  </section>
</template>

<style scoped>
@property --conversation-scrollbar-thumb {
  syntax: '<color>';
  inherits: true;
  initial-value: transparent;
}

.conversation-page {
  --conversation-scrollbar-width: 6px;
}

[data-conversation-scroll] {
  --conversation-bottom-inset: calc(
    var(--conversation-composer-height, 0px) + var(--conversation-indicator-inset, 0px)
  );
  scrollbar-gutter: stable;
  scroll-padding-bottom: var(--conversation-bottom-inset);
  transition: --conversation-scrollbar-thumb 180ms ease-out;
}

[data-conversation-scroll][data-running] {
  --conversation-indicator-inset: 2.375rem;
}

.conversation-messages {
  padding-bottom: calc(1rem + var(--conversation-bottom-inset));
}

.conversation-progress-dots > span {
  animation: conversation-progress-dot 1.2s ease-in-out infinite both;
}

.conversation-progress-dots > span:nth-child(2) {
  animation-delay: 160ms;
}

.conversation-progress-dots > span:nth-child(3) {
  animation-delay: 320ms;
}

@keyframes conversation-progress-dot {
  0%,
  65%,
  100% {
    opacity: 0.35;
  }

  30% {
    opacity: 1;
  }
}

[data-conversation-scroll][data-scrolling] {
  --conversation-scrollbar-thumb: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
  transition-duration: 0ms;
}

[data-conversation-scroll]::-webkit-scrollbar {
  width: var(--conversation-scrollbar-width);
  background: transparent;
}

[data-conversation-scroll]::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background-color: var(--conversation-scrollbar-thumb);
}

[data-conversation-scroll]::-webkit-scrollbar-thumb:hover,
[data-conversation-scroll]::-webkit-scrollbar-thumb:active {
  background-color: color-mix(in srgb, var(--muted-foreground) 75%, transparent);
}
</style>
