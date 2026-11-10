import { computed, inject, onMounted, onScopeDispose, provide, reactive } from 'vue'
import type { InjectionKey } from 'vue'
import { comparePinnedItems, isActiveRun, isVisible, MAX_MESSAGE_LENGTH } from '@shared/chat'
import { boundSteps } from '@shared/steps'
import { messageText } from '@shared/message-actions'
import { isCompactCommand, matchesCompactCommand } from '@shared/manual-compaction'
import type { ExecutionSettings } from '@shared/execution'
import type { ContextUsage } from '@shared/context-usage'
import type {
  ChatEvent,
  ApprovalScope,
  ChatMessage,
  ChatModel,
  ChatResult,
  Conversation,
  ConversationDetail,
  ConversationUpdate,
  ConversationPage,
  WorkspacePage,
  Workspace,
  WorkspaceInput,
  WorkspaceChange,
  WorkspaceUpdate,
  UserInputAnswer,
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
interface ConversationGroup {
  items: Conversation[]
  loading: boolean
  error: string
  hasMore: boolean
  offset: number
  revision: number
  generation: number
  expanded: boolean
  events: Map<string, ChatEvent>
}
function createConversations() {
  const state = reactive({
    conversations: [] as Conversation[],
    models: [] as ChatModel[],
    selectedId: null as string | null,
    workspaceId: null as string | null,
    workspaces: [] as Workspace[],
    workspaceGroups: {} as Record<string, ConversationGroup>,
    workspacesLoading: false,
    workspacesError: '',
    workspacesHasMore: false,
    managing: false,
    archivesOpen: false,
    archivedConversations: [] as Conversation[],
    archivedWorkspaces: [] as Workspace[],
    archiveKind: 'conversations' as 'conversations' | 'workspaces',
    archivesLoading: false,
    archivesError: '',
    archivesHasMore: false,
    modelId: '',
    detail: null as ConversationDetail | null,
    loading: true,
    loadingList: true,
    sending: false,
    resending: false,
    compacting: '',
    executionSettings: null as ExecutionSettings | null,
    executionSettingsLoading: false,
    executionSettingsSaving: false,
    executionSettingsError: '',
    contextUsageEvent: null as ContextUsage | null,
    usageActivityRevision: 0,
    editing: null as {
      messageId: string
      originalText: string
      text: string
      error: string
    } | null,
    cancelling: false,
    deciding: '',
    revokingDirectory: '',
    directoriesLoading: false,
    directoriesOffset: 0,
    directoriesError: '',
    replying: '',
    inputReplies: {} as Record<string, UserInputAnswer>,
    collapsedCards: {} as Record<string, boolean>,
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
  let executionSettingsRequest: Promise<ExecutionSettings | null> | null = null
  let overviewGeneration = 0,
    workspaceGeneration = 0,
    workspaceOffset = 0,
    workspaceRevision = 0
  const workspaceEvents = new Map<string, ChatEvent>()
  const archiveEvents = new Map<string, ChatEvent>()
  let archiveGeneration = 0,
    archiveOffset = 0,
    archiveRevision = 0
  // 通知和管理快照有界保留，防止迟到通知或旧查询撤销已接受的用户操作。
  const conversationUpdates = new Map<string, ConversationUpdate>()
  const workspaceUpdates = new Map<string, WorkspaceUpdate>()
  const hiddenConversations = new Set<string>()
  const hiddenWorkspaces = new Set<string>()
  const draftWorkspaces = new Map<string, string | null>()
  const draftKey = () => state.selectedId ?? `new:${state.workspaceId ?? 'unbound'}`
  const draft = computed({
    get: () => state.drafts[draftKey()] ?? '',
    set: (value: string) => {
      const key = draftKey()
      if (!(key in state.drafts) && Object.keys(state.drafts).length >= 100) {
        state.error = '草稿数量已达上限，请发送或清空已有草稿。'
        return
      }
      if (value) {
        state.drafts[key] = value
        draftWorkspaces.set(key, state.workspaceId)
      } else {
        delete state.drafts[key]
        draftWorkspaces.delete(key)
      }
    },
  })
  const activeRun = computed(() => state.detail?.runs.find(isActiveRun) ?? null)
  const lastUserMessage = computed(() =>
    state.historical
      ? null
      : (state.detail?.messages.findLast((item) => item.role === 'user') ?? null),
  )
  const editUnavailable = computed(
    () =>
      state.loading ||
      state.loadingList ||
      state.sending ||
      state.resending ||
      !!state.compacting ||
      !!state.serviceError ||
      !!activeRun.value,
  )
  const pendingApprovals = computed(
    () => state.detail?.approvals.filter((item) => item.status === 'pending') ?? [],
  )
  const compactUnavailable = computed(() => {
    if (state.executionSettingsSaving) return '正在保存审批模式，请稍候。'
    if (!state.selectedId) return '请先发送消息，建立对话后再压缩上下文。'
    if (state.serviceError) return '对话服务连接已中断，恢复连接后再压缩。'
    if (state.loading || state.loadingList || state.modelsLoading)
      return '正在读取对话或模型，请稍候。'
    if (state.compacting || state.sending || state.resending || activeRun.value)
      return '请等待当前任务结束后再压缩上下文。'
    if (state.editing) return '请先完成或取消消息编辑。'
    if (state.historical) return '请回到最新消息后再压缩上下文。'
    if (state.modelError || !state.models.some((model) => model.id === state.modelId))
      return '请选择可用模型后再压缩上下文。'
    return ''
  })
  const pendingInputs = computed(
    () => state.detail?.userInputs.filter((item) => item.status === 'pending') ?? [],
  )
  function setCardCollapsed(id: string, value: boolean): void {
    if (value) state.collapsedCards[id] = true
    else delete state.collapsedCards[id]
    const keys = Object.keys(state.collapsedCards)
    if (keys.length > 100 && keys[0]) delete state.collapsedCards[keys[0]]
  }
  function inputReply(id: string): UserInputAnswer {
    return state.inputReplies[id] ?? { optionIndex: null, text: '', skipped: false }
  }
  function setInputReply(id: string, value: UserInputAnswer): void {
    if (!pendingInputs.value.some((item) => item.id === id)) return
    state.inputReplies[id] = value
    const keys = Object.keys(state.inputReplies)
    if (keys.length > 100 && keys[0]) delete state.inputReplies[keys[0]]
  }
  const workspace = computed(
    () => state.workspaces.find((item) => item.id === state.workspaceId) ?? null,
  )
  const title = computed(
    () =>
      state.detail?.conversation.title ||
      (workspace.value ? `${workspace.value.name} · 新对话` : '新对话'),
  )
  function rememberHidden(items: Set<string>, id: string): void {
    items.add(id)
    if (items.size > 1000) {
      const oldest = items.values().next().value
      if (oldest) items.delete(oldest)
    }
  }
  function visibleConversation(item: Conversation, workspaceId: string | null): boolean {
    return (
      item.workspaceId === workspaceId &&
      isVisible(item) &&
      !hiddenConversations.has(item.id) &&
      (!item.workspaceId || !hiddenWorkspaces.has(item.workspaceId))
    )
  }
  function mergeConversation(
    items: Conversation[],
    item: Conversation,
    workspaceId: string | null,
  ): Conversation[] {
    return upsert(items, item)
      .filter((row) => visibleConversation(row, workspaceId))
      .sort(comparePinnedItems)
      .slice(0, 1000)
  }
  function reconcileConversations(items: Conversation[], revision: number): Conversation[] {
    const current = new Map(items.map((item) => [item.id, item]))
    for (const update of conversationUpdates.values())
      if (update.revision > revision) current.set(update.conversation.id, update.conversation)
    const values = [...current.values()]
    for (const item of values) {
      const acceptedRevision = Math.max(revision, conversationUpdates.get(item.id)?.revision ?? 0)
      rememberConversationUpdate({ conversation: item, revision: acceptedRevision })
      if (isVisible(item)) hiddenConversations.delete(item.id)
      else removeConversation(item.id, item.deletedAt !== null)
    }
    return values
  }
  function rememberConversationUpdate(update: ConversationUpdate): void {
    conversationUpdates.delete(update.conversation.id)
    conversationUpdates.set(update.conversation.id, update)
    if (conversationUpdates.size > 1000) {
      const oldest = conversationUpdates.keys().next().value
      if (oldest) conversationUpdates.delete(oldest)
    }
  }
  function reconcileWorkspaces(items: Workspace[], revision: number): Workspace[] {
    const current = new Map(items.map((item) => [item.id, item]))
    for (const update of workspaceUpdates.values())
      if (update.revision > revision) current.set(update.workspace.id, update.workspace)
    const values = [...current.values()]
    // 查询快照也推进逐项版本；否则已被查询覆盖的旧归档通知仍可能隐藏已恢复项目。
    for (const item of values) {
      const acceptedRevision = Math.max(revision, workspaceUpdates.get(item.id)?.revision ?? 0)
      rememberWorkspaceUpdate({ workspace: item, revision: acceptedRevision })
      if (isVisible(item)) hiddenWorkspaces.delete(item.id)
      else removeWorkspace(item.id, item.deletedAt !== null)
    }
    return values
  }
  function rememberWorkspaceUpdate(update: WorkspaceUpdate): void {
    workspaceUpdates.delete(update.workspace.id)
    workspaceUpdates.set(update.workspace.id, update)
    if (workspaceUpdates.size > 1000) {
      const oldest = workspaceUpdates.keys().next().value
      if (oldest) workspaceUpdates.delete(oldest)
    }
  }
  function archivedConversation(item: Conversation): boolean {
    return (
      item.archivedAt !== null &&
      item.deletedAt === null &&
      (!item.workspaceId ||
        (workspaceUpdates.get(item.workspaceId)?.workspace.deletedAt ?? null) === null)
    )
  }
  function removeConversation(conversationId: string, deleted = true): void {
    rememberHidden(hiddenConversations, conversationId)
    if (deleted) {
      delete state.drafts[conversationId]
      draftWorkspaces.delete(conversationId)
    }
    state.conversations = state.conversations.filter((item) => item.id !== conversationId)
    for (const group of Object.values(state.workspaceGroups))
      group.items = group.items.filter((item) => item.id !== conversationId)
    if (state.selectedId === conversationId) newConversation()
  }
  function removeWorkspace(workspaceId: string, deleted = true): void {
    rememberHidden(hiddenWorkspaces, workspaceId)
    if (deleted)
      for (const [key, owner] of draftWorkspaces) {
        if (owner === workspaceId) {
          delete state.drafts[key]
          draftWorkspaces.delete(key)
        }
      }
    delete state.workspaceGroups[workspaceId]
    if (deleted)
      state.archivedConversations = state.archivedConversations.filter(
        (item) => item.workspaceId !== workspaceId,
      )
    state.workspaces = state.workspaces.filter((item) => item.id !== workspaceId)
    if (state.workspaceId === workspaceId) newConversation()
  }
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
    if (change.kind === 'context-usage') {
      if (change.value.conversationId === state.selectedId) state.contextUsageEvent = change.value
      return
    }
    if (change.kind === 'service') {
      state.serviceError = change.error
      return
    }
    if (change.kind === 'workspace') {
      if (event.revision <= (workspaceUpdates.get(change.value.id)?.revision ?? 0)) return
      if (!isVisible(change.value))
        removeWorkspace(change.value.id, change.value.deletedAt !== null)
      else hiddenWorkspaces.delete(change.value.id)
      if (isVisible(change.value) && event.revision > workspaceRevision)
        state.workspaces = upsert(state.workspaces, change.value)
          .sort(comparePinnedItems)
          .slice(0, 1000)
      if (
        state.archivesOpen &&
        state.archiveKind === 'workspaces' &&
        event.revision > archiveRevision
      )
        state.archivedWorkspaces = upsert(state.archivedWorkspaces, change.value)
          .filter((item) => item.archivedAt !== null && item.deletedAt === null)
          .sort(comparePinnedItems)
          .slice(0, 1000)
      rememberWorkspaceUpdate({ workspace: change.value, revision: event.revision })
      return
    }
    if (change.kind === 'conversation') {
      if (event.revision <= (conversationUpdates.get(change.value.id)?.revision ?? 0)) return
      if (!isVisible(change.value))
        removeConversation(change.value.id, change.value.deletedAt !== null)
      else hiddenConversations.delete(change.value.id)
      if (
        state.archivesOpen &&
        state.archiveKind === 'conversations' &&
        event.revision > archiveRevision
      )
        state.archivedConversations = upsert(state.archivedConversations, change.value)
          .filter(archivedConversation)
          .sort(comparePinnedItems)
          .slice(0, 1000)
      if (event.revision > listRevision)
        state.conversations = mergeConversation(state.conversations, change.value, null)
      for (const [workspaceId, group] of Object.entries(state.workspaceGroups)) {
        if (group.loading) {
          group.events.set(change.value.id, event)
          if (group.events.size > 500) {
            group.generation++
            group.loading = false
            group.events.clear()
            group.error = '对话变化较快，请重新加载。'
          }
        }
        if (event.revision > group.revision)
          group.items = mergeConversation(group.items, change.value, workspaceId)
      }
      if (
        event.revision > detailRevision &&
        state.detail?.conversation.id === change.value.id &&
        visibleConversation(change.value, state.workspaceId)
      )
        state.detail.conversation = change.value
      rememberConversationUpdate({ conversation: change.value, revision: event.revision })
      return
    }
    if (
      !state.detail ||
      change.value.conversationId !== state.selectedId ||
      event.revision <= detailRevision
    )
      return
    state.usageActivityRevision++
    if (change.kind === 'messages-removed') {
      state.detail.messages = state.detail.messages.filter(
        (item) => !change.value.messageIds.includes(item.id),
      )
      return
    }
    if (
      change.kind === 'message' &&
      (!state.historical || state.detail.messages.some((item) => item.id === change.value.id))
    )
      state.detail.messages = boundMessages(upsert(state.detail.messages, change.value))
    if (change.kind === 'step')
      state.detail.steps = boundSteps(upsert(state.detail.steps, change.value))
    if (change.kind === 'run') {
      state.detail.runs = upsert(state.detail.runs, change.value)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(-200)
      if (!change.persisted) state.error = '本次执行状态未能完整保存，请重新打开应用后核对历史。'
    }
    if (change.kind === 'directory-grant')
      state.detail.directoryGrants = upsert(state.detail.directoryGrants, change.value).slice(-200)
    if (change.kind === 'approval')
      state.detail.approvals = upsert(state.detail.approvals, change.value).slice(-200)
    if (change.kind === 'user-input') {
      state.detail.userInputs = upsert(state.detail.userInputs, change.value).slice(-200)
      if (change.value.status !== 'pending') {
        delete state.inputReplies[change.value.id]
        delete state.collapsedCards[change.value.id]
      }
    }
  }
  function receive(event: ChatEvent): void {
    const change = event.change
    if ((change.kind === 'conversation' || change.kind === 'workspace') && state.archivesLoading) {
      archiveEvents.set(`${change.kind}:${change.value.id}`, event)
      if (archiveEvents.size > 500) {
        archiveGeneration++
        archiveEvents.clear()
        state.archivesLoading = false
        state.archivesError = '对话变化较快，请重新加载。'
      }
    }
    if (change.kind === 'conversation' && state.loadingList) {
      listEvents.set(change.value.id, event)
      if (listEvents.size > 500) {
        overviewGeneration++
        listEvents.clear()
        state.loadingList = false
        state.serviceError = '对话变化较快，请重新加载。'
      }
    }
    if (change.kind === 'workspace' && state.workspacesLoading) {
      workspaceEvents.set(change.value.id, event)
      if (workspaceEvents.size > 500) {
        workspaceGeneration++
        workspaceEvents.clear()
        state.workspacesLoading = false
        state.workspacesError = '项目变化较快，请重新加载。'
      }
    }
    if (
      state.loading &&
      change.kind !== 'service' &&
      change.kind !== 'conversation' &&
      change.kind !== 'workspace'
    ) {
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
    const requestGeneration = ++overviewGeneration
    const generation = modelGeneration
    const recovering = !!state.serviceError
    if (!more) {
      state.serviceError = ''
      listEvents.clear()
    }
    try {
      const result = unwrap(await getDesktopApi().getChatOverview(more ? listOffset : 0))
      if (disposed || requestGeneration !== overviewGeneration) return
      // 配置页面可能在概览查询期间保存模型，不让迟到的旧列表覆盖已保存配置。
      if (generation === modelGeneration) setModels(result.models)
      listRevision = result.revision
      state.conversations = reconcileConversations(
        more
          ? [
              ...new Map(
                [...state.conversations, ...result.conversations].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.conversations,
        result.revision,
      )
        .filter((item) => visibleConversation(item, null))
        .sort(comparePinnedItems)
        .slice(0, 1000)
      state.hasMore = result.hasMore && state.conversations.length < 1000
      listOffset = (more ? listOffset : 0) + 50
      for (const event of listEvents.values()) if (event.revision > result.revision) apply(event)
      if (recovering && state.selectedId) await openConversation(state.selectedId)
    } catch (error) {
      if (requestGeneration === overviewGeneration && !disposed) state.serviceError = message(error)
    } finally {
      if (!disposed && requestGeneration === overviewGeneration) {
        state.loadingList = false
        listEvents.clear()
      }
    }
  }
  async function refreshWorkspaces(more = false): Promise<void> {
    if (more && state.workspacesLoading) return
    const generation = ++workspaceGeneration
    state.workspacesLoading = true
    state.workspacesError = ''
    workspaceEvents.clear()
    try {
      const result = unwrap(await getDesktopApi().listWorkspaces(more ? workspaceOffset : 0))
      if (disposed || generation !== workspaceGeneration) return
      workspaceRevision = result.revision
      state.workspaces = reconcileWorkspaces(
        more
          ? [
              ...new Map(
                [...state.workspaces, ...result.workspaces].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.workspaces,
        result.revision,
      )
        .filter((item) => isVisible(item) && !hiddenWorkspaces.has(item.id))
        .sort(comparePinnedItems)
        .slice(0, 1000)
      state.workspacesHasMore = result.hasMore && state.workspaces.length < 1000
      workspaceOffset = (more ? workspaceOffset : 0) + 50
      for (const event of workspaceEvents.values())
        if (event.revision > result.revision) apply(event)
    } catch (error) {
      if (!disposed && generation === workspaceGeneration) state.workspacesError = message(error)
    } finally {
      if (!disposed && generation === workspaceGeneration) {
        state.workspacesLoading = false
        workspaceEvents.clear()
      }
    }
  }
  async function loadWorkspaceConversations(workspaceId: string, more = false): Promise<void> {
    const group = state.workspaceGroups[workspaceId]
    if (!group || (more && group.loading)) return
    const generation = ++group.generation
    group.loading = true
    group.error = ''
    group.events.clear()
    try {
      const result = unwrap(
        await getDesktopApi().getWorkspaceConversations(workspaceId, more ? group.offset : 0),
      )
      if (
        disposed ||
        group !== state.workspaceGroups[workspaceId] ||
        generation !== group.generation
      )
        return
      group.items = reconcileConversations(
        more
          ? [
              ...new Map(
                [...group.items, ...result.conversations].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.conversations,
        result.revision,
      )
        .filter((item) => visibleConversation(item, workspaceId))
        .sort(comparePinnedItems)
        .slice(0, 1000)
      group.revision = result.revision
      group.offset = (more ? group.offset : 0) + 50
      group.hasMore = result.hasMore && group.items.length < 1000
      for (const event of group.events.values()) if (event.revision > result.revision) apply(event)
    } catch (error) {
      if (
        !disposed &&
        group === state.workspaceGroups[workspaceId] &&
        generation === group.generation
      )
        group.error = message(error)
    } finally {
      if (generation === group.generation) {
        group.loading = false
        group.events.clear()
      }
    }
  }
  function expandWorkspace(workspaceId: string): void {
    if (state.workspaceGroups[workspaceId]?.expanded) return
    if (!state.workspaceGroups[workspaceId]) {
      // 仅保留 20 个分组缓存；移除分组不会删除草稿或后端记录。
      if (Object.keys(state.workspaceGroups).length >= 20) {
        const oldest = Object.keys(state.workspaceGroups).find((id) => id !== state.workspaceId)
        if (oldest) delete state.workspaceGroups[oldest]
      }
      state.workspaceGroups[workspaceId] = {
        items: [],
        loading: false,
        error: '',
        hasMore: false,
        offset: 0,
        revision: 0,
        generation: 0,
        expanded: true,
        events: new Map(),
      }
    } else state.workspaceGroups[workspaceId]!.expanded = true
    void loadWorkspaceConversations(workspaceId)
  }
  function toggleWorkspace(workspaceId: string): void {
    const group = state.workspaceGroups[workspaceId]
    if (group?.expanded) group.expanded = false
    else expandWorkspace(workspaceId)
  }
  async function manage<T>(action: () => Promise<ChatResult<T>>): Promise<T> {
    if (state.managing) throw new Error('正在保存，请稍候。')
    state.managing = true
    try {
      return unwrap(await action())
    } finally {
      state.managing = false
    }
  }
  async function createWorkspace(input: WorkspaceInput, selectionId: string): Promise<Workspace> {
    const result = await manage(() => getDesktopApi().createWorkspace(input, selectionId))
    if (!disposed) {
      hiddenWorkspaces.delete(result.id)
      state.workspaces = upsert(state.workspaces, result)
        .filter(isVisible)
        .sort(comparePinnedItems)
        .slice(0, 1000)
      expandWorkspace(result.id)
    }
    return result
  }
  async function updateWorkspace(
    workspaceId: string,
    input: WorkspaceChange,
    selectionId?: string,
  ): Promise<void> {
    const result = await manage(() =>
      getDesktopApi().updateWorkspace(workspaceId, input, selectionId),
    )
    if (!disposed)
      apply({ revision: result.revision, change: { kind: 'workspace', value: result.workspace } })
  }
  async function deleteWorkspace(workspaceId: string): Promise<void> {
    await manage(() => getDesktopApi().deleteWorkspace(workspaceId))
    if (!disposed) {
      removeWorkspace(workspaceId)
      void refreshWorkspaces()
    }
  }
  async function renameConversation(conversationId: string, name: string): Promise<void> {
    const result = await manage(() => getDesktopApi().renameConversation(conversationId, name))
    if (disposed) return
    state.conversations = mergeConversation(state.conversations, result, null)
    for (const [workspaceId, group] of Object.entries(state.workspaceGroups))
      group.items = mergeConversation(group.items, result, workspaceId)
    if (state.detail?.conversation.id === result.id) state.detail.conversation = result
  }
  async function updateWorkspaceFlag(
    workspaceId: string,
    change: { pinned: boolean } | { archived: boolean },
  ): Promise<void> {
    const result = await manage(() =>
      'pinned' in change
        ? getDesktopApi().setWorkspacePinned(workspaceId, change.pinned)
        : getDesktopApi().setWorkspaceArchived(workspaceId, change.archived),
    )
    if (disposed) return
    apply({ revision: result.revision, change: { kind: 'workspace', value: result.workspace } })
    if ('archived' in change && !change.archived) expandWorkspace(workspaceId)
    void refreshWorkspaces()
    if (state.archivesOpen) await refreshArchives()
  }
  function setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<void> {
    return updateWorkspaceFlag(workspaceId, { pinned })
  }
  function setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<void> {
    return updateWorkspaceFlag(workspaceId, { archived })
  }
  async function deleteConversation(conversationId: string): Promise<void> {
    const result = await manage(() => getDesktopApi().deleteConversation(conversationId))
    if (!disposed) {
      removeConversation(conversationId)
      if (result.workspaceId) void loadWorkspaceConversations(result.workspaceId)
      else void refreshOverview()
    }
  }
  async function updateConversationFlag(
    conversationId: string,
    change: { pinned: boolean } | { archived: boolean },
  ): Promise<void> {
    const result = await manage(() =>
      'pinned' in change
        ? getDesktopApi().setConversationPinned(conversationId, change.pinned)
        : getDesktopApi().setConversationArchived(conversationId, change.archived),
    )
    if (disposed) return
    apply({
      revision: result.revision,
      change: { kind: 'conversation', value: result.conversation },
    })
    // 变更排序或过滤条件后从第一页重读，不能沿用之前的偏移跳过记录。
    if (result.conversation.workspaceId)
      void loadWorkspaceConversations(result.conversation.workspaceId)
    else void refreshOverview()
    if (state.archivesOpen) await refreshArchives()
  }
  function setConversationPinned(conversationId: string, pinned: boolean): Promise<void> {
    return updateConversationFlag(conversationId, { pinned })
  }
  function setConversationArchived(conversationId: string, archived: boolean): Promise<void> {
    return updateConversationFlag(conversationId, { archived })
  }
  function openArchives(): void {
    state.archivesOpen = true
    state.archiveKind = 'conversations'
    void refreshArchives()
  }
  function changeArchiveKind(kind: 'conversations' | 'workspaces'): void {
    if (kind === state.archiveKind || state.managing) return
    state.archiveKind = kind
    state.archivedConversations = []
    state.archivedWorkspaces = []
    state.archivesHasMore = false
    void refreshArchives()
  }
  function closeArchives(): void {
    state.archivesOpen = false
    archiveGeneration++
    archiveEvents.clear()
    state.archivedConversations = []
    state.archivedWorkspaces = []
    state.archivesLoading = false
    state.archivesError = ''
    state.archivesHasMore = false
  }
  async function refreshArchives(more = false): Promise<void> {
    if (!state.archivesOpen || (more && state.archivesLoading)) return
    const generation = ++archiveGeneration
    state.archivesLoading = true
    state.archivesError = ''
    archiveEvents.clear()
    try {
      const result = unwrap<WorkspacePage | ConversationPage>(
        await (state.archiveKind === 'workspaces'
          ? getDesktopApi().listArchivedWorkspaces(more ? archiveOffset : 0)
          : getDesktopApi().listArchivedConversations(more ? archiveOffset : 0)),
      )
      if (disposed || generation !== archiveGeneration || !state.archivesOpen) return
      if ('workspaces' in result) {
        const items = more
          ? [
              ...new Map(
                [...state.archivedWorkspaces, ...result.workspaces].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.workspaces
        state.archivedWorkspaces = reconcileWorkspaces(items, result.revision)
          .filter((item) => item.archivedAt !== null && item.deletedAt === null)
          .sort(comparePinnedItems)
          .slice(0, 1000)
      } else {
        const items = more
          ? [
              ...new Map(
                [...state.archivedConversations, ...result.conversations].map((item) => [
                  item.id,
                  item,
                ]),
              ).values(),
            ]
          : result.conversations
        state.archivedConversations = reconcileConversations(items, result.revision)
          .filter(archivedConversation)
          .sort(comparePinnedItems)
          .slice(0, 1000)
      }
      archiveRevision = result.revision
      archiveOffset = (more ? archiveOffset : 0) + 50
      const count =
        state.archiveKind === 'workspaces'
          ? state.archivedWorkspaces.length
          : state.archivedConversations.length
      state.archivesHasMore = result.hasMore && count < 1000
      for (const event of archiveEvents.values()) if (event.revision > result.revision) apply(event)
    } catch (error) {
      if (!disposed && generation === archiveGeneration) state.archivesError = message(error)
    } finally {
      if (generation === archiveGeneration) {
        state.archivesLoading = false
        archiveEvents.clear()
      }
    }
  }
  function newConversation(workspaceId: string | null = null): void {
    selection++
    state.editing = null
    state.directoriesLoading = false
    state.directoriesOffset = 0
    state.directoriesError = ''
    state.selectedId = null
    state.workspaceId = workspaceId
    selectAvailableModel()
    state.detail = null
    state.loading = false
    state.error = ''
    state.historical = false
    state.cancelling = false
    pendingEvents.clear()
  }
  function selectDraftProject(workspaceId: string | null): boolean {
    if (
      state.selectedId ||
      state.loading ||
      state.sending ||
      state.managing ||
      state.serviceError ||
      (workspaceId !== null && !state.workspaces.some((item) => item.id === workspaceId))
    )
      return false
    if (workspaceId !== state.workspaceId) newConversation(workspaceId)
    if (workspaceId) expandWorkspace(workspaceId)
    return true
  }
  async function openConversation(conversationId: string): Promise<void> {
    if (state.selectedId !== conversationId) state.editing = null
    const token = ++selection
    state.directoriesLoading = false
    state.directoriesOffset = 0
    state.directoriesError = ''
    detailRevision = 0
    state.selectedId = conversationId
    const known =
      state.conversations.find((item) => item.id === conversationId) ??
      Object.values(state.workspaceGroups)
        .flatMap((group) => group.items)
        .find((item) => item.id === conversationId)
    if (known) state.workspaceId = known.workspaceId
    state.detail = null
    state.loading = true
    state.error = ''
    state.historical = false
    state.cancelling = false
    pendingEvents.clear()
    try {
      const result = unwrap(await getDesktopApi().getConversation(conversationId))
      if (disposed || token !== selection) return
      const update = conversationUpdates.get(conversationId)
      if (update && update.revision > result.revision) result.conversation = update.conversation
      if (!isVisible(result.conversation)) {
        newConversation()
        return
      }
      state.detail = result
      state.workspaceId = result.conversation.workspaceId
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
  function refreshExecutionSettings(): Promise<ExecutionSettings | null> {
    if (executionSettingsRequest) return executionSettingsRequest
    if (state.executionSettingsSaving) return Promise.resolve(null)
    state.executionSettingsLoading = true
    executionSettingsRequest = readExecutionSettings().finally(() => {
      executionSettingsRequest = null
      if (!disposed) state.executionSettingsLoading = false
    })
    return executionSettingsRequest
  }
  async function readExecutionSettings(): Promise<ExecutionSettings | null> {
    try {
      const settings = unwrap(await getDesktopApi().getExecutionSettings())
      if (disposed) return null
      state.executionSettings = settings
      state.executionSettingsError = ''
      return settings
    } catch (error) {
      if (!disposed) state.executionSettingsError = message(error)
      return null
    }
  }
  async function saveExecutionSettings(next: ExecutionSettings): Promise<ExecutionSettings> {
    if (
      state.executionSettingsSaving ||
      state.executionSettingsLoading ||
      state.sending ||
      state.resending ||
      state.compacting ||
      state.serviceError
    )
      throw new Error('任务或权限设置正在更新，请稍后重试。')
    state.executionSettingsSaving = true
    try {
      const settings = unwrap(await getDesktopApi().updateExecutionSettings({ ...next }))
      if (!disposed) {
        state.executionSettings = settings
        state.executionSettingsError = ''
      }
      return settings
    } catch (error) {
      if (!disposed) state.executionSettingsError = message(error)
      throw error
    } finally {
      if (!disposed) state.executionSettingsSaving = false
    }
  }
  async function send(): Promise<void> {
    if (state.executionSettingsSaving) return
    if (isCompactCommand(draft.value)) {
      await compact(true)
      return
    }
    if (
      state.sending ||
      state.resending ||
      state.compacting ||
      state.editing ||
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
    const key = draftKey()
    const workspaceId = conversationId ? null : state.workspaceId
    try {
      const result = unwrap(
        await getDesktopApi().sendMessage({
          conversationId,
          workspaceId,
          text,
          modelId: state.modelId,
        }),
      )
      if (state.drafts[key] === text) {
        delete state.drafts[key]
        draftWorkspaces.delete(key)
      }
      if (token === selection && !disposed) await openConversation(result.conversationId)
      // 受理响应不等于完成；执行状态完全由后端事件及查询决定。
    } catch (error) {
      if (token === selection) state.error = message(error)
    } finally {
      state.sending = false
    }
  }
  async function compact(consumeCommand = false): Promise<void> {
    if (compactUnavailable.value || !state.selectedId) return
    const conversationId = state.selectedId,
      modelId = state.modelId,
      token = selection,
      key = draftKey(),
      command = draft.value
    state.compacting = conversationId
    state.error = ''
    try {
      const result = unwrap(await getDesktopApi().compactConversation({ conversationId, modelId }))
      if (result.conversationId !== conversationId) throw new Error('压缩受理结果归属不匹配。')
      // 受理后仅消耗原命令；切换会话或期间输入的新草稿不能被清除。
      if (consumeCommand && state.drafts[key] === command && matchesCompactCommand(command)) {
        delete state.drafts[key]
        draftWorkspaces.delete(key)
      }
      if (!disposed && token === selection) {
        const reload = openConversation(conversationId)
        const reloadingSelection = selection
        await reload
        if (!disposed && selection === reloadingSelection) state.modelId = modelId
      }
    } catch (error) {
      if (!disposed && token === selection) state.error = message(error)
    } finally {
      if (state.compacting === conversationId) state.compacting = ''
    }
  }
  function startEditing(messageId: string): void {
    const target = lastUserMessage.value
    if (
      editUnavailable.value ||
      !target ||
      target.id !== messageId ||
      target.content.some((block) => block.type !== 'text')
    )
      return
    const text = messageText(target.content)
    state.editing = { messageId, originalText: text, text, error: '' }
  }
  function cancelEditing(): void {
    if (!state.resending) state.editing = null
  }
  async function resend(): Promise<void> {
    const edit = state.editing,
      conversationId = state.selectedId,
      target = lastUserMessage.value
    if (!edit || !conversationId || editUnavailable.value || state.executionSettingsSaving) return
    if (
      !target ||
      edit.messageId !== target.id ||
      edit.originalText !== messageText(target.content)
    ) {
      edit.error = '原提问已变化，请取消编辑并重新加载对话后核对。'
      return
    }
    if (!edit.text.trim() || edit.text.trim().length > MAX_MESSAGE_LENGTH) {
      edit.error = '消息不能为空，且不能超过 100000 个字符。'
      return
    }
    if (
      state.modelsLoading ||
      state.modelError ||
      !state.models.some((item) => item.id === state.modelId)
    ) {
      edit.error = '请选择可用模型后重新发送。'
      return
    }
    const token = selection
    state.resending = true
    edit.error = ''
    try {
      unwrap(
        await getDesktopApi().resendMessage({
          conversationId,
          messageId: edit.messageId,
          modelId: state.modelId,
          text: edit.text,
        }),
      )
      if (!disposed && selection === token && state.selectedId === conversationId) {
        state.editing = null
        await openConversation(conversationId)
      }
    } catch (error) {
      if (!disposed && selection === token && state.editing === edit) edit.error = message(error)
    } finally {
      state.resending = false
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
  async function decide(
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: ApprovalScope = 'once',
  ): Promise<void> {
    if (state.deciding) return
    state.deciding = approvalId
    state.error = ''
    const conversationId = state.selectedId
    try {
      unwrap(await getDesktopApi().decideApproval(approvalId, decision, scope))
    } catch (error) {
      if (conversationId === state.selectedId) state.error = message(error)
    } finally {
      state.deciding = ''
    }
  }
  async function loadDirectories(offset = 0): Promise<void> {
    const conversationId = state.selectedId
    if (!conversationId || state.directoriesLoading) return
    const currentSelection = selection
    const before = new Map(state.detail?.directoryGrants.map((grant) => [grant.id, grant]))
    state.directoriesLoading = true
    state.directoriesError = ''
    try {
      const values = unwrap(await getDesktopApi().listDirectoryGrants(conversationId, offset))
      if (
        !disposed &&
        selection === currentSelection &&
        state.detail?.conversation.id === conversationId
      ) {
        // 查询期间收到的新增或撤销通知优先于早先生成的列表快照。
        const changed = state.detail.directoryGrants.filter(
          (grant) => before.get(grant.id) !== grant,
        )
        state.detail.directoryGrants = changed.reduce(
          (items, grant) => upsert(items, grant),
          values,
        )
        state.directoriesOffset = offset
      }
    } catch (error) {
      if (!disposed && selection === currentSelection && conversationId === state.selectedId)
        state.directoriesError = message(error)
    } finally {
      if (!disposed && selection === currentSelection) state.directoriesLoading = false
    }
  }
  async function revokeDirectory(grantId: string): Promise<void> {
    const conversationId = state.selectedId
    if (!conversationId || state.revokingDirectory) return
    state.revokingDirectory = grantId
    state.directoriesError = ''
    try {
      const value = unwrap(await getDesktopApi().revokeDirectoryGrant(conversationId, grantId))
      if (state.detail?.conversation.id === conversationId)
        state.detail.directoryGrants = upsert(state.detail.directoryGrants, value)
    } catch (error) {
      if (conversationId === state.selectedId) state.directoriesError = message(error)
    } finally {
      state.revokingDirectory = ''
    }
  }
  async function submitInput(inputId: string, skipped: boolean): Promise<void> {
    const input = pendingInputs.value.find((item) => item.id === inputId)
    const run = activeRun.value
    if (
      !input ||
      !run ||
      run.id !== input.runId ||
      input.conversationId !== state.selectedId ||
      state.replying ||
      state.loading ||
      state.serviceError ||
      state.cancelling
    )
      return
    state.replying = inputId
    state.error = ''
    try {
      const reply = inputReply(inputId)
      // 跨进程只发送普通快照，不能把 Vue 的响应式代理交给 structured clone。
      const answer: UserInputAnswer = skipped
        ? { optionIndex: null, text: '', skipped: true }
        : { optionIndex: reply.optionIndex, text: reply.text, skipped: false }
      const result = unwrap(await getDesktopApi().submitUserInput(inputId, run.id, answer))
      if (!disposed) {
        delete state.inputReplies[inputId]
        delete state.collapsedCards[inputId]
        if (state.detail?.conversation.id === input.conversationId)
          state.detail.userInputs = upsert(state.detail.userInputs, result).slice(-200)
      }
    } catch (error) {
      if (!disposed && state.selectedId === input.conversationId) state.error = message(error)
    } finally {
      if (state.replying === inputId) state.replying = ''
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
    void refreshWorkspaces()
    void refreshExecutionSettings()
  })
  onScopeDispose(() => {
    disposed = true
    selection++
    overviewGeneration++
    workspaceGeneration++
    archiveGeneration++
    unsubscribe?.()
    pendingEvents.clear()
    listEvents.clear()
    workspaceEvents.clear()
    archiveEvents.clear()
    conversationUpdates.clear()
    workspaceUpdates.clear()
  })
  return {
    state,
    draft,
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
    title,
    workspace,
    refreshWorkspaces,
    toggleWorkspace,
    expandWorkspace,
    loadWorkspaceConversations,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    renameConversation,
    deleteConversation,
    setConversationPinned,
    setConversationArchived,
    setWorkspacePinned,
    setWorkspaceArchived,
    changeArchiveKind,
    openArchives,
    closeArchives,
    refreshArchives,
    newConversation,
    selectDraftProject,
    openConversation,
    refreshOverview,
    refreshExecutionSettings,
    saveExecutionSettings,
    refreshModels,
    setModels,
    send,
    cancel,
    decide,
    loadDirectories,
    revokeDirectory,
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
