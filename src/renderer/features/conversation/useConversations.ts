import { computed, inject, onMounted, onScopeDispose, provide, reactive } from 'vue'
import type { InjectionKey } from 'vue'
import { isActiveRun, isVisible } from '@shared/chat'
import { boundSteps } from '@shared/steps'
import type {
  ChatEvent,
  ApprovalScope,
  ChatMessage,
  ChatModel,
  ChatResult,
  Conversation,
  ConversationDetail,
  Workspace,
  WorkspaceInput,
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
    modelId: '',
    detail: null as ConversationDetail | null,
    loading: true,
    loadingList: true,
    sending: false,
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
  let overviewGeneration = 0,
    workspaceGeneration = 0,
    workspaceOffset = 0,
    workspaceRevision = 0
  const workspaceEvents = new Map<string, ChatEvent>()
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
  const pendingApprovals = computed(
    () => state.detail?.approvals.filter((item) => item.status === 'pending') ?? [],
  )
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
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .slice(0, 1000)
  }
  function removeConversation(conversationId: string): void {
    rememberHidden(hiddenConversations, conversationId)
    delete state.drafts[conversationId]
    draftWorkspaces.delete(conversationId)
    state.conversations = state.conversations.filter((item) => item.id !== conversationId)
    for (const group of Object.values(state.workspaceGroups))
      group.items = group.items.filter((item) => item.id !== conversationId)
    if (state.selectedId === conversationId) newConversation()
  }
  function removeWorkspace(workspaceId: string): void {
    rememberHidden(hiddenWorkspaces, workspaceId)
    for (const [key, owner] of draftWorkspaces) {
      if (owner === workspaceId) {
        delete state.drafts[key]
        draftWorkspaces.delete(key)
      }
    }
    delete state.workspaceGroups[workspaceId]
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
    if (change.kind === 'service') {
      state.serviceError = change.error
      return
    }
    if (change.kind === 'workspace') {
      if (event.revision <= workspaceRevision) return
      if (!isVisible(change.value)) removeWorkspace(change.value.id)
      else if (!hiddenWorkspaces.has(change.value.id))
        state.workspaces = upsert(state.workspaces, change.value)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 1000)
      return
    }
    if (change.kind === 'conversation') {
      if (!isVisible(change.value)) removeConversation(change.value.id)
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
      state.conversations = (
        more
          ? [
              ...new Map(
                [...state.conversations, ...result.conversations].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.conversations
      )
        .filter((item) => visibleConversation(item, null))
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
      state.workspaces = (
        more
          ? [
              ...new Map(
                [...state.workspaces, ...result.workspaces].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.workspaces
      )
        .filter((item) => isVisible(item) && !hiddenWorkspaces.has(item.id))
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
      group.items = (
        more
          ? [
              ...new Map(
                [...group.items, ...result.conversations].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.conversations
      )
        .filter((item) => visibleConversation(item, workspaceId))
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
  async function createWorkspace(input: WorkspaceInput): Promise<Workspace> {
    const result = await manage(() => getDesktopApi().createWorkspace(input))
    if (!disposed) {
      hiddenWorkspaces.delete(result.id)
      state.workspaces = upsert(state.workspaces, result)
        .filter(isVisible)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 1000)
      expandWorkspace(result.id)
    }
    return result
  }
  async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const result = await manage(() => getDesktopApi().renameWorkspace(workspaceId, name))
    if (!disposed && !hiddenWorkspaces.has(workspaceId))
      state.workspaces = upsert(state.workspaces, result)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 1000)
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
  async function deleteConversation(conversationId: string): Promise<void> {
    const result = await manage(() => getDesktopApi().deleteConversation(conversationId))
    if (!disposed) {
      removeConversation(conversationId)
      if (result.workspaceId) void loadWorkspaceConversations(result.workspaceId)
      else void refreshOverview()
    }
  }
  function newConversation(workspaceId: string | null = null): void {
    selection++
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
  })
  onScopeDispose(() => {
    disposed = true
    selection++
    overviewGeneration++
    workspaceGeneration++
    unsubscribe?.()
    pendingEvents.clear()
    listEvents.clear()
    workspaceEvents.clear()
  })
  return {
    state,
    draft,
    activeRun,
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
    renameWorkspace,
    deleteWorkspace,
    renameConversation,
    deleteConversation,
    newConversation,
    selectDraftProject,
    openConversation,
    refreshOverview,
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
