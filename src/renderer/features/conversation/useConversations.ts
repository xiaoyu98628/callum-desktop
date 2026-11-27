import { getDesktopApi } from '@/lib/desktop'
import { MAX_ATTACHMENT_BATCH_BYTES } from '@shared/attachments'
import type { ChatEvent, ChatModel } from '@shared/chat'
import { chatEventBufferKey, isActiveRun, isVisible, MAX_MESSAGE_LENGTH } from '@shared/chat'
import { upsert } from '@shared/keyed-list'
import { isCompactCommand, matchesCompactCommand } from '@shared/manual-compaction'
import { messageBody, messageText } from '@shared/message-actions'
import { availableModels } from '@shared/models'
import { boundSteps } from '@shared/steps'
import type { InjectionKey } from 'vue'
import { computed, inject, onMounted, onScopeDispose, provide, watch } from 'vue'
import { unwrap } from '../../lib/result'
import { addAttachmentFiles, attachmentInputs, isImageFile } from './attachment-files'
import { createConversationDrafts } from './conversation-drafts'
import { createConversationFollowUps } from './conversation-follow-ups'
import { createConversationLists } from './conversation-lists'
import { createExecutionInteractions } from './execution-interactions'
import { createConversationState } from './state'
import { boundMessages } from './state-utils'

import type { FollowUpMode } from '@shared/follow-up'

const IMAGE_INPUT_REQUIRED = '当前模型未启用图片输入，请在模型设置中启用或切换模型。'

function createConversations() {
  const state = createConversationState()
  let selection = 0,
    unsubscribe: (() => void) | undefined,
    disposed = false
  const pendingEvents = new Map<string, ChatEvent>()
  let detailRevision = 0
  let modelGeneration = 0
  const drafts = createConversationDrafts(state)
  const {
    draftKey,
    followUpDraft,
    draft,
    draftAttachments,
    draftSkill,
    draftMessageText,
    draftTextLimit,
    selectDraftSkill,
    removeDraftSkill,
    releaseEmptyDraft,
  } = drafts
  const clearDraft = drafts.clearOrdinary
  const lists = createConversationLists(state, {
    disposed: () => disposed,
    modelGeneration: () => modelGeneration,
    setModels,
    recover: (id) => openConversation(id),
    newConversation: () => newConversation(),
    clearConversation: (id) => drafts.clearConversation(id),
    clearWorkspace: (id) => drafts.clearWorkspace(id),
    onConversation: (item, revision) => {
      drafts.moveConversation(item.id, item.workspaceId)
      if (
        revision > detailRevision &&
        state.detail?.conversation.id === item.id &&
        isVisible(item)
      ) {
        state.detail.conversation = item
        state.workspaceId = item.workspaceId
      }
    },
  })
  const {
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
  } = lists
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
  const { followUps, followUpError, followUpBusy, loadFollowUps, actOnFollowUp } =
    createConversationFollowUps(state, drafts, {
      selection: () => selection,
      disposed: () => disposed,
      activeRun: () => activeRun.value,
    })

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
    if (change.kind === 'workspace' || change.kind === 'conversation') {
      lists.apply(event)
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
    lists.receive(event)
    if (change.kind === 'follow-ups') {
      if (change.value.conversationId === state.selectedId) void loadFollowUps()
      return
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
      const update = lists.acceptedConversation(conversationId)
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
        const attachments = addAttachmentFiles(draftAttachments.value, files)
        if (!drafts.reserve(key, state.workspaceId)) return
        state.draftAttachments[key] = attachments
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
        drafts.forgetFollowUp(conversationId)
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
    lists.dispose()
    unsubscribe?.()
    pendingEvents.clear()
    drafts.dispose()
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
