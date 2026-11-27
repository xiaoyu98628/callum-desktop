import type {
  AttachmentInput,
  AttachmentPreview,
  AttachmentPreviewInput,
  AttachmentSaveInput,
} from '../../shared/attachments.ts'
import type {
  ApprovalScope,
  ChatEvent,
  ChatOverview,
  ChatRun,
  ChatStep,
  ChatUserInput,
  CompactConversationInput,
  ContinueConversationInput,
  Conversation,
  ConversationDetail,
  ConversationHistory,
  ConversationPage,
  ConversationUpdate,
  DirectoryGrant,
  ResendMessageInput,
  ResendMessageResult,
  SendMessageInput,
  SendMessageResult,
  StepDetails,
  StepPage,
  StepPreview,
  UserInputAnswer,
  Workspace,
  WorkspaceChange,
  WorkspaceInput,
  WorkspacePage,
  WorkspaceUpdate,
} from '../../shared/chat.ts'
import {
  array,
  compareMessages,
  comparePinnedItems,
  id,
  isActiveRun,
  isVisible,
  PAGE_SIZE,
  parseCompactInput,
  parseName,
  record,
} from '../../shared/chat.ts'
import type { ContextUsage, ContextUsageInput } from '../../shared/context-usage.ts'
import { parseContextUsageInput } from '../../shared/context-usage.ts'
import type { ServiceState } from '../../shared/desktop-api.ts'
import type { ExecutionSettings } from '../../shared/execution.ts'
import { executionSettingsFromRpc, parseExecutionSettings } from '../../shared/execution.ts'
import type {
  FollowUpChange,
  FollowUpInput,
  FollowUpItem,
  FollowUpStart,
} from '../../shared/follow-up.ts'
import { followUpFromRpc } from '../../shared/follow-up.ts'
import type { GeneralSettings } from '../../shared/general-settings.ts'
import { generalSettingsFromRpc } from '../../shared/general-settings.ts'
import { upsert } from '../../shared/keyed-list.ts'
import type { Skill } from '../../shared/skills.ts'
import { parseSkills } from '../../shared/skills.ts'
import { boundSteps, STEP_PAGE_SIZE } from '../../shared/steps.ts'
import type { SnapshotChange } from './chat-event-history.ts'
import { ChatEventHistory } from './chat-event-history.ts'
import { ConversationHistoryReader } from './conversation-history.ts'
import { McpService } from './mcp-service.ts'
import { ModelCatalog } from './model-catalog.ts'
import { MutationGate } from './mutation-gate.ts'
import {
  approvalFromRpc,
  contextUsageFromRpc,
  conversationFromRpc,
  directoryGrantFromRpc,
  runFromRpc,
  stepFromRpc,
  userInputFromRpc,
  workspaceFromRpc,
} from './protocol-mapper.ts'
import { RpcError } from './rpc-client.ts'
import { readStepDetails, readStepPreview, readStepReasoning } from './step-data.ts'
import { WorkspaceCatalog } from './workspace-catalog.ts'
export { resolveBackendExecutable } from './backend-lifecycle.ts'
export { resolveWorkspaceDirectory } from './workspace-catalog.ts'

import { AttachmentTransfer } from './attachment-transfer.ts'
import { BackendLifecycle } from './backend-lifecycle.ts'
import { LiveExecutionState } from './live-execution-state.ts'
/** 应用级业务门面；生命周期、附件传输和执行增量分别由专属组件持有。 */
export class ChatService {
  readonly mcp = new McpService((method, params) => this.request(method, params))
  readonly catalog = new ModelCatalog((method, params) => this.request(method, params))
  private readonly events = new ChatEventHistory()
  private readonly live = new LiveExecutionState(this.events, (run) => this.dispatchFollowUp(run))
  private readonly lifecycle: BackendLifecycle
  private readonly attachments = new AttachmentTransfer(
    (method, params) => this.request(method, params),
    () => this.lifecycle.ensureReady(),
  )
  private readonly stepReads = new Map<string, Promise<StepDetails>>()
  private readonly previewReads = new Map<string, Promise<StepPreview>>()
  private readonly reasoningReads = new Map<string, Promise<string>>()
  private readonly contextReads = new Map<string, Promise<ContextUsage>>()
  private skillRead: Promise<Skill[]> | null = null
  private readonly gate = new MutationGate()
  private readonly workspaceCatalog = new WorkspaceCatalog(
    (method, params) => this.request(method, params),
    this.gate,
    this.events,
  )
  private readonly historyReader = new ConversationHistoryReader(
    (method, params) => this.request(method, params),
    (id) => this.live.runs.get(id),
    (runId) =>
      [...this.live.steps.values()].find((step) => step.runId === runId && step.sequence === 1),
  )
  constructor(dataDirectory: string, resourceRoot: string, developmentExecutable?: string) {
    this.lifecycle = new BackendLifecycle(dataDirectory, resourceRoot, developmentExecutable, {
      notify: (method, params) => this.live.receive(method, params),
      disconnected: (error) => {
        this.live.flush()
        this.events.publish({ kind: 'service', error })
      },
      resetAttachments: (directory) => this.attachments.reset(directory),
      waitTransfers: () => this.attachments.close(),
      releaseState: () => {
        this.live.close()
        this.events.close()
        this.stepReads.clear()
        this.previewReads.clear()
        this.reasoningReads.clear()
        this.contextReads.clear()
      },
    })
  }
  getState(): ServiceState {
    return this.lifecycle.getState()
  }
  retryStart(): Promise<ServiceState> {
    return this.lifecycle.retryStart()
  }
  subscribeState(listener: (state: ServiceState) => void): () => void {
    return this.lifecycle.subscribeState(listener)
  }
  subscribe(listener: (event: ChatEvent) => void): () => void {
    return this.events.subscribe(listener)
  }
  private request(method: string, params: unknown): Promise<unknown> {
    return this.lifecycle.request(method, params)
  }
  previewAttachment(input: AttachmentPreviewInput): Promise<AttachmentPreview> {
    return this.attachments.previewAttachment(input)
  }
  previewDraftAttachment(input: AttachmentInput): Promise<AttachmentPreview> {
    return this.attachments.previewDraftAttachment(input)
  }
  readAttachmentFile(input: AttachmentSaveInput): Promise<{ name: string; bytes: Buffer }> {
    return this.attachments.readAttachmentFile(input)
  }
  async overview(offset: number): Promise<ChatOverview> {
    const start = this.events.revision
    const [models, rows] = await Promise.all([
      this.catalog.selectable(),
      this.request('conversation.list', { unbound: true, limit: PAGE_SIZE, offset }),
    ])
    let conversations = array(rows ?? [], conversationFromRpc)
    const hasMore = conversations.length === PAGE_SIZE
    for (const change of this.events.changesSince(start)) {
      if (
        change.kind === 'conversation' &&
        (offset === 0 || conversations.some((item) => item.id === change.value.id))
      )
        conversations = upsert(conversations, change.value)
    }
    return {
      models,
      conversations: conversations
        .filter((item) => item.workspaceId === null && isVisible(item))
        .sort(comparePinnedItems),
      hasMore,
      revision: this.events.revision,
    }
  }
  async generalSettings(): Promise<GeneralSettings> {
    return generalSettingsFromRpc(await this.request('settings.get', { key: 'general' }))
  }
  async updateGeneralSettings(input: GeneralSettings): Promise<GeneralSettings> {
    return this.gate.run('general-settings', async () =>
      generalSettingsFromRpc(
        await this.request('settings.update', {
          key: 'general',
          revision: input.revision,
          value: { follow_up_mode: input.followUpMode },
        }),
      ),
    )
  }
  async executionSettings(): Promise<ExecutionSettings> {
    return executionSettingsFromRpc(await this.request('settings.get', { key: 'execution' }))
  }
  async updateExecutionSettings(input: ExecutionSettings): Promise<ExecutionSettings> {
    const value = parseExecutionSettings(input)
    return this.gate.run('execution-settings', async () =>
      executionSettingsFromRpc(
        await this.request('settings.update', {
          key: 'execution',
          revision: value.revision,
          value: {
            approval_policy: value.approvalPolicy,
            sandbox_mode: value.sandboxMode,
            approvals_reviewer: value.approvalsReviewer,
          },
        }),
      ),
    )
  }
  workspaceConversations(workspaceId: string, offset: number): Promise<ConversationPage> {
    return this.workspaceCatalog.workspaceConversations(workspaceId, offset)
  }
  listWorkspaces(offset: number): Promise<WorkspacePage> {
    return this.workspaceCatalog.listWorkspaces(offset)
  }
  createWorkspace(
    input: WorkspaceInput,
    selected?: ReadonlyMap<string, string>,
  ): Promise<Workspace> {
    return this.workspaceCatalog.createWorkspace(input, selected)
  }
  updateWorkspace(
    workspaceId: string,
    input: WorkspaceChange,
    selected?: ReadonlyMap<string, string>,
  ): Promise<WorkspaceUpdate> {
    return this.workspaceCatalog.updateWorkspace(workspaceId, input, selected)
  }
  deleteWorkspace(workspaceId: string): Promise<Workspace> {
    return this.workspaceCatalog.deleteWorkspace(workspaceId)
  }
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<WorkspaceUpdate> {
    return this.workspaceCatalog.setWorkspacePinned(workspaceId, pinned)
  }
  setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<WorkspaceUpdate> {
    return this.workspaceCatalog.setWorkspaceArchived(workspaceId, archived)
  }
  archivedWorkspaces(offset: number): Promise<WorkspacePage> {
    return this.workspaceCatalog.archivedWorkspaces(offset)
  }
  async renameConversation(conversationId: string, title: string): Promise<Conversation> {
    return this.gate.run(`conversation:${conversationId}`, async () => {
      const value = conversationFromRpc(
        await this.request('conversation.update', {
          id: id(conversationId),
          title: parseName(title),
        }),
      )
      this.events.publish({ kind: 'conversation', value })
      return value
    })
  }
  async moveConversation(
    conversationId: string,
    workspaceId: string | null,
  ): Promise<ConversationUpdate> {
    const identifier = id(conversationId)
    const destination = workspaceId === null ? null : id(workspaceId)
    return this.gate.run(`conversation:${identifier}`, async () => {
      const current = conversationFromRpc(
        await this.request('conversation.get', { id: identifier }),
      )
      if (!isVisible(current) || (current.workspaceId === null) === (destination === null))
        throw new Error('对话已不在可移动的来源列表中。')
      const conversation = conversationFromRpc(
        await this.request('conversation.update', {
          id: identifier,
          ...(destination === null ? { detach_workspace: true } : { workspace_id: destination }),
        }),
      )
      this.events.publish({ kind: 'conversation', value: conversation })
      return { conversation, revision: this.events.revision }
    })
  }
  async deleteConversation(conversationId: string): Promise<Conversation> {
    return this.gate.run(`conversation:${conversationId}`, async () => {
      const value = conversationFromRpc(
        await this.request('conversation.delete', { id: id(conversationId) }),
      )
      this.events.publish({ kind: 'conversation', value })
      return value
    })
  }
  async setConversationPinned(
    conversationId: string,
    pinned: boolean,
  ): Promise<ConversationUpdate> {
    if (typeof pinned !== 'boolean') throw new Error('置顶状态无效')
    return this.updateConversationFlag(conversationId, { pinned })
  }
  async setConversationArchived(
    conversationId: string,
    archived: boolean,
  ): Promise<ConversationUpdate> {
    if (typeof archived !== 'boolean') throw new Error('归档状态无效')
    return this.updateConversationFlag(conversationId, { archived })
  }
  private async updateConversationFlag(
    conversationId: string,
    change: { pinned: boolean } | { archived: boolean },
  ): Promise<ConversationUpdate> {
    const identifier = id(conversationId)
    return this.gate.run(`conversation:${identifier}`, async () => {
      if ('archived' in change && !change.archived) {
        const conversation = conversationFromRpc(
          await this.request('conversation.get', { id: identifier }),
        )
        if (conversation.workspaceId) {
          const workspace = workspaceFromRpc(
            await this.request('workspace.get', { id: conversation.workspaceId }),
          )
          if (!isVisible(workspace)) throw new Error('所属项目已被删除或归档，请先恢复项目。')
        }
      }
      const conversation = conversationFromRpc(
        await this.request('conversation.update', { id: identifier, ...change }),
      )
      this.events.publish({ kind: 'conversation', value: conversation })
      return { conversation, revision: this.events.revision }
    })
  }
  async archivedConversations(offset: number): Promise<ConversationPage> {
    const start = this.events.revision
    let conversations = array(
      (await this.request('conversation.list', { archived: true, limit: PAGE_SIZE, offset })) ?? [],
      conversationFromRpc,
    )
    const hasMore = conversations.length === PAGE_SIZE
    const hiddenWorkspaces = new Set<string>()
    for (const change of this.events.changesSince(start)) {
      if (change.kind === 'workspace' && change.value.deletedAt !== null)
        hiddenWorkspaces.add(change.value.id)
      if (
        change.kind === 'conversation' &&
        (offset === 0 || conversations.some((item) => item.id === change.value.id))
      )
        conversations = upsert(conversations, change.value)
    }
    return {
      conversations: conversations
        .filter(
          (item) =>
            item.archivedAt !== null &&
            item.deletedAt === null &&
            (!item.workspaceId || !hiddenWorkspaces.has(item.workspaceId)),
        )
        .sort(comparePinnedItems),
      hasMore,
      revision: this.events.revision,
    }
  }
  async listSkills(): Promise<Skill[]> {
    if (this.skillRead) return this.skillRead
    this.skillRead = this.request('skills.list', {}).then(parseSkills)
    try {
      return await this.skillRead
    } finally {
      this.skillRead = null
    }
  }

  async contextUsage(input: ContextUsageInput): Promise<ContextUsage> {
    const parsed = parseContextUsageInput(input)
    const key = JSON.stringify(parsed)
    const pending = this.contextReads.get(key)
    if (pending) return pending
    if (this.contextReads.size >= 16) throw new Error('上下文统计请求较多，请稍后重试。')
    const task = (async () => {
      const value = contextUsageFromRpc(
        await this.request('conversation.context_usage', {
          conversation_id: parsed.conversationId ?? undefined,
          workspace_id: parsed.workspaceId ?? undefined,
          model_id: parsed.modelId,
          draft: parsed.draft,
          ...(parsed.draftImages ? { draft_images: parsed.draftImages } : {}),
        }),
      )
      if (value.conversationId !== parsed.conversationId || value.modelId !== parsed.modelId)
        throw new Error('上下文统计归属不匹配')
      return value
    })()
    this.contextReads.set(key, task)
    try {
      return await task
    } finally {
      this.contextReads.delete(key)
    }
  }

  async detail(conversationId: string): Promise<ConversationDetail> {
    const start = this.events.revision
    const [conversation, history] = await Promise.all([
      this.request('conversation.get', { id: conversationId }),
      this.historyReader.page(conversationId),
    ])
    const parsedRuns = history.runs
    const pending = await Promise.all(
      parsedRuns
        .filter(isActiveRun)
        .map((run) =>
          this.request('approval.list', { run_id: run.id, status: 'pending', limit: 200 }),
        ),
    )
    const inputs = await Promise.all(
      parsedRuns
        .filter((run) => run.status === 'awaiting_user_input')
        .map((run) =>
          this.request('user_input.list', { run_id: run.id, status: 'pending', limit: 200 }),
        ),
    )
    const result: ConversationDetail = {
      conversation: conversationFromRpc(conversation),
      messages: history.messages,
      history: { beforeRunId: history.beforeRunId, hasMore: history.hasMore },
      runs: parsedRuns,
      steps: [...this.live.steps.values()].filter((step) => step.conversationId === conversationId),
      approvals: pending.flatMap((rows) =>
        array(rows ?? [], (row) => approvalFromRpc(row, conversationId)),
      ),
      directoryGrants: await this.directories(conversationId, 0),
      userInputs: inputs.flatMap((rows) => array(rows ?? [], userInputFromRpc)),
      revision: 0,
      warning: this.live.persistenceFailures.has(conversationId)
        ? '本次执行状态未能完整保存，请重新打开应用后核对历史。'
        : null,
    }
    let workspace = result.conversation.workspaceId
      ? workspaceFromRpc(
          await this.request('workspace.get', { id: result.conversation.workspaceId }),
        )
      : null
    // 项目读取也属于详情快照，所有异步读取结束后再合并期间发生的事件。
    for (const change of this.events.changesSince(start)) {
      this.mergeDetail(result, change)
      if (change.kind === 'workspace' && change.value.id === workspace?.id) workspace = change.value
    }
    if (!isVisible(result.conversation)) throw new Error('会话已被删除或归档。')
    if (result.conversation.workspaceId !== (workspace?.id ?? null))
      throw new Error('会话所属项目已变化，请重新打开会话。')
    if (workspace && !isVisible(workspace)) throw new Error('所属项目已被删除或归档。')
    // 活动回答可能尚未落库；完整的内存消息优先于数据库及事件中的中间快照。
    for (const message of this.live.messages.values())
      if (message.conversationId === conversationId)
        result.messages = upsert(result.messages, message)
    result.messages.sort(compareMessages)
    result.runs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    result.revision = this.events.revision
    return result
  }
  async listSteps(conversationId: string, runId: string, afterSequence: number): Promise<StepPage> {
    const run = runFromRpc(await this.request('run.get', { id: runId }))
    if (run.id !== runId || run.conversationId !== conversationId)
      throw new Error('步骤执行归属不匹配')
    const start = this.events.revision
    const rows = array(
      await this.request('step.list', {
        run_id: runId,
        after_sequence: afterSequence,
        limit: STEP_PAGE_SIZE + 1,
      }),
      stepFromRpc,
    )
    if (
      rows.some(
        (step, index) =>
          step.runId !== runId ||
          step.conversationId !== conversationId ||
          step.sequence <= (rows[index - 1]?.sequence ?? afterSequence),
      )
    )
      throw new Error('步骤顺序或归属不匹配')
    let steps = rows.map((step) => {
      const live = this.live.steps.get(step.id)
      return live && live.updatedAt >= step.updatedAt ? live : step
    })
    for (const change of this.events.changesSince(start)) {
      if (
        change.kind === 'step' &&
        change.value.runId === runId &&
        change.value.sequence > afterSequence &&
        (rows.length <= STEP_PAGE_SIZE || change.value.sequence <= rows.at(-1)!.sequence)
      )
        steps = upsert(steps, change.value)
    }
    steps.sort((a, b) => a.sequence - b.sequence)
    const parents = new Set(steps.map((step) => step.parentStepId))
    const hasMore = steps.length > STEP_PAGE_SIZE
    steps = steps
      .slice(0, STEP_PAGE_SIZE)
      .map((step) => ({ ...step, commentary: step.commentary || parents.has(step.id) }))
    return {
      steps,
      afterSequence,
      nextSequence: steps.at(-1)?.sequence ?? afterSequence,
      hasMore,
      revision: this.events.revision,
    }
  }
  async stepPreview(conversationId: string, runId: string, stepId: string): Promise<StepPreview> {
    return this.readOwnedStep(this.previewReads, conversationId, runId, stepId, (step) => {
      if (step.type !== 'model_call') throw new Error('该步骤没有模型预览。')
      return readStepPreview((method, params) => this.request(method, params), step)
    })
  }
  async stepDetails(conversationId: string, runId: string, stepId: string): Promise<StepDetails> {
    return this.readOwnedStep(this.stepReads, conversationId, runId, stepId, (step) =>
      readStepDetails((method, params) => this.request(method, params), step),
    )
  }
  async stepReasoning(conversationId: string, runId: string, stepId: string): Promise<string> {
    return this.readOwnedStep(this.reasoningReads, conversationId, runId, stepId, (step) => {
      if (step.type !== 'model_call') throw new Error('该步骤没有模型思考内容。')
      return readStepReasoning((method, params) => this.request(method, params), step.id)
    })
  }
  private async readOwnedStep<T>(
    reads: Map<string, Promise<T>>,
    conversationId: string,
    runId: string,
    stepId: string,
    read: (step: ChatStep) => Promise<T>,
  ): Promise<T> {
    const key = `${conversationId}:${runId}:${stepId}`
    const pending = reads.get(key)
    if (pending) return pending
    if (this.stepReads.size + this.previewReads.size + this.reasoningReads.size >= 16)
      throw new Error('步骤查询较多，请稍后重试。')
    const task = (async () => {
      const step = stepFromRpc(await this.request('step.get', { id: stepId }))
      if (step.id !== stepId || step.runId !== runId || step.conversationId !== conversationId)
        throw new Error('步骤归属不匹配')
      return read(step)
    })()
    reads.set(key, task)
    try {
      return await task
    } finally {
      reads.delete(key)
    }
  }
  async historyPage(conversationId: string, beforeRunId: string): Promise<ConversationHistory> {
    const start = this.events.revision
    const result = await this.historyReader.page(conversationId, beforeRunId)
    for (const change of this.events.changesSince(start)) {
      if (change.kind === 'messages-removed') {
        if (change.value.steeringRequeued) {
          result.messages = result.messages.filter(
            (message) => !change.value.messageIds.includes(message.id),
          )
        } else if (
          change.value.messageIds.some((id) => result.messages.some((message) => message.id === id))
        ) {
          throw new Error('历史已被编辑，请回到最新消息后重新读取。')
        }
      }
      if (change.kind === 'message') {
        if (
          result.messages.some(
            (message) => message.id === change.value.id && message.runId !== change.value.runId,
          )
        )
          throw new Error('历史已被编辑，请回到最新消息后重新读取。')
        if (result.runs.some((run) => run.id === change.value.runId))
          result.messages = upsert(result.messages, change.value)
      }
      if (change.kind === 'run' && result.runs.some((run) => run.id === change.value.id))
        result.runs = upsert(result.runs, change.value)
    }
    result.messages.sort(compareMessages)
    result.runs.sort((a, b) => a.id.localeCompare(b.id))
    result.revision = this.events.revision
    return result
  }
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const value = record(
      await this.attachments.withMessageContent(input, (content) =>
        this.request('conversation.send', {
          ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
          ...(!input.conversationId && input.workspaceId
            ? { workspace_id: input.workspaceId }
            : {}),
          model_id: input.modelId,
          stream: true,
          content,
        }),
      ),
    )
    return { conversationId: id(value.conversation_id), runId: id(value.run_id) }
  }
  async followUps(conversationId: string): Promise<FollowUpItem[]> {
    const items = array(
      await this.request('conversation.follow_ups', { conversation_id: conversationId }),
      followUpFromRpc,
    )
    if (items.length > 32 || items.some((item) => item.conversationId !== conversationId))
      throw new Error('后续消息列表数据无效')
    return items
  }
  async addFollowUp(input: FollowUpInput): Promise<FollowUpItem> {
    const item = await this.attachments
      .withMessageContent(input, (content) =>
        this.request('conversation.follow_up_add', {
          conversation_id: input.conversationId,
          model_id: input.modelId,
          expected_run_id: input.expectedRunId,
          mode: input.mode,
          content,
        }),
      )
      .then(followUpFromRpc)
    if (item.conversationId !== input.conversationId) throw new Error('后续消息归属不匹配')
    return item
  }
  async changeFollowUp(input: FollowUpChange): Promise<FollowUpItem> {
    const item = followUpFromRpc(
      await this.request('conversation.follow_up_change', {
        conversation_id: input.conversationId,
        id: input.id,
        revision: input.revision,
        action: input.action,
        expected_run_id: input.expectedRunId,
        text: input.text,
        model_id: input.modelId,
      }),
    )
    if (item.conversationId !== input.conversationId || item.id !== input.id)
      throw new Error('后续消息归属不匹配')
    return item
  }
  async startFollowUp(input: FollowUpStart, afterRunId?: string): Promise<SendMessageResult> {
    const value = record(
      await this.request('conversation.follow_up_start', {
        conversation_id: input.conversationId,
        id: input.id,
        revision: input.revision,
        after_run_id: afterRunId,
        text: input.text,
        model_id: input.modelId,
      }),
    )
    if (id(value.conversation_id) !== input.conversationId) throw new Error('后续执行归属不匹配')
    return { conversationId: input.conversationId, runId: id(value.run_id) }
  }
  private async dispatchFollowUp(run: ChatRun): Promise<void> {
    const connection = this.lifecycle.generation
    try {
      const attempted = new Set<string>()
      while (connection === this.lifecycle.generation && attempted.size < 32) {
        const item = (await this.followUps(run.conversationId)).find(
          (item) => item.state === 'queued',
        )
        if (!item || connection !== this.lifecycle.generation) return
        const version = `${item.id}:${item.revision}`
        if (attempted.has(version)) break
        attempted.add(version)
        try {
          await this.startFollowUp(
            { id: item.id, conversationId: item.conversationId, revision: item.revision },
            run.id,
          )
          return
        } catch (error) {
          // 受理冲突后重新核对队首，同一条消息的新版本也能参与下一次受理。
          if (!(error instanceof RpcError) || error.code !== 1003) throw error
        }
      }
    } catch {
      // 读取或受理失败时由界面刷新 Go 保存的队列。
    }
    if (connection === this.lifecycle.generation)
      this.events.publish({
        kind: 'follow-ups',
        value: { id: run.conversationId, conversationId: run.conversationId },
      })
  }
  async compact(input: CompactConversationInput): Promise<SendMessageResult> {
    const parsed = parseCompactInput(input)
    return this.gate.run(`compact:${parsed.conversationId}`, async () => {
      const value = record(
        await this.request('conversation.compact', {
          conversation_id: parsed.conversationId,
          model_id: parsed.modelId,
        }),
      )
      const conversationId = id(value.conversation_id)
      if (conversationId !== parsed.conversationId) throw new Error('压缩结果会话归属不匹配')
      return { conversationId, runId: id(value.run_id) }
    })
  }
  async continueConversation(input: ContinueConversationInput): Promise<SendMessageResult> {
    return this.gate.run(`continue:${input.conversationId}`, async () => {
      const value = record(
        await this.request('conversation.continue', {
          conversation_id: input.conversationId,
          run_id: input.runId,
          model_id: input.modelId,
          resume_in_place: true,
        }),
      )
      if (id(value.conversation_id) !== input.conversationId || id(value.run_id) !== input.runId)
        throw new Error('继续任务的受理结果归属不匹配。')
      return { conversationId: input.conversationId, runId: input.runId }
    })
  }
  async resend(input: ResendMessageInput): Promise<ResendMessageResult> {
    return this.gate.run(`resend:${input.conversationId}`, async () => {
      const value = record(
        await this.attachments.withMessageContent(input, (content) =>
          this.request('conversation.resend', {
            conversation_id: input.conversationId,
            message_id: input.messageId,
            model_id: input.modelId,
            stream: true,
            content,
            ...(input.expectedRunId ? { expected_run_id: input.expectedRunId } : {}),
            ...(input.retainedAttachments?.length
              ? { retained_attachments: input.retainedAttachments }
              : {}),
          }),
        ),
      )
      const conversationId = id(value.conversation_id),
        runId = id(value.run_id)
      const removedMessageIds = array(value.removed_message_ids ?? [], id)
      if (
        conversationId !== input.conversationId ||
        id(value.user_message_id) !== input.messageId ||
        new Set(removedMessageIds).size !== removedMessageIds.length ||
        removedMessageIds.includes(input.messageId) ||
        removedMessageIds.includes(id(value.message_id))
      )
        throw new Error('重发结果归属不匹配，请重新加载历史后核对。')
      // 以服务端受理结果移除旧回答。先排空通知，避免旧的增量在移除通知之后再出现。
      this.live.flush()
      for (const messageId of removedMessageIds) {
        this.live.removeMessage(messageId)
      }
      if (removedMessageIds.length)
        this.events.publish({
          kind: 'messages-removed',
          value: {
            id: runId,
            conversationId,
            messageIds: removedMessageIds,
          },
        })
      return { conversationId, runId, removedMessageIds }
    })
  }
  async cancel(runId: string): Promise<boolean> {
    const value = record(await this.request('run.cancel', { run_id: runId }))
    if (typeof value.cancel_requested !== 'boolean') throw new Error('取消响应无效')
    return value.cancel_requested
  }
  async submitUserInput(
    inputId: string,
    runId: string,
    answer: UserInputAnswer,
  ): Promise<ChatUserInput> {
    const value = userInputFromRpc(
      await this.request('user_input.submit', {
        input_id: inputId,
        run_id: runId,
        answer: { option_index: answer.optionIndex, text: answer.text, skipped: answer.skipped },
      }),
    )
    if (value.id !== inputId || value.runId !== runId) throw new Error('回复归属不匹配')
    return value
  }
  async decide(
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: ApprovalScope = 'once',
  ): Promise<boolean> {
    await this.request('approval.decide', { approval_id: approvalId, decision, scope })
    return true
  }
  async directories(conversationId: string, offset: number): Promise<DirectoryGrant[]> {
    const grants = array(
      await this.request('approval.directory.list', {
        conversation_id: id(conversationId),
        limit: 200,
        offset,
      }),
      directoryGrantFromRpc,
    )
    if (grants.some((grant) => grant.conversationId !== conversationId))
      throw new Error('目录授权归属不匹配')
    return grants
  }
  async revokeDirectory(conversationId: string, grantId: string): Promise<DirectoryGrant> {
    const value = directoryGrantFromRpc(
      await this.request('approval.directory.revoke', {
        conversation_id: id(conversationId),
        id: id(grantId),
      }),
    )
    if (value.conversationId !== conversationId || value.id !== grantId)
      throw new Error('目录授权归属不匹配')
    return value
  }
  private mergeDetail(detail: ConversationDetail, change: SnapshotChange): void {
    if (change.kind === 'workspace') {
      if (change.value.id === detail.conversation.workspaceId && !isVisible(change.value))
        throw new Error('项目已被删除或归档。')
      return
    }
    if (change.kind === 'conversation') {
      if (change.value.id === detail.conversation.id) detail.conversation = change.value
      return
    }
    if (change.value.conversationId !== detail.conversation.id) return
    if (change.kind === 'messages-removed')
      detail.messages = detail.messages.filter(
        (message) => !change.value.messageIds.includes(message.id),
      )
    if (change.kind === 'message') detail.messages = upsert(detail.messages, change.value)
    if (change.kind === 'step') detail.steps = boundSteps(upsert(detail.steps, change.value))
    if (change.kind === 'run') {
      detail.runs = upsert(detail.runs, change.value)
      if (!change.persisted) detail.warning = '本次执行状态未能完整保存，请重新打开应用后核对历史。'
    }
    if (change.kind === 'directory-grant')
      detail.directoryGrants = upsert(detail.directoryGrants, change.value).slice(-200)
    if (change.kind === 'approval') detail.approvals = upsert(detail.approvals, change.value)
    if (change.kind === 'user-input') detail.userInputs = upsert(detail.userInputs, change.value)
  }
  close(): Promise<void> {
    return this.lifecycle.close()
  }
}

export function publicChatError(error: unknown): string {
  if (error instanceof RpcError) return error.message.replaceAll('工作区', '项目')
  if (error instanceof Error && !/ENOENT|EACCES|JSON|格式|无效|不匹配/.test(error.message))
    return error.message
  return '无法完成对话操作，请重试。'
}
