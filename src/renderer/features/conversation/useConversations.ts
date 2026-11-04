import { computed, inject, onMounted, onScopeDispose, provide, reactive } from 'vue'
import type { InjectionKey } from 'vue'
import { isActiveRun } from '@shared/chat'
import type {
  ChatEvent,
  ChatMessage,
  ChatModel,
  ChatResult,
  Conversation,
  ConversationDetail,
} from '@shared/chat'
import { getDesktopApi } from '@/lib/desktop'
import { availableModels } from '@shared/models'

function unwrap<T>(result: ChatResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
}
/** 界面保留有界的消息窗口；更早内容仍通过后端分页读取。 */
function boundMessages(messages: ChatMessage[]): ChatMessage[] {
  const sorted = messages.toSorted((a, b) => a.sequence - b.sequence)
  let chars = 0,
    start = sorted.length
  while (start > 0 && sorted.length - start < 200) {
    const count =
      sorted[start - 1]?.content.reduce(
        (total, block) => total + block.text.length + block.path.length,
        0,
      ) ?? 0
    if (start < sorted.length && chars + count > 4 * 1024 * 1024) break
    chars += count
    start--
  }
  return sorted.slice(start)
}
function createConversations() {
  const state = reactive({
    conversations: [] as Conversation[],
    models: [] as ChatModel[],
    selectedId: null as string | null,
    modelId: '',
    detail: null as ConversationDetail | null,
    loading: true,
    loadingList: true,
    sending: false,
    cancelling: false,
    deciding: '',
    error: '',
    serviceError: '',
    modelsLoading: false,
    modelError: '',
    hasMore: false,
    historical: false,
    drafts: {} as Record<string, string>,
  })
  let selection = 0,
    listOffset = 0,
    unsubscribe: (() => void) | undefined,
    disposed = false
  const pendingEvents = new Map<string, ChatEvent>()
  const listEvents = new Map<string, ChatEvent>()
  let listRevision = 0,
    detailRevision = 0
  let modelGeneration = 0
  const draft = computed({
    get: () => state.drafts[state.selectedId ?? 'new'] ?? '',
    set: (value: string) => {
      const key = state.selectedId ?? 'new'
      if (!(key in state.drafts) && Object.keys(state.drafts).length >= 100) {
        state.error = '草稿数量已达上限，请发送或清空已有草稿。'
        return
      }
      if (value) state.drafts[key] = value
      else delete state.drafts[key]
    },
  })
  const activeRun = computed(() => state.detail?.runs.find(isActiveRun) ?? null)
  const pendingApprovals = computed(
    () => state.detail?.approvals.filter((item) => item.status === 'pending') ?? [],
  )
  const title = computed(() => state.detail?.conversation.title || '新对话')
  function selectAvailableModel(): void {
    if (
      !state.modelId ||
      (!state.selectedId && !state.models.some((model) => model.id === state.modelId))
    )
      state.modelId = state.models[0]?.id ?? ''
  }
  function setModels(models: ChatModel[]): void {
    modelGeneration++
    state.models = models
    state.modelsLoading = false
    state.modelError = ''
    selectAvailableModel()
  }
  async function refreshModels(): Promise<void> {
    const generation = ++modelGeneration
    state.modelsLoading = true
    try {
      const catalog = unwrap(await getDesktopApi().getModelCatalog())
      if (!disposed && generation === modelGeneration) setModels(availableModels(catalog))
    } catch (error) {
      if (!disposed && generation === modelGeneration) state.modelError = message(error)
    } finally {
      if (generation === modelGeneration) state.modelsLoading = false
    }
  }

  function apply(event: ChatEvent): void {
    const change = event.change
    if (change.kind === 'service') {
      state.serviceError = change.error
      return
    }
    if (change.kind === 'conversation') {
      if (event.revision > listRevision)
        state.conversations = upsert(state.conversations, change.value)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 1000)
      if (event.revision > detailRevision && state.detail?.conversation.id === change.value.id)
        state.detail.conversation = change.value
      return
    }
    if (
      !state.detail ||
      change.value.conversationId !== state.selectedId ||
      event.revision <= detailRevision
    )
      return
    if (
      change.kind === 'message' &&
      (!state.historical || state.detail.messages.some((item) => item.id === change.value.id))
    )
      state.detail.messages = boundMessages(upsert(state.detail.messages, change.value))
    if (change.kind === 'run') {
      state.detail.runs = upsert(state.detail.runs, change.value)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(-200)
      if (!change.persisted) state.error = '本次执行状态未能完整保存，请重新打开应用后核对历史。'
    }
    if (change.kind === 'approval')
      state.detail.approvals = upsert(state.detail.approvals, change.value).slice(-200)
  }
  function receive(event: ChatEvent): void {
    const change = event.change
    if (change.kind === 'conversation' && state.loadingList) listEvents.set(change.value.id, event)
    if (state.loading && change.kind !== 'service' && change.kind !== 'conversation') {
      if (change.value.conversationId === state.selectedId) {
        pendingEvents.set(`${change.kind}:${change.value.id}`, event)
        if (pendingEvents.size > 500) {
          pendingEvents.clear()
          state.error = '对话变化较快，请重新加载。'
          selection++
          state.loading = false
        }
      }
    } else apply(event)
  }
  async function refreshOverview(more = false): Promise<void> {
    if (state.loadingList && more) return
    state.loadingList = true
    const generation = modelGeneration
    const recovering = !!state.serviceError
    if (!more) {
      state.serviceError = ''
      listEvents.clear()
    }
    try {
      const result = unwrap(await getDesktopApi().getChatOverview(more ? listOffset : 0))
      if (disposed) return
      // 配置页面可能在概览查询期间保存模型，不让迟到的旧列表覆盖已保存配置。
      if (generation === modelGeneration) setModels(result.models)
      listRevision = result.revision
      state.conversations = (
        more
          ? [
              ...new Map(
                [...state.conversations, ...result.conversations].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.conversations
      ).slice(0, 1000)
      state.hasMore = result.hasMore && state.conversations.length < 1000
      listOffset = (more ? listOffset : 0) + 50
      for (const event of listEvents.values()) if (event.revision > result.revision) apply(event)
      if (recovering && state.selectedId) await openConversation(state.selectedId)
    } catch (error) {
      state.serviceError = message(error)
    } finally {
      if (!disposed) {
        state.loadingList = false
        listEvents.clear()
      }
    }
  }
  function newConversation(): void {
    selection++
    state.selectedId = null
    selectAvailableModel()
    state.detail = null
    state.loading = false
    state.error = ''
    state.historical = false
    state.cancelling = false
    pendingEvents.clear()
  }
  async function openConversation(conversationId: string): Promise<void> {
    const token = ++selection
    detailRevision = 0
    state.selectedId = conversationId
    state.detail = null
    state.loading = true
    state.error = ''
    state.historical = false
    state.cancelling = false
    pendingEvents.clear()
    try {
      const result = unwrap(await getDesktopApi().getConversation(conversationId))
      if (disposed || token !== selection) return
      state.detail = result
      state.detail.messages = boundMessages(result.messages)
      state.error = result.warning ?? ''
      detailRevision = result.revision
      state.modelId = result.conversation.modelId
      for (const event of [...pendingEvents.values()].sort((a, b) => a.revision - b.revision))
        if (event.revision > result.revision) apply(event)
    } catch (error) {
      if (token === selection) state.error = message(error)
    } finally {
      if (token === selection) {
        state.loading = false
        pendingEvents.clear()
      }
    }
  }
  async function send(): Promise<void> {
    if (
      state.sending ||
      state.loading ||
      activeRun.value ||
      state.serviceError ||
      state.modelsLoading ||
      state.modelError ||
      !draft.value.trim() ||
      !state.modelId
    )
      return
    state.sending = true
    state.error = ''
    const conversationId = state.selectedId,
      text = draft.value,
      token = selection
    const key = conversationId ?? 'new'
    try {
      const result = unwrap(
        await getDesktopApi().sendMessage({ conversationId, text, modelId: state.modelId }),
      )
      if (state.drafts[key] === text) delete state.drafts[key]
      if (token === selection && !disposed) await openConversation(result.conversationId)
      // 受理响应不等于完成；执行状态完全由后端事件及查询决定。
    } catch (error) {
      if (token === selection) state.error = message(error)
    } finally {
      state.sending = false
    }
  }
  async function cancel(): Promise<void> {
    const run = activeRun.value
    if (!run || state.cancelling) return
    state.cancelling = true
    state.error = ''
    try {
      unwrap(await getDesktopApi().cancelRun(run.id))
    } catch (error) {
      if (run.conversationId === state.selectedId) state.error = message(error)
    } finally {
      if (run.conversationId === state.selectedId) state.cancelling = false
    }
  }
  async function decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
    if (state.deciding) return
    state.deciding = approvalId
    state.error = ''
    const conversationId = state.selectedId
    try {
      unwrap(await getDesktopApi().decideApproval(approvalId, decision))
    } catch (error) {
      if (conversationId === state.selectedId) state.error = message(error)
    } finally {
      state.deciding = ''
    }
  }
  async function earlier(): Promise<void> {
    const first = state.detail?.messages[0],
      token = selection
    if (!first || state.loading) return
    state.loading = true
    state.error = ''
    try {
      const rows = unwrap(
        await getDesktopApi().getEarlierMessages(first.conversationId, first.sequence),
      )
      if (token !== selection || !state.detail) return
      if (rows.length) {
        state.detail.messages = boundMessages(rows)
        state.historical = true
      }
    } catch (error) {
      if (token === selection) state.error = message(error)
    } finally {
      if (token === selection) {
        state.loading = false
        for (const event of [...pendingEvents.values()].sort((a, b) => a.revision - b.revision))
          apply(event)
        pendingEvents.clear()
      }
    }
  }
  onMounted(() => {
    unsubscribe = getDesktopApi().onChatEvent(receive)
    state.loading = false
    void refreshOverview()
  })
  onScopeDispose(() => {
    disposed = true
    selection++
    unsubscribe?.()
    pendingEvents.clear()
    listEvents.clear()
  })
  return {
    state,
    draft,
    activeRun,
    pendingApprovals,
    title,
    newConversation,
    openConversation,
    refreshOverview,
    refreshModels,
    setModels,
    send,
    cancel,
    decide,
    earlier,
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : '无法完成对话操作，请重试。'
}
type Conversations = ReturnType<typeof createConversations>
const key: InjectionKey<Conversations> = Symbol('conversations')
export function provideConversations(): Conversations {
  const value = createConversations()
  provide(key, value)
  return value
}
export function useConversations(): Conversations {
  const value = inject(key)
  if (!value) throw new Error('对话上下文未初始化')
  return value
}
