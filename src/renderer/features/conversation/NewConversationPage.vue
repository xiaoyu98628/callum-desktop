<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { ArrowUpIcon, LoaderCircleIcon, SparklesIcon, SquareIcon } from '@lucide/vue'
import { MAX_MESSAGE_LENGTH } from '@shared/chat'
import { Button } from '@/components/ui/button'
import { useConversations } from './useConversations'
import ModelSelector from './ModelSelector.vue'
defineEmits<{ configureModels: [] }>()

const {
  state,
  draft,
  activeRun,
  pendingApprovals,
  refreshOverview,
  refreshModels,
  send,
  cancel,
  decide,
  openConversation,
  earlier,
} = useConversations()
const messages = computed(() => state.detail?.messages ?? [])
const scroller = ref<HTMLElement | null>(null)
const messageInput = ref<HTMLTextAreaElement | null>(null)
let inputResizeObserver: ResizeObserver | undefined
let inputResizeFrame: number | undefined
const follow = ref(true)
const availableModel = computed(() => state.models.some((item) => item.id === state.modelId))
const canSend = computed(
  () =>
    !state.loading &&
    !state.loadingList &&
    !state.sending &&
    !activeRun.value &&
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
async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (follow.value && !state.historical && scroller.value)
    scroller.value.scrollTop = scroller.value.scrollHeight
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
  () => messages.value,
  () => {
    void scrollToBottom()
  },
)
watch(
  () => state.selectedId,
  () => {
    follow.value = true
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
  inputResizeObserver?.disconnect()
  if (inputResizeFrame !== undefined) cancelAnimationFrame(inputResizeFrame)
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="对话内容">
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto px-6 py-8 lg:px-12"
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
            每个想法，都从这里开始。
          </p>
        </div>
        <h1 v-else class="sr-only">{{ state.detail?.conversation.title || '对话' }}</h1>
        <div
          v-if="state.loading"
          role="status"
          class="flex justify-center gap-2 py-6 text-sm text-muted-foreground"
        >
          <LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />正在加载消息…
        </div>
        <div v-if="state.selectedId && !state.loading" class="mb-5 flex justify-center gap-3">
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
        <div class="space-y-8" aria-label="消息记录">
          <article
            v-for="item in messages"
            :key="item.id"
            :aria-label="item.role === 'user' ? '你的消息' : 'Callum 的回答'"
            :class="
              item.role === 'user'
                ? 'ml-auto max-w-[88%] rounded-2xl border bg-muted/60 px-5 py-4'
                : 'py-2'
            "
          >
            <p class="mb-2 text-xs font-medium text-muted-foreground">
              {{ item.role === 'user' ? '你' : 'Callum' }}
            </p>
            <div
              v-for="(block, index) in item.content"
              :key="index"
              class="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]"
            >
              <template v-if="block.type === 'text'">{{ block.text }}</template>
              <p v-else class="text-muted-foreground">
                [{{ block.type === 'image' ? '图片' : '暂不支持展示的内容' }}] {{ block.path }}
              </p>
            </div>
            <span
              v-if="
                item.role === 'assistant' && !item.content.length && activeRun?.id === item.runId
              "
              class="text-sm text-muted-foreground"
              >正在思考…</span
            >
            <p
              v-if="['cancelled', 'failed', 'interrupted'].includes(item.status)"
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
        <div
          v-for="approval in pendingApprovals"
          :key="approval.id"
          class="mt-6 rounded-xl border border-primary/25 bg-accent/40 p-5"
          :aria-label="'审批：' + approval.toolName"
        >
          <h2 class="text-sm font-semibold">允许 {{ approval.toolName }} 吗？</h2>
          <p class="mt-2 text-xs leading-6 text-muted-foreground">
            请检查后端提供的操作及实际目标。本次决定仅适用于下方操作。
          </p>
          <pre
            class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-background p-3 text-xs leading-6"
            >{{ approval.snapshot }}</pre>
          <div class="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              :disabled="!!state.deciding || !!state.serviceError"
              @click="decide(approval.id, 'rejected')"
              >拒绝</Button
            >
            <Button
              size="sm"
              :disabled="!!state.deciding || !!state.serviceError"
              @click="decide(approval.id, 'approved')"
              >允许本次操作</Button
            >
          </div>
        </div>
        <p
          v-if="latestRun && !activeRun && ['failed', 'interrupted'].includes(latestRun.status)"
          role="alert"
          class="mt-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6"
        >
          {{ latestRun.error || runLabels[latestRun.status] }}
        </p>
        <div
          v-if="state.error || state.serviceError || state.modelError"
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
    <div class="shrink-0 px-6 pb-5 lg:px-12">
      <form
        class="mx-auto max-w-3xl rounded-2xl border bg-card px-3 py-2 shadow-[0_8px_40px_-24px_rgba(30,25,60,0.2)] focus-within:ring-2 focus-within:ring-ring/30"
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
            state.loading ||
            state.sending ||
            state.modelsLoading ||
            !!state.modelError ||
            !!state.serviceError ||
            !availableModel
          "
          placeholder="你想聊些什么？"
          aria-describedby="conversation-hint"
          class="block max-h-48 w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-sm leading-7 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          @input="resizeMessageInput"
          @keydown="keydown"
        ></textarea>
        <div class="mt-1 flex items-center justify-end gap-3">
          <div class="flex min-w-0 items-center gap-2">
            <Button
              v-if="!state.models.length"
              type="button"
              variant="ghost"
              size="sm"
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
            variant="outline"
            size="sm"
            :disabled="state.cancelling || !!state.serviceError"
            @click="cancel"
            ><SquareIcon class="size-3" aria-hidden="true" />{{
              state.cancelling ? '正在停止…' : '停止生成'
            }}</Button
          >
          <Button
            v-else
            type="submit"
            size="icon"
            class="size-8 shrink-0 rounded-lg"
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
        class="mx-auto mt-3 max-w-3xl text-center text-xs leading-5 text-muted-foreground"
        role="status"
      >
        {{
          state.loadingList || state.modelsLoading
            ? '正在读取模型…'
            : !state.models.length && !state.serviceError
              ? '尚未配置可用模型，配置完成后即可开始对话。'
              : activeRun
                ? runLabels[activeRun.status]
                : 'Enter 发送，Shift + Enter 换行'
        }}
      </p>
    </div>
  </section>
</template>
