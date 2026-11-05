<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { ArrowUpIcon, LoaderCircleIcon, SparklesIcon, SquareIcon } from '@lucide/vue'
import { MAX_MESSAGE_LENGTH } from '@shared/chat'
import type { ApprovalScope, ChatRun } from '@shared/chat'
import { Button } from '@/components/ui/button'
import { useConversations } from './useConversations'
import ModelSelector from './ModelSelector.vue'
import MarkdownMessage from './MarkdownMessage.vue'
import RunStatus from './RunStatus.vue'
import ApprovalComposer from './ApprovalComposer.vue'
import UserInputCard from './UserInputCard.vue'
defineEmits<{ configureModels: [] }>()

const {
  state,
  draft,
  workspace,
  activeRun,
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
  loadDirectories,
  revokeDirectory,
  openConversation,
  earlier,
} = useConversations()
const messages = computed(() => state.detail?.messages ?? [])
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
const messageInput = ref<HTMLTextAreaElement | null>(null)
let inputResizeObserver: ResizeObserver | undefined
let inputResizeFrame: number | undefined
const follow = ref(true)
const availableModel = computed(() => state.models.some((item) => item.id === state.modelId))
const composerNotice = computed(() =>
  state.loadingList || state.modelsLoading
    ? '正在读取模型…'
    : !state.models.length && !state.serviceError
      ? '尚未配置可用模型，配置完成后即可开始对话。'
      : '',
)
const canSend = computed(
  () =>
    !state.loading &&
    !state.loadingList &&
    !state.sending &&
    !activeRun.value &&
    !currentInteraction.value &&
    !state.serviceError &&
    !state.modelsLoading &&
    !state.modelError &&
    availableModel.value &&
    !!draft.value.trim(),
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
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    if (canSend.value) void send()
  }
}
function trackScroll(): void {
  const element = scroller.value
  if (element) follow.value = element.scrollHeight - element.scrollTop - element.clientHeight < 100
}
function showLatest(): void {
  follow.value = true
  if (state.selectedId) void openConversation(state.selectedId)
}
let scrollFrame: number | undefined
function scrollToBottom(): void {
  if (scrollFrame !== undefined) return
  // 消息通知与 Worker 回调可能在同一帧到达，只在布局更新后读写一次滚动位置。
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined
    if (follow.value && !state.historical && scroller.value)
      scroller.value.scrollTop = scroller.value.scrollHeight
  })
}
function resizeMessageInput(): void {
  const input = messageInput.value
  if (!input) return
  // 先恢复单行测量高度，使删除内容、发送或切换草稿时也能收缩；上限由 CSS 管理。
  input.style.overflowY = 'hidden'
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
  input.style.overflowY = ''
  void scrollToBottom()
}
watch(draft, resizeMessageInput, { flush: 'post' })
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
watch(
  () => messages.value,
  () => {
    void scrollToBottom()
  },
)
watch(
  () => state.selectedId,
  () => {
    follow.value = true
    state.directoriesOffset = 0
    state.directoriesError = ''
  },
)
onMounted(() => {
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
  void scrollToBottom()
})
onScopeDispose(() => {
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
  inputResizeObserver?.disconnect()
  if (inputResizeFrame !== undefined) cancelAnimationFrame(inputResizeFrame)
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="对话内容">
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-6 lg:px-12"
      @scroll="trackScroll"
    >
      <div class="mx-auto w-full max-w-3xl">
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
        <details
          v-if="state.selectedId && state.detail && !state.loading"
          class="mb-4 rounded-lg border p-3 text-xs"
          aria-label="会话目录授权"
        >
          <summary class="cursor-pointer">目录授权（当前会话）</summary>
          <p class="mt-2 text-muted-foreground">
            授权覆盖子目录，重启后保留。撤销后，依赖目录授权的后续操作会重新判断，已批准或开始的操作不会撤回。
          </p>
          <p v-if="state.directoriesError" role="alert" class="mt-2 text-destructive">
            {{ state.directoriesError }}
          </p>
          <p v-if="state.directoriesLoading" role="status" class="mt-2">正在读取目录授权…</p>
          <p v-else-if="!state.detail.directoryGrants.length" class="mt-2 text-muted-foreground">
            暂无目录授权。
          </p>
          <ul class="mt-2 space-y-2">
            <li
              v-for="grant in state.detail.directoryGrants"
              :key="grant.id"
              class="flex items-center gap-2"
            >
              <span class="min-w-0 flex-1 break-all"
                >{{ grant.scope.rootPath }} ·
                {{ grant.scope.access === 'read' ? '只读' : '读取和普通修改'
                }}{{ grant.revokedAt === null ? '' : ' · 已撤销' }}</span
              >
              <Button
                v-if="grant.revokedAt === null"
                type="button"
                variant="outline"
                size="xs"
                :disabled="
                  !!state.revokingDirectory || state.directoriesLoading || !!state.serviceError
                "
                @click="revokeDirectory(grant.id)"
                >{{ state.revokingDirectory === grant.id ? '正在撤销…' : '撤销授权' }}</Button
              >
            </li>
          </ul>
          <div class="mt-2 flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :disabled="state.directoriesLoading || !!state.serviceError"
              @click="loadDirectories(state.directoriesOffset)"
              >刷新授权</Button
            >
            <Button
              v-if="state.directoriesOffset > 0"
              type="button"
              variant="ghost"
              size="xs"
              :disabled="state.directoriesLoading"
              @click="loadDirectories(Math.max(0, state.directoriesOffset - 200))"
              >上一页授权</Button
            >
            <Button
              v-if="state.detail.directoryGrants.length === 200"
              type="button"
              variant="ghost"
              size="xs"
              :disabled="state.directoriesLoading"
              @click="loadDirectories(state.directoriesOffset + 200)"
              >下一页授权</Button
            >
          </div>
        </details>
        <div
          v-if="state.loading"
          role="status"
          class="flex justify-center gap-2 py-6 text-sm text-muted-foreground"
        >
          <LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />正在加载消息…
        </div>
        <div
          v-if="
            state.selectedId &&
            !state.loading &&
            ((messages[0]?.sequence ?? 0) > 1 || state.historical)
          "
          class="mb-4 flex justify-center gap-3"
        >
          <Button
            v-if="messages[0] && messages[0].sequence > 1"
            variant="ghost"
            size="sm"
            @click="earlier"
            >更早的消息</Button
          >
          <Button v-if="state.historical" variant="outline" size="sm" @click="showLatest"
            >回到最新消息</Button
          >
        </div>
        <div class="space-y-4" aria-label="消息记录">
          <article
            v-for="item in messages"
            :key="item.id"
            :aria-label="item.role === 'user' ? '你的消息' : 'Callum 的回答'"
            :class="
              item.role === 'user'
                ? 'ml-auto w-fit max-w-[88%] rounded-2xl border bg-muted/60 px-3 py-2'
                : 'py-1'
            "
          >
            <RunStatus
              v-if="item.role === 'assistant'"
              :run="messageRuns.get(item.id) ?? null"
              :connected="!state.serviceError"
            />
            <MarkdownMessage
              v-if="item.role === 'assistant'"
              :content="item.content"
              :streaming="activeRun?.id === item.runId"
              @rendered="scrollToBottom"
            />
            <template v-else>
              <div
                v-for="(block, index) in item.content"
                :key="index"
                class="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]"
              >
                <template v-if="block.type === 'text'">{{ block.text }}</template>
                <p v-else class="text-muted-foreground">
                  [{{ block.type === 'image' ? '图片' : '暂不支持展示的内容' }}] {{ block.path }}
                </p>
              </div>
            </template>
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
        </div>
        <p
          v-if="latestRun && !activeRun && ['failed', 'interrupted'].includes(latestRun.status)"
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
    <div class="shrink-0 px-6 pb-3 lg:px-12">
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
      <form
        class="mx-auto max-w-3xl rounded-2xl border bg-card px-3 py-1.5 shadow-sm transition-colors focus-within:border-foreground/30"
        @submit.prevent="send"
      >
        <label for="new-message" class="sr-only">消息</label>
        <textarea
          id="new-message"
          ref="messageInput"
          v-model="draft"
          rows="1"
          :maxlength="MAX_MESSAGE_LENGTH"
          :disabled="
            !!currentInteraction ||
            state.loading ||
            state.sending ||
            state.modelsLoading ||
            !!state.modelError ||
            !!state.serviceError ||
            !availableModel
          "
          placeholder="你想聊些什么？"
          aria-describedby="conversation-hint"
          class="block max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-6 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          @input="resizeMessageInput"
          @keydown="keydown"
        ></textarea>
        <div class="flex items-center justify-end gap-2">
          <div class="flex min-w-0 items-center gap-2">
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
            aria-label="停止生成"
            :title="state.cancelling ? '正在停止…' : '停止生成'"
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
            aria-label="发送消息"
            ><LoaderCircleIcon
              v-if="state.sending"
              class="size-4 animate-spin"
              aria-hidden="true" /><ArrowUpIcon v-else class="size-4" aria-hidden="true"
          /></Button>
        </div>
      </form>
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
              : runLabels[activeRun.status]
            : composerNotice || 'Enter 发送，Shift + Enter 换行'
        }}
      </p>
    </div>
  </section>
</template>
