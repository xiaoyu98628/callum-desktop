import type {
  ChatEvent,
  ChatModel,
  ChatResult,
  Conversation,
  ConversationPage,
  ConversationUpdate,
  Workspace,
  WorkspaceChange,
  WorkspaceInput,
  WorkspacePage,
  WorkspaceUpdate,
} from '../../../shared/chat.ts'
import { comparePinnedItems, isVisible } from '../../../shared/chat.ts'
import { upsert } from '../../../shared/keyed-list.ts'
import { getDesktopApi } from '../../lib/desktop.ts'
import { unwrap } from '../../lib/result.ts'
import {
  bufferListEvent,
  cancelListQuery,
  createListQuery,
  ListPagination,
  mergeListPage,
  replayListEvents,
  startListQuery,
} from './state-utils.ts'
import type { ConversationState } from './state.ts'

/** 侧栏与归档的查询版本、分页失效和管理快照由同一持有者协调。 */
export function createConversationLists(
  state: ConversationState,
  hooks: {
    disposed: () => boolean
    modelGeneration: () => number
    setModels: (models: ChatModel[]) => void
    recover: (id: string) => Promise<void>
    newConversation: () => void
    clearConversation: (id: string) => void
    clearWorkspace: (id: string) => void
    onConversation: (item: Conversation, revision: number) => void
  },
) {
  const overviewQuery = createListQuery()
  const workspaceQuery = createListQuery()
  const archiveQuery = createListQuery()
  const listPagination = new ListPagination()
  const workspacePagination = new ListPagination()
  const archivePagination = new ListPagination()
  let listRevision = 0
  let workspaceRevision = 0,
    archiveRevision = 0
  // 通知和管理快照有界保留，防止迟到通知或旧查询撤销已接受的用户操作。
  const conversationUpdates = new Map<string, ConversationUpdate>()
  const workspaceUpdates = new Map<string, WorkspaceUpdate>()
  const hiddenConversations = new Set<string>()
  const hiddenWorkspaces = new Set<string>()
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
    if (deleted) hooks.clearConversation(conversationId)
    state.conversations = state.conversations.filter((item) => item.id !== conversationId)
    for (const group of Object.values(state.workspaceGroups))
      group.items = group.items.filter((item) => item.id !== conversationId)
    if (state.selectedId === conversationId) hooks.newConversation()
  }
  function removeWorkspace(workspaceId: string, deleted = true): void {
    rememberHidden(hiddenWorkspaces, workspaceId)
    if (deleted) hooks.clearWorkspace(workspaceId)
    delete state.workspaceGroups[workspaceId]
    if (deleted)
      state.archivedConversations = state.archivedConversations.filter(
        (item) => item.workspaceId !== workspaceId,
      )
    state.workspaces = state.workspaces.filter((item) => item.id !== workspaceId)
    if (state.workspaceId === workspaceId) hooks.newConversation()
  }
  function apply(event: ChatEvent): void {
    const change = event.change
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
        if (group.loading && !bufferListEvent(group, event)) {
          group.loading = false
          group.error = '对话变化较快，请重新加载。'
        }
        if (event.revision > group.revision)
          group.items = mergeConversation(group.items, change.value, workspaceId)
      }
      hooks.onConversation(change.value, event.revision)
      rememberConversationUpdate({ conversation: change.value, revision: event.revision })
      return
    }
  }
  function receive(event: ChatEvent): void {
    const change = event.change
    // 服务端按实时排序分页。快照可合并已经收到的变更，但无法用旧偏移找到被前移的未加载记录。
    if (change.kind === 'conversation') {
      const group = change.value.workspaceId && state.workspaceGroups[change.value.workspaceId]
      if (group && group.pagination.invalidate()) group.hasMore = true
      if (!change.value.workspaceId && listPagination.invalidate()) state.hasMore = true
      if (
        state.archivesOpen &&
        state.archiveKind === 'conversations' &&
        archivePagination.invalidate()
      )
        state.archivesHasMore = true
    } else if (change.kind === 'workspace') {
      if (workspacePagination.invalidate()) state.workspacesHasMore = true
      if (
        state.archivesOpen &&
        (state.archiveKind === 'workspaces' || change.value.deletedAt !== null) &&
        archivePagination.invalidate()
      )
        state.archivesHasMore = true
    }
    if (
      (change.kind === 'conversation' || change.kind === 'workspace') &&
      state.archivesLoading &&
      !bufferListEvent(archiveQuery, event)
    ) {
      state.archivesLoading = false
      state.archivesError = '对话变化较快，请重新加载。'
    }
    if (
      change.kind === 'conversation' &&
      state.loadingList &&
      !bufferListEvent(overviewQuery, event)
    ) {
      state.loadingList = false
      state.serviceError = '对话变化较快，请重新加载。'
    }
    if (
      change.kind === 'workspace' &&
      state.workspacesLoading &&
      !bufferListEvent(workspaceQuery, event)
    ) {
      state.workspacesLoading = false
      state.workspacesError = '项目变化较快，请重新加载。'
    }
  }
  async function refreshOverview(more = false): Promise<void> {
    if (state.loadingList && more) return
    const request = startListQuery(overviewQuery)
    const current = () => !hooks.disposed() && request.isCurrent()
    state.loadingList = true
    const generation = hooks.modelGeneration()
    const recovering = !!state.serviceError
    try {
      const loaded = await listPagination.load(
        more,
        current,
        (offset) => {
          if (!offset) state.serviceError = ''
          return getDesktopApi().getChatOverview(offset)
        },
        (result, append) => {
          // 配置页面可能在概览查询期间保存模型，不让迟到的旧列表覆盖已保存配置。
          if (generation === hooks.modelGeneration()) hooks.setModels(result.models)
          listRevision = result.revision
          state.conversations = reconcileConversations(
            mergeListPage(state.conversations, result.conversations, append),
            result.revision,
          )
            .filter((item) => visibleConversation(item, null))
            .sort(comparePinnedItems)
            .slice(0, 1000)
          state.hasMore = result.hasMore && state.conversations.length < 1000
          replayListEvents(overviewQuery, result.revision, apply)
          return state.hasMore
        },
      )
      if (loaded && current() && recovering && state.selectedId)
        await hooks.recover(state.selectedId)
    } catch (error) {
      if (current()) state.serviceError = message(error)
    } finally {
      if (!hooks.disposed() && request.finish()) state.loadingList = false
    }
  }
  async function refreshWorkspaces(more = false): Promise<void> {
    if (more && state.workspacesLoading) return
    const request = startListQuery(workspaceQuery)
    const current = () => !hooks.disposed() && request.isCurrent()
    state.workspacesLoading = true
    state.workspacesError = ''
    try {
      await workspacePagination.load(
        more,
        current,
        (offset) => getDesktopApi().listWorkspaces(offset),
        (result, append) => {
          workspaceRevision = result.revision
          state.workspaces = reconcileWorkspaces(
            mergeListPage(state.workspaces, result.workspaces, append),
            result.revision,
          )
            .filter((item) => isVisible(item) && !hiddenWorkspaces.has(item.id))
            .sort(comparePinnedItems)
            .slice(0, 1000)
          state.workspacesHasMore = result.hasMore && state.workspaces.length < 1000
          replayListEvents(workspaceQuery, result.revision, apply)
          return state.workspacesHasMore
        },
      )
    } catch (error) {
      if (current()) state.workspacesError = message(error)
    } finally {
      if (!hooks.disposed() && request.finish()) state.workspacesLoading = false
    }
  }
  async function loadWorkspaceConversations(workspaceId: string, more = false): Promise<void> {
    const group = state.workspaceGroups[workspaceId]
    if (!group?.expanded || (more && group.loading)) return
    const request = startListQuery(group)
    const current = () =>
      !hooks.disposed() && group === state.workspaceGroups[workspaceId] && request.isCurrent()
    group.loading = true
    group.error = ''
    try {
      await group.pagination.load(
        more,
        current,
        (offset) => getDesktopApi().getWorkspaceConversations(workspaceId, offset),
        (result, append) => {
          group.items = reconcileConversations(
            mergeListPage(group.items, result.conversations, append),
            result.revision,
          )
            .filter((item) => visibleConversation(item, workspaceId))
            .sort(comparePinnedItems)
            .slice(0, 1000)
          group.revision = result.revision
          group.hasMore = result.hasMore && group.items.length < 1000
          replayListEvents(group, result.revision, apply)
          return group.hasMore
        },
      )
    } catch (error) {
      if (current()) group.error = message(error)
    } finally {
      if (request.finish()) group.loading = false
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
        pagination: new ListPagination(),
        revision: 0,
        expanded: true,
        ...createListQuery(),
      }
    } else state.workspaceGroups[workspaceId]!.expanded = true
    void loadWorkspaceConversations(workspaceId)
  }
  function toggleWorkspace(workspaceId: string): void {
    const group = state.workspaceGroups[workspaceId]
    if (group?.expanded) {
      group.expanded = false
      cancelListQuery(group)
      group.loading = false
    } else expandWorkspace(workspaceId)
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
    if (!hooks.disposed()) {
      workspacePagination.invalidate()
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
    if (!hooks.disposed())
      apply({ revision: result.revision, change: { kind: 'workspace', value: result.workspace } })
  }
  async function deleteWorkspace(workspaceId: string): Promise<void> {
    await manage(() => getDesktopApi().deleteWorkspace(workspaceId))
    if (!hooks.disposed()) {
      removeWorkspace(workspaceId)
      void refreshWorkspaces()
    }
  }
  async function renameConversation(conversationId: string, name: string): Promise<void> {
    const result = await manage(() => getDesktopApi().renameConversation(conversationId, name))
    if (hooks.disposed()) return
    if (result.workspaceId) state.workspaceGroups[result.workspaceId]?.pagination.invalidate()
    else listPagination.invalidate()
    state.conversations = mergeConversation(state.conversations, result, null)
    for (const [workspaceId, group] of Object.entries(state.workspaceGroups))
      group.items = mergeConversation(group.items, result, workspaceId)
    if (state.detail?.conversation.id === result.id) state.detail.conversation = result
  }
  async function moveConversation(item: Conversation, workspaceId: string | null): Promise<void> {
    const result = await manage(() => getDesktopApi().moveConversation(item.id, workspaceId))
    if (hooks.disposed()) return
    apply({
      revision: result.revision,
      change: { kind: 'conversation', value: result.conversation },
    })
    // 两边的成员变化会移动后续页的偏移，从首页重读并废弃在途分页。
    void refreshOverview()
    const projectId = result.conversation.workspaceId ?? item.workspaceId
    if (projectId) void loadWorkspaceConversations(projectId)
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
    if (hooks.disposed()) return
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
    if (hooks.disposed()) return
    removeConversation(conversationId)
    if (result.workspaceId) void loadWorkspaceConversations(result.workspaceId)
    else void refreshOverview()
    if (state.archivesOpen && state.archiveKind === 'conversations') {
      state.archivedConversations = state.archivedConversations.filter(
        (item) => item.id !== conversationId,
      )
      // 删除会让归档列表中的后续条目前移，从首页重读并废弃在途分页。
      void refreshArchives()
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
    if (hooks.disposed()) return
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
    cancelListQuery(archiveQuery)
    state.archivedConversations = []
    state.archivedWorkspaces = []
    state.archivesLoading = false
    state.archivesError = ''
    state.archivesHasMore = false
  }
  async function refreshArchives(more = false): Promise<void> {
    if (!state.archivesOpen || (more && state.archivesLoading)) return
    const kind = state.archiveKind
    const request = startListQuery(archiveQuery)
    const current = () =>
      !hooks.disposed() && state.archivesOpen && state.archiveKind === kind && request.isCurrent()
    state.archivesLoading = true
    state.archivesError = ''
    try {
      await archivePagination.load<WorkspacePage | ConversationPage>(
        more,
        current,
        (offset) =>
          kind === 'workspaces'
            ? getDesktopApi().listArchivedWorkspaces(offset)
            : getDesktopApi().listArchivedConversations(offset),
        (result, append) => {
          if ('workspaces' in result) {
            const items = mergeListPage(state.archivedWorkspaces, result.workspaces, append)
            state.archivedWorkspaces = reconcileWorkspaces(items, result.revision)
              .filter((item) => item.archivedAt !== null && item.deletedAt === null)
              .sort(comparePinnedItems)
              .slice(0, 1000)
          } else {
            const items = mergeListPage(state.archivedConversations, result.conversations, append)
            state.archivedConversations = reconcileConversations(items, result.revision)
              .filter(archivedConversation)
              .sort(comparePinnedItems)
              .slice(0, 1000)
          }
          archiveRevision = result.revision
          const count =
            kind === 'workspaces'
              ? state.archivedWorkspaces.length
              : state.archivedConversations.length
          state.archivesHasMore = result.hasMore && count < 1000
          replayListEvents(archiveQuery, result.revision, apply)
          return state.archivesHasMore
        },
      )
    } catch (error) {
      if (current()) state.archivesError = message(error)
    } finally {
      if (request.finish()) state.archivesLoading = false
    }
  }
  function dispose(): void {
    cancelListQuery(overviewQuery)
    cancelListQuery(workspaceQuery)
    cancelListQuery(archiveQuery)
    for (const group of Object.values(state.workspaceGroups)) cancelListQuery(group)
    conversationUpdates.clear()
    workspaceUpdates.clear()
    hiddenConversations.clear()
    hiddenWorkspaces.clear()
  }
  return {
    refreshOverview,
    refreshWorkspaces,
    loadWorkspaceConversations,
    expandWorkspace,
    toggleWorkspace,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    renameConversation,
    moveConversation,
    deleteConversation,
    setConversationPinned,
    setConversationArchived,
    setWorkspacePinned,
    setWorkspaceArchived,
    changeArchiveKind,
    openArchives,
    closeArchives,
    refreshArchives,
    apply,
    receive,
    dispose,
    acceptedConversation: (id: string) => conversationUpdates.get(id),
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : '无法读取或保存列表，请重试。'
}
