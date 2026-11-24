import { computed, inject, onMounted, onScopeDispose, provide, reactive, ref, watch } from 'vue'
import { createConversationState } from './state'
import type { DraftSkill } from './state'
import { createExecutionInteractions } from './execution-interactions'
import {
  boundMessages,
  bufferListEvent,
  cancelListQuery,
  createListQuery,
  ListPagination,
  mergeListPage,
  replayListEvents,
  startListQuery,
  unwrap,
} from './state-utils'
import type { InjectionKey } from 'vue'
import {
  chatEventBufferKey,
  comparePinnedItems,
  isActiveRun,
  isVisible,
  MAX_MESSAGE_LENGTH,
} from '@shared/chat'
import { upsert } from '@shared/keyed-list'
import { boundSteps } from '@shared/steps'
import { messageBody, messageText } from '@shared/message-actions'
import { formatSkillPrefix } from '@shared/skills'
import { isCompactCommand, matchesCompactCommand } from '@shared/manual-compaction'
import type {
  ChatEvent,
  ChatResult,
  ChatModel,
  Conversation,
  ConversationUpdate,
  ConversationPage,
  WorkspacePage,
  Workspace,
  WorkspaceInput,
  WorkspaceChange,
  WorkspaceUpdate,
} from '@shared/chat'
import { MAX_ATTACHMENT_BATCH_BYTES } from '@shared/attachments'
import { addAttachmentFiles, attachmentInputs, isImageFile } from './attachment-files'
import { getDesktopApi } from '@/lib/desktop'
import { availableModels } from '@shared/models'

import type { FollowUpChange, FollowUpItem, FollowUpMode } from '@shared/follow-up'

const IMAGE_INPUT_REQUIRED = '当前模型未启用图片输入，请在模型设置中启用或切换模型。'

function createConversations() {
  const state = createConversationState()
  let selection = 0,
    unsubscribe: (() => void) | undefined,
    disposed = false
  const pendingEvents = new Map<string, ChatEvent>()
  const overviewQuery = createListQuery()
  const workspaceQuery = createListQuery()
  const archiveQuery = createListQuery()
  const listPagination = new ListPagination()
  const workspacePagination = new ListPagination()
  const archivePagination = new ListPagination()
  let listRevision = 0,
    detailRevision = 0
  let modelGeneration = 0
  let workspaceRevision = 0,
    archiveRevision = 0
  // 通知和管理快照有界保留，防止迟到通知或旧查询撤销已接受的用户操作。
  const conversationUpdates = new Map<string, ConversationUpdate>()
  const workspaceUpdates = new Map<string, WorkspaceUpdate>()
  const hiddenConversations = new Set<string>()
  const hiddenWorkspaces = new Set<string>()
  const draftWorkspaces = new Map<string, string | null>()
  const draftKey = () => state.selectedId ?? `new:${state.workspaceId ?? 'unbound'}`
  const withdrawn = reactive(new Map<string, { item: FollowUpItem; text: string }>())
  const followUpDraft = computed(() =>
    state.selectedId ? withdrawn.get(state.selectedId) : undefined,
  )
  function releaseEmptyDraft(key: string): void {
    if (!state.drafts[key] && !state.draftAttachments[key]?.length && !state.draftSkills[key])
      draftWorkspaces.delete(key)
  }
  function clearDraft(key: string): void {
    delete state.drafts[key]
    delete state.draftAttachments[key]
    delete state.draftSkills[key]
    draftWorkspaces.delete(key)
  }
  const draft = computed({
    get: () => followUpDraft.value?.text ?? state.drafts[draftKey()] ?? '',
    set: (value: string) => {
      if (followUpDraft.value) {
        followUpDraft.value.text = value
        return
      }
      const key = draftKey()
      if (!draftWorkspaces.has(key) && draftWorkspaces.size >= 100) {
        state.error = '草稿数量已达上限，请发送或清空已有草稿。'
        return
      }
      if (value) {
        state.drafts[key] = value
        draftWorkspaces.set(key, state.workspaceId)
      } else {
        delete state.drafts[key]
        releaseEmptyDraft(key)
      }
    },
  })
  const draftAttachments = computed(() =>
    followUpDraft.value ? [] : (state.draftAttachments[draftKey()] ?? []),
  )
  const draftSkill = computed(() => {
    const item = followUpDraft.value?.item
    if (item) return item.skill ? { name: item.skill, path: '' } : null
    return state.draftSkills[draftKey()] ?? null
  })
  const draftSkillPrefix = computed(() =>
    draftSkill.value ? formatSkillPrefix(draftSkill.value) : '',
  )
  const draftMessageText = computed(() => {
    const skill = draftSkill.value
    const metadata = skill
      ? `\n\n${JSON.stringify({ skills: [{ type: 'skill', name: skill.name, path: skill.path }] })}`
      : ''
    return draftSkillPrefix.value + draft.value + metadata
  })
  const draftTextLimit = computed(() => MAX_MESSAGE_LENGTH - draftSkillPrefix.value.length)
  function selectDraftSkill(skill: DraftSkill): void {
    if (followUpDraft.value) return
    const key = draftKey()
    if (!draftWorkspaces.has(key) && draftWorkspaces.size >= 100) {
      state.error = '草稿数量已达上限，请发送或清空已有草稿。'
      return
    }
    state.draftSkills[key] = skill
    draftWorkspaces.set(key, state.workspaceId)
    // 技能候选只在整个草稿是斜杠查询时打开，查询由所选标记取代。
    delete state.drafts[key]
  }
  function removeDraftSkill(): void {
    if (followUpDraft.value || state.sending || state.resending || state.compacting) return
    const key = draftKey()
    delete state.draftSkills[key]
    releaseEmptyDraft(key)
  }
  const imageInput = computed(
    () => state.models.find((model) => model.id === state.modelId)?.imageInput === true,
  )
  watch(imageInput, (enabled) => {
    if (!enabled) return
    // 只清除已失效的图片启用提示，保留其他发送失败及服务错误。
    if (state.error === IMAGE_INPUT_REQUIRED) state.error = ''
    if (state.editing?.error === IMAGE_INPUT_REQUIRED) state.editing.error = ''
  })
  const activeRun = computed(
    () =>
      (state.selectedId ? state.activeRuns[state.selectedId] : null) ??
      state.detail?.runs.find(isActiveRun) ??
      null,
  )
  const continuableRun = computed(() => {
    if (state.historical || activeRun.value) return null
    const run = state.detail?.runs.findLast((item) => !item.compaction)
    return run && (run.status === 'cancelled' || run.status === 'interrupted') ? run : null
  })
  const followUps = ref<FollowUpItem[]>([])
  const followUpError = ref('')
  const followUpBusy = ref(false)
  let followUpRequest = 0
  function rememberFollowUpDraft(item: FollowUpItem): void {
    const previous = withdrawn.get(item.conversationId)
    if (previous?.item.id !== item.id || previous.item.revision !== item.revision)
      withdrawn.set(item.conversationId, { item, text: item.text })
  }

  async function loadFollowUps(): Promise<void> {
    const id = state.selectedId
    const request = ++followUpRequest
    if (!id || state.serviceError) return
    try {
      const items = unwrap(await getDesktopApi().listFollowUps(id))
      if (!disposed && request === followUpRequest) {
        followUps.value = items.filter((item) => item.state === 'queued')
        const item = items.find((item) => item.state === 'draft')
        if (item) rememberFollowUpDraft(item)
        else withdrawn.delete(id)
      }
    } catch (error) {
      if (!disposed && request === followUpRequest) followUpError.value = message(error)
    }
  }

  watch(
    () => [state.selectedId, state.serviceError],
    () => {
      followUps.value = []
      followUpError.value = ''
      void loadFollowUps()
    },
    { flush: 'sync' },
  )

  async function actOnFollowUp(
    item: FollowUpItem,
    action: FollowUpChange['action'] | 'start',
  ): Promise<boolean> {
    if (followUpBusy.value || state.selectedId !== item.conversationId || state.serviceError)
      return false
    if (action === 'withdraw' && (followUpDraft.value || state.editing)) return false
    const run = activeRun.value
    if (action === 'steer' && (!run || run.status !== 'running' || run.compaction)) return false
    if (action === 'start' && run) return false
    const token = selection
    followUpBusy.value = true
    followUpError.value = ''
    try {
      const api = getDesktopApi()
      const input = { id: item.id, conversationId: item.conversationId, revision: item.revision }
      if (action === 'start') {
        unwrap(await api.startFollowUp(input))
      } else {
        const updated = unwrap(
          await api.changeFollowUp({
            ...input,
            action,
            ...((action === 'steer' || action === 'restore_draft') && run
              ? { expectedRunId: run.id }
              : {}),
          }),
        )
        if (updated.state === 'draft') {
          // 废弃受理前的列表读取，避免快照在同一会话里撤销刚取出的草稿。
          rememberFollowUpDraft(updated)
          if (token === selection) {
            ++followUpRequest
            followUps.value = followUps.value.filter((row) => row.id !== updated.id)
          }
        } else if (action === 'restore_draft') withdrawn.delete(item.conversationId)
      }
      return token === selection
    } catch (error) {
      if (token === selection) followUpError.value = message(error)
      return false
    } finally {
      if (token === selection) await loadFollowUps()
      followUpBusy.value = false
    }
  }

  const lastUserMessage = computed(() =>
    state.historical
      ? null
      : (state.detail?.messages.findLast(
          (item) => item.role === 'user' && item.steeringOrder === undefined,
        ) ?? null),
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
  const {
    setCardCollapsed,
    inputReply,
    setInputReply,
    refreshExecutionSettings,
    saveExecutionSettings,
    cancel,
    decide,
    loadDirectories,
    revokeDirectory,
    submitInput,
    rememberRun,
  } = createExecutionInteractions(state, {
    selection: () => selection,
    disposed: () => disposed,
    activeRun: () => activeRun.value,
    pendingInputs: () => pendingInputs.value,
  })
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
    if (deleted) clearDraft(conversationId)
    state.conversations = state.conversations.filter((item) => item.id !== conversationId)
    for (const group of Object.values(state.workspaceGroups))
      group.items = group.items.filter((item) => item.id !== conversationId)
    if (state.selectedId === conversationId) newConversation()
  }
  function removeWorkspace(workspaceId: string, deleted = true): void {
    rememberHidden(hiddenWorkspaces, workspaceId)
    if (deleted)
      for (const [key, owner] of draftWorkspaces) {
        if (owner === workspaceId) clearDraft(key)
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
    if (change.kind === 'run') rememberRun(change.value)
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
        if (group.loading && !bufferListEvent(group, event)) {
          group.loading = false
          group.error = '对话变化较快，请重新加载。'
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
      if (change.value.steeringRequeued) {
        followUpError.value = '本轮引导未完成，消息已退回待发区。'
        void loadFollowUps()
      }
      return
    }
    if (
      change.kind === 'message' &&
      (!state.historical || state.detail.messages.some((item) => item.id === change.value.id))
    ) {
      const merged = upsert(state.detail.messages, change.value)
      state.detail.messages = boundMessages(merged)
      // 淘汰完整轮次后同步游标；更早页面必须能重新读取这些消息与独立压缩。
      if (state.detail.history && state.detail.messages.length < merged.length) {
        const first = state.detail.messages[0]
        if (first) {
          state.detail.history = { beforeRunId: first.runId, hasMore: true }
          state.detail.runs = state.detail.runs.filter((run) => run.id >= first.runId)
        }
      }
    }
    if (change.kind === 'step')
      state.detail.steps = boundSteps(upsert(state.detail.steps, change.value))
    if (
      change.kind === 'run' &&
      (!state.historical || state.detail.runs.some((run) => run.id === change.value.id))
    ) {
      const merged = upsert(state.detail.runs, change.value)
      state.detail.runs = merged
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(-200)
      // 密集独立压缩也会推进窗口；消息与执行必须一起淘汰，不能只丢失旧轮次的状态。
      if (state.detail.history && state.detail.runs.length < merged.length) {
        const first = state.detail.runs[0]
        if (first) {
          state.detail.messages = state.detail.messages.filter((item) => item.runId >= first.id)
          state.detail.history = { beforeRunId: first.id, hasMore: true }
        }
      }
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
    if (change.kind === 'follow-ups') {
      if (change.value.conversationId === state.selectedId) void loadFollowUps()
      return
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
    if (
      state.loading &&
      change.kind !== 'service' &&
      change.kind !== 'conversation' &&
      change.kind !== 'workspace'
    ) {
      if (change.value.conversationId === state.selectedId) {
        pendingEvents.set(chatEventBufferKey(event), event)
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
    const request = startListQuery(overviewQuery)
    const current = () => !disposed && request.isCurrent()
    state.loadingList = true
    const generation = modelGeneration
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
          if (generation === modelGeneration) setModels(result.models)
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
        await openConversation(state.selectedId)
    } catch (error) {
      if (current()) state.serviceError = message(error)
    } finally {
      if (!disposed && request.finish()) state.loadingList = false
    }
  }
  async function refreshWorkspaces(more = false): Promise<void> {
    if (more && state.workspacesLoading) return
    const request = startListQuery(workspaceQuery)
    const current = () => !disposed && request.isCurrent()
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
      if (!disposed && request.finish()) state.workspacesLoading = false
    }
  }
  async function loadWorkspaceConversations(workspaceId: string, more = false): Promise<void> {
    const group = state.workspaceGroups[workspaceId]
    if (!group?.expanded || (more && group.loading)) return
    const request = startListQuery(group)
    const current = () =>
      !disposed && group === state.workspaceGroups[workspaceId] && request.isCurrent()
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
    if (!disposed) {
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
    if (result.workspaceId) state.workspaceGroups[result.workspaceId]?.pagination.invalidate()
    else listPagination.invalidate()
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
    if (disposed) return
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
      !disposed && state.archivesOpen && state.archiveKind === kind && request.isCurrent()
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
  async function openConversation(conversationId: string, keepMessages = false): Promise<void> {
    if (state.selectedId !== conversationId) state.editing = null
    const retainDetail = keepMessages && state.detail?.conversation.id === conversationId
    const token = ++selection
    state.directoriesLoading = false
    state.directoriesOffset = 0
    state.directoriesError = ''
    state.selectedId = conversationId
    const known =
      state.conversations.find((item) => item.id === conversationId) ??
      Object.values(state.workspaceGroups)
        .flatMap((group) => group.items)
        .find((item) => item.id === conversationId)
    if (known) state.workspaceId = known.workspaceId
    if (!retainDetail) {
      detailRevision = 0
      state.detail = null
      state.historical = false
    }
    state.loading = true
    state.error = ''
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
      state.historical = false
      delete state.activeRuns[conversationId]
      for (const run of result.runs) rememberRun(run)
      state.workspaceId = result.conversation.workspaceId
      state.detail.messages = boundMessages(result.messages)
      state.error = result.warning ?? ''
      detailRevision = result.revision
      state.modelId = result.conversation.modelId
    } catch (error) {
      if (token === selection) state.error = message(error)
    } finally {
      if (token === selection) {
        // 同步失败时仍可把缓冲通知应用到保留的消息，避免丢失已受理执行的状态。
        if (state.detail)
          for (const event of [...pendingEvents.values()].sort((a, b) => a.revision - b.revision))
            if (event.revision > detailRevision) apply(event)
        state.loading = false
        pendingEvents.clear()
      }
    }
  }
  function addAttachments(files: File[], editing = false): void {
    if (!files.length || state.sending || state.resending || (!editing && followUpDraft.value))
      return
    const edit = editing ? state.editing : null
    const errorTarget = edit ?? state
    errorTarget.error = ''
    if (files.some(isImageFile) && !imageInput.value) {
      errorTarget.error = IMAGE_INPUT_REQUIRED
      return
    }
    try {
      const held = [
        ...Object.values(state.draftAttachments).flat(),
        ...(state.editing?.files ?? []),
      ]
      if (
        [...held, ...files].reduce((sum, file) => sum + file.size, 0) >
        2 * MAX_ATTACHMENT_BATCH_BYTES
      )
        throw new Error('所有草稿合计最多暂存 64 MiB，请清空不再使用的附件。')
      if (edit) {
        edit.files = addAttachmentFiles(edit.files, files, edit.retainedAttachments.length)
      } else {
        const key = draftKey()
        if (!draftWorkspaces.has(key) && draftWorkspaces.size >= 100)
          throw new Error('草稿数量已达上限，请发送或清空已有草稿。')
        state.draftAttachments[key] = addAttachmentFiles(draftAttachments.value, files)
        draftWorkspaces.set(key, state.workspaceId)
      }
    } catch (error) {
      errorTarget.error = message(error)
    }
  }
  function removeAttachment(index: number, editing = false): void {
    if (state.sending || state.resending || (!editing && followUpDraft.value)) return
    if (editing) {
      const edit = state.editing
      if (!edit) return
      if (index < edit.retainedAttachments.length) edit.retainedAttachments.splice(index, 1)
      else edit.files.splice(index - edit.retainedAttachments.length, 1)
    } else {
      const key = draftKey()
      state.draftAttachments[key]?.splice(index, 1)
      if (!state.draftAttachments[key]?.length) {
        delete state.draftAttachments[key]
        releaseEmptyDraft(key)
      }
    }
  }
  async function send(mode: FollowUpMode = 'queue'): Promise<void> {
    if (state.executionSettingsSaving || followUpBusy.value) return
    const editingFollowUp = followUpDraft.value
    if (!editingFollowUp && !draftAttachments.value.length && isCompactCommand(draft.value)) {
      await compact(true)
      return
    }
    if (
      state.sending ||
      state.resending ||
      state.compacting ||
      state.editing ||
      state.loading ||
      (activeRun.value &&
        mode === 'steer' &&
        (activeRun.value.status !== 'running' || activeRun.value.compaction)) ||
      state.serviceError ||
      state.modelsLoading ||
      state.modelError ||
      (!draft.value.trim() &&
        !draftAttachments.value.length &&
        !editingFollowUp?.item.attachments.length) ||
      (draftAttachments.value.some(isImageFile) && !imageInput.value) ||
      (editingFollowUp?.item.retained?.some((attachment) => attachment.kind === 'image') &&
        !imageInput.value) ||
      !state.modelId
    )
      return
    state.sending = true
    state.error = ''
    const conversationId = state.selectedId,
      body = draft.value,
      skill = draftSkill.value,
      files = draftAttachments.value.slice(),
      token = selection
    const key = draftKey()
    const workspaceId = conversationId ? null : state.workspaceId
    const run = activeRun.value
    const modelId = state.modelId
    try {
      const api = getDesktopApi()
      if (editingFollowUp && conversationId) {
        const { id, revision } = editingFollowUp.item
        const input = { id, conversationId, revision, text: body }
        if (run) {
          unwrap(
            await api.changeFollowUp({
              ...input,
              action: mode === 'steer' ? 'steer_draft' : 'queue_draft',
              expectedRunId: run.id,
              ...(mode === 'queue' ? { modelId } : {}),
            }),
          )
        } else {
          unwrap(await api.startFollowUp({ ...input, modelId }))
        }
        withdrawn.delete(conversationId)
        if (token === selection && !disposed) {
          if (run) await loadFollowUps()
          else await openConversation(conversationId, true)
        }
        return
      }
      const input = {
        conversationId,
        workspaceId,
        text: body,
        ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
        modelId,
        ...(files.length ? { attachments: await attachmentInputs(files) } : {}),
      }
      let acceptedId = conversationId
      if (run && conversationId) {
        unwrap(await api.addFollowUp({ ...input, conversationId, expectedRunId: run.id, mode }))
      } else {
        acceptedId = unwrap(await api.sendMessage(input)).conversationId
      }
      if (
        (state.drafts[key] ?? '') === body &&
        (state.draftSkills[key] ?? null) === skill &&
        (state.draftAttachments[key]?.length ?? 0) === files.length &&
        files.every((file, index) => state.draftAttachments[key]?.[index] === file)
      )
        clearDraft(key)
      if (token === selection && !disposed && acceptedId) {
        if (run) await loadFollowUps()
        else await openConversation(acceptedId, true)
      }
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
        releaseEmptyDraft(key)
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
  async function continueTask(): Promise<void> {
    const run = continuableRun.value
    const modelId = state.modelId
    if (
      !run ||
      run.conversationId !== state.selectedId ||
      !modelId ||
      state.loading ||
      state.sending ||
      state.resending ||
      state.compacting ||
      state.editing ||
      state.executionSettingsSaving ||
      state.serviceError ||
      state.modelsLoading ||
      state.modelError ||
      draft.value.trim() ||
      draftAttachments.value.length ||
      draftSkill.value ||
      followUpDraft.value
    )
      return
    const token = selection
    state.sending = true
    state.error = ''
    try {
      unwrap(
        await getDesktopApi().continueConversation({
          conversationId: run.conversationId,
          runId: run.id,
          modelId,
        }),
      )
      if (!disposed && token === selection) await openConversation(run.conversationId, true)
    } catch (error) {
      if (!disposed && token === selection) state.error = message(error)
    } finally {
      state.sending = false
    }
  }
  function startEditing(messageId: string): void {
    const target = lastUserMessage.value
    if (
      editUnavailable.value ||
      !target ||
      target.id !== messageId ||
      target.content.some((block) => !['text', 'image', 'file', 'skill'].includes(block.type))
    )
      return
    const text = messageText(target.content)
    const reference = target.content.find((block) => block.type === 'skill')
    state.editing = {
      messageId,
      originalText: text,
      text: messageBody(target.content),
      skill: reference?.name ? { name: reference.name, path: reference.path } : null,
      error: '',
      runId: target.runId,
      files: [],
      retainedAttachments: target.content.flatMap((block, index) =>
        block.type === 'image' || block.type === 'file' ? [index] : [],
      ),
    }
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
      edit.runId !== target.runId ||
      edit.originalText !== messageText(target.content)
    ) {
      edit.error = '原提问已变化，请取消编辑并重新加载对话后核对。'
      return
    }
    const attachmentCount = edit.retainedAttachments.length + edit.files.length
    if ((!edit.text.trim() && !attachmentCount) || edit.text.trim().length > MAX_MESSAGE_LENGTH) {
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
    if (
      (edit.files.some(isImageFile) ||
        edit.retainedAttachments.some((index) => target.content[index]?.type === 'image')) &&
      !imageInput.value
    ) {
      edit.error = IMAGE_INPUT_REQUIRED
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
          expectedRunId: edit.runId,
          modelId: state.modelId,
          text: edit.text,
          ...(edit.skill ? { skill: { name: edit.skill.name, path: edit.skill.path } } : {}),
          ...(target.content.some((block) => block.type === 'image' || block.type === 'file') ||
          edit.files.length
            ? { retainedAttachments: edit.retainedAttachments.slice() }
            : {}),
          ...(edit.files.length ? { attachments: await attachmentInputs(edit.files.slice()) } : {}),
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
  async function earlier(): Promise<void> {
    const cursor = state.detail?.history?.beforeRunId,
      conversationId = state.selectedId,
      token = selection
    if (!cursor || !conversationId || state.loading || !state.detail?.history?.hasMore) return
    state.loading = true
    state.error = ''
    try {
      const page = unwrap(await getDesktopApi().getConversationHistory(conversationId, cursor))
      if (token !== selection || !state.detail) return
      state.detail.messages = page.messages
      state.detail.runs = page.runs
      state.detail.history = { beforeRunId: page.beforeRunId, hasMore: page.hasMore }
      detailRevision = page.revision
      state.historical = true
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
  })
  async function initialize(): Promise<void> {
    // 仅在服务就绪后由根组件调用；失败重试后重新读取，不保留旧启动的错误。
    state.loading = false
    await Promise.all([refreshOverview(), refreshWorkspaces(), refreshExecutionSettings()])
  }
  onScopeDispose(() => {
    disposed = true
    selection++
    cancelListQuery(overviewQuery)
    cancelListQuery(workspaceQuery)
    cancelListQuery(archiveQuery)
    for (const group of Object.values(state.workspaceGroups)) cancelListQuery(group)
    unsubscribe?.()
    pendingEvents.clear()
    conversationUpdates.clear()
    workspaceUpdates.clear()
  })
  return {
    initialize,
    state,
    followUps,
    followUpDraft,
    continuableRun,
    continueTask,
    followUpError,
    followUpBusy,
    actOnFollowUp,
    draft,
    draftAttachments,
    draftSkill,
    draftMessageText,
    draftTextLimit,
    selectDraftSkill,
    removeDraftSkill,
    imageInput,
    addAttachments,
    removeAttachment,
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
