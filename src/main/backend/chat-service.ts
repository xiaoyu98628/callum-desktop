import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseAttachmentPreview, parseAttachments } from '../../shared/attachments.ts'
import type {
  AttachmentInput,
  AttachmentPreview,
  AttachmentPreviewInput,
} from '../../shared/attachments.ts'
import {
  array,
  comparePinnedItems,
  id,
  isActiveRun,
  isVisible,
  PAGE_SIZE,
  parseName,
  parseCompactInput,
  record,
  string,
} from '../../shared/chat.ts'
import type {
  ChatChange,
  ApprovalScope,
  DirectoryGrant,
  ChatEvent,
  ChatMessage,
  ChatOverview,
  ConversationHistory,
  ChatRun,
  ChatStep,
  StepPage,
  StepDetails,
  ChatUserInput,
  UserInputAnswer,
  Conversation,
  ConversationPage,
  ConversationUpdate,
  ConversationDetail,
  Workspace,
  WorkspaceInput,
  WorkspaceChange,
  WorkspacePage,
  WorkspaceUpdate,
  SendMessageInput,
  SendMessageResult,
  ResendMessageInput,
  ResendMessageResult,
  CompactConversationInput,
} from '../../shared/chat.ts'
import {
  appendDelta,
  approvalFromRpc,
  directoryGrantFromRpc,
  conversationFromRpc,
  messageFromRpc,
  runFromRpc,
  stepFromRpc,
  workspaceFromRpc,
  userInputFromRpc,
  contextUsageFromRpc,
} from './protocol-mapper.ts'
import { RpcClient, RpcConnectionError, RpcError } from './rpc-client.ts'
import { resolveResourceTarget, resolveRuntimeDirectory } from './runtime-assets.ts'
import { ModelCatalog } from './model-catalog.ts'
import {
  boundSteps,
  STEP_PAGE_SIZE,
  STEP_TEXT_LIMIT,
  truncateStepText,
} from '../../shared/steps.ts'
import { StepOutput, readStepDetails } from './step-data.ts'
import { executionSettingsFromRpc, parseExecutionSettings } from '../../shared/execution.ts'
import type { ExecutionSettings } from '../../shared/execution.ts'
import { isManualCompactionStep } from '../../shared/manual-compaction.ts'
import { ConversationHistoryReader } from './conversation-history.ts'
import { WorkspaceCatalog } from './workspace-catalog.ts'
import { MutationGate } from './mutation-gate.ts'
export { resolveWorkspaceDirectory } from './workspace-catalog.ts'
import { parseContextUsageInput } from '../../shared/context-usage.ts'
import type { ContextUsage, ContextUsageInput } from '../../shared/context-usage.ts'
import type { ServiceState } from '../../shared/desktop-api.ts'

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
}

function startupError(error: unknown, phase: string): string {
  if (error instanceof RpcConnectionError) return error.message
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (phase === 'path') return '服务数据目录必须是绝对路径。'
  if (phase === 'platform') return '当前平台没有配套的对话服务程序。'
  if (phase === 'executable') {
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return '未找到对话服务程序，请检查客户端服务资源是否完整。'
    if (code === 'EACCES' || code === 'EPERM') return '没有执行对话服务程序的权限，请检查文件权限。'
    return '无法访问对话服务程序，请检查客户端服务资源。'
  }
  if (phase === 'runtime')
    return '未找到完整的内置 Python/Node/Git 资源，请重新准备客户端运行时资源。'
  if (phase === 'directory') {
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
      return '服务数据目录不可写，请检查目录权限。'
    if (code === 'ENOSPC' || code === 'EDQUOT') return '磁盘空间或配额不足，无法创建服务数据目录。'
    if (code === 'ENOTDIR' || code === 'EEXIST') return '服务数据目录路径被文件占用，无法创建目录。'
    return '无法创建服务数据目录，请检查路径及磁盘状态。'
  }
  return '无法完成对话服务启动，请重试启动。'
}

/** 应用持有服务；RPC 细节、增量装配、快照一致性均止于此处。 */
export class ChatService {
  readonly catalog = new ModelCatalog((method, params) => this.request(method, params))
  private client: RpcClient | null = null
  private ready: Promise<void>
  private readonly dataDirectory: string
  private readonly resourceRoot: string
  private retryTask: Promise<ServiceState> | null = null
  private state: ServiceState = { status: 'starting' }
  private readonly stateListeners = new Set<(state: ServiceState) => void>()
  private error: string | null = null
  private revision = 0
  private readonly listeners = new Set<(event: ChatEvent) => void>()
  private readonly messages = new Map<string, ChatMessage>()
  private readonly runs = new Map<string, ChatRun>()
  private readonly dirty = new Map<string, ChatMessage>()
  private readonly steps = new Map<string, ChatStep>()
  private readonly dirtySteps = new Map<string, ChatStep>()
  private readonly stepOutputs = new Map<string, StepOutput>()
  private readonly stepReads = new Map<string, Promise<StepDetails>>()
  private readonly historyReader = new ConversationHistoryReader(
    (method, params) => this.request(method, params),
    (id) => this.runs.get(id),
    (runId) => [...this.steps.values()].find((step) => step.runId === runId && step.sequence === 1),
  )
  private readonly contextReads = new Map<string, Promise<ContextUsage>>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly history: { event: ChatEvent; bytes: number }[] = []
  private historyBytes = 0
  private droppedRevision = 0
  private readonly persistenceFailures = new Set<string>()
  private readonly gate = new MutationGate()
  private readonly workspaceCatalog = new WorkspaceCatalog(
    (method, params) => this.request(method, params),
    this.gate,
    {
      revision: () => this.revision,
      since: (revision) => this.since(revision),
      publish: (change) => this.publish(change),
    },
  )
  private stagingDirectory = ''
  private readonly transfers = new Set<Promise<unknown>>()
  private closing = false
  private closeTask: Promise<void> | null = null

  constructor(dataDirectory: string, resourceRoot: string) {
    this.dataDirectory = dataDirectory
    this.resourceRoot = resourceRoot
    this.ready = this.initialize(dataDirectory, resourceRoot)
    void this.ready.catch(() => undefined)
  }
  private async initialize(dataDirectory: string, resourceRoot: string): Promise<void> {
    let phase = 'path'
    try {
      if (!isAbsolute(dataDirectory)) throw new Error('服务数据目录必须是绝对路径')
      phase = 'platform'
      const executable = resolveBackendExecutable(resourceRoot)
      phase = 'executable'
      await access(executable, constants.X_OK)
      phase = 'runtime'
      const runtimeDirectory = resolveRuntimeDirectory(resourceRoot)
      const manifest = await lstat(join(runtimeDirectory, 'manifest.json'))
      if (!manifest.isFile() || manifest.isSymbolicLink())
        throw new Error('内置运行时清单必须是普通文件')
      phase = 'directory'
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
      if (this.closing) return
      phase = 'handshake'
      const client = new RpcClient(
        executable,
        ['--data-dir', dataDirectory, '--runtime-dir', runtimeDirectory],
        (method, params) => this.receive(method, params),
        (error) => {
          if (this.closing || this.client !== client) return
          if (this.state.status === 'starting') {
            this.error = error.message
            return
          }
          this.error =
            '对话服务连接已中断，未完成请求的结果可能未知。请重新打开应用核对历史，避免重复发送。'
          this.setState({ status: 'failed', error: this.error })
          this.flush()
          this.publish({ kind: 'service', error: this.error })
        },
      )
      this.client = client
      await client.ready
      if (this.error) throw new RpcConnectionError(this.error)
      if (!this.closing) {
        this.stagingDirectory = join(await realpath(dataDirectory), '.attachment-staging')
        // 后端已取得数据目录实例锁，此时才回收上一次异常退出留下的草稿。
        await this.resetAttachmentStaging()
        if (!this.closing) this.setState({ status: 'ready' })
      }
    } catch (error) {
      this.error ??= startupError(error, phase)
      if (!this.closing) this.setState({ status: 'startup-failed', error: this.error })
      try {
        if (this.client) await this.client.close()
      } catch (cleanupError) {
        this.error += ' 上一次服务进程未能完全退出，暂时无法重新启动。'
        if (!this.closing) this.setState({ status: 'startup-failed', error: this.error })
        throw new AggregateError([error, cleanupError], this.error, { cause: cleanupError })
      }
      throw new Error(this.error, { cause: error })
    }
  }
  /** 仅允许重试未曾就绪的失败启动；共享一次在途重试，关闭后不再创建进程。 */
  retryStart(): Promise<ServiceState> {
    if (this.closing) return Promise.reject(new Error('应用正在退出，无法重新启动服务。'))
    if (this.retryTask) return this.retryTask
    if (this.state.status !== 'startup-failed')
      return Promise.reject(new Error('仅支持重试启动失败的服务。'))
    this.retryTask = this.restart().finally(() => {
      this.retryTask = null
    })
    return this.retryTask
  }
  private async restart(): Promise<ServiceState> {
    this.setState({ status: 'starting' })
    // 失败状态可以早于清理完成发布；必须等待旧初始化及连接结束，避免进程或实例锁重叠。
    try {
      await this.ready
    } catch {
      /* 原始启动失败已经保存，下面单独确认进程清理结果。 */
    }
    if (this.closing) return this.getState()
    try {
      await this.client?.close()
    } catch {
      this.setState({
        status: 'startup-failed',
        error: this.error ?? '上一次服务进程未能完全退出，无法重新启动。',
      })
      return this.getState()
    }
    if (this.closing) return this.getState()
    this.client = null
    this.error = null
    this.ready = this.initialize(this.dataDirectory, this.resourceRoot)
    try {
      await this.ready
    } catch {
      /* 初始化发布具体失败原因，重试结果以当前生命周期快照为准。 */
    }
    return this.getState()
  }
  getState(): ServiceState {
    return { ...this.state }
  }
  subscribeState(listener: (state: ServiceState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }
  private setState(state: ServiceState): void {
    if (
      this.state.status === state.status &&
      (!('error' in state) || ('error' in this.state && this.state.error === state.error))
    )
      return
    this.state = state
    for (const listener of this.stateListeners) listener(this.getState())
  }
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private async request(method: string, params: unknown): Promise<unknown> {
    const ready = this.ready
    await ready
    if (ready !== this.ready) throw new Error('服务状态已变化，请重新加载。')
    if (this.error) throw new Error(this.error)
    if (this.closing || !this.client) throw new Error('对话服务正在关闭。')
    return this.client.request(method, params)
  }
  async overview(offset: number): Promise<ChatOverview> {
    const start = this.revision
    const [models, rows] = await Promise.all([
      this.request('model.list', { selectable_only: true }),
      this.request('conversation.list', { unbound: true, limit: PAGE_SIZE, offset }),
    ])
    let conversations = array(rows ?? [], conversationFromRpc)
    const hasMore = conversations.length === PAGE_SIZE
    for (const event of this.since(start)) {
      if (event.change.kind === 'service') throw new Error(event.change.error)
      if (
        event.change.kind === 'conversation' &&
        (offset === 0 ||
          conversations.some(
            (item) => event.change.kind === 'conversation' && item.id === event.change.value.id,
          ))
      )
        conversations = upsert(conversations, event.change.value)
    }
    return {
      models: array(models ?? [], (item) => {
        const v = record(item)
        return {
          id: id(v.id),
          name: string(v.display_name),
          ...(array(v.model_type ?? [], string).includes('image') ? { imageInput: true } : {}),
        }
      }),
      conversations: conversations
        .filter((item) => item.workspaceId === null && isVisible(item))
        .sort(comparePinnedItems),
      hasMore,
      revision: this.revision,
    }
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
      this.publish({ kind: 'conversation', value })
      return value
    })
  }
  async deleteConversation(conversationId: string): Promise<Conversation> {
    return this.gate.run(`conversation:${conversationId}`, async () => {
      const value = conversationFromRpc(
        await this.request('conversation.delete', { id: id(conversationId) }),
      )
      this.publish({ kind: 'conversation', value })
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
      this.publish({ kind: 'conversation', value: conversation })
      return { conversation, revision: this.revision }
    })
  }
  async archivedConversations(offset: number): Promise<ConversationPage> {
    const start = this.revision
    let conversations = array(
      (await this.request('conversation.list', { archived: true, limit: PAGE_SIZE, offset })) ?? [],
      conversationFromRpc,
    )
    const hasMore = conversations.length === PAGE_SIZE
    const hiddenWorkspaces = new Set<string>()
    for (const { change } of this.since(start)) {
      if (change.kind === 'service') throw new Error(change.error)
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
      revision: this.revision,
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
    const start = this.revision
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
      steps: [...this.steps.values()].filter((step) => step.conversationId === conversationId),
      approvals: pending.flatMap((rows) =>
        array(rows ?? [], (row) => approvalFromRpc(row, conversationId)),
      ),
      directoryGrants: await this.directories(conversationId, 0),
      userInputs: inputs.flatMap((rows) => array(rows ?? [], userInputFromRpc)),
      revision: 0,
      warning: this.persistenceFailures.has(conversationId)
        ? '本次执行状态未能完整保存，请重新打开应用后核对历史。'
        : null,
    }
    let workspace = result.conversation.workspaceId
      ? workspaceFromRpc(
          await this.request('workspace.get', { id: result.conversation.workspaceId }),
        )
      : null
    // 项目读取也属于详情快照，所有异步读取结束后再合并期间发生的事件。
    for (const { change } of this.since(start)) {
      this.mergeDetail(result, change)
      if (change.kind === 'workspace' && change.value.id === workspace?.id) workspace = change.value
    }
    if (!isVisible(result.conversation)) throw new Error('会话已被删除或归档。')
    if (result.conversation.workspaceId !== (workspace?.id ?? null))
      throw new Error('会话所属项目已变化，请重新打开会话。')
    if (workspace && !isVisible(workspace)) throw new Error('所属项目已被删除或归档。')
    // 活动回答可能尚未落库；完整的内存消息优先于数据库及事件中的中间快照。
    for (const message of this.messages.values())
      if (message.conversationId === conversationId)
        result.messages = upsert(result.messages, message)
    result.messages.sort((a, b) => a.sequence - b.sequence)
    result.runs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    result.revision = this.revision
    return result
  }
  async listSteps(conversationId: string, runId: string, afterSequence: number): Promise<StepPage> {
    const run = runFromRpc(await this.request('run.get', { id: runId }))
    if (run.id !== runId || run.conversationId !== conversationId)
      throw new Error('步骤执行归属不匹配')
    const start = this.revision
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
      const live = this.steps.get(step.id)
      return live && live.updatedAt >= step.updatedAt ? live : step
    })
    for (const { change } of this.since(start)) {
      if (change.kind === 'service') throw new Error(change.error)
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
      revision: this.revision,
    }
  }
  async stepDetails(conversationId: string, runId: string, stepId: string): Promise<StepDetails> {
    const key = `${conversationId}:${runId}:${stepId}`
    const pending = this.stepReads.get(key)
    if (pending) return pending
    if (this.stepReads.size >= 16) throw new Error('步骤详情查询较多，请稍后重试。')
    const task = (async () => {
      const step = stepFromRpc(await this.request('step.get', { id: stepId }))
      if (step.id !== stepId || step.runId !== runId || step.conversationId !== conversationId)
        throw new Error('步骤归属不匹配')
      return readStepDetails((method, params) => this.request(method, params), step)
    })()
    this.stepReads.set(key, task)
    try {
      return await task
    } finally {
      this.stepReads.delete(key)
    }
  }
  private saveStep(step: ChatStep): void {
    this.steps.delete(step.id)
    this.steps.set(step.id, step)
    const retained = new Set(boundSteps([...this.steps.values()]).map((value) => value.id))
    for (const key of this.steps.keys())
      if (!retained.has(key)) {
        this.steps.delete(key)
        this.dirtySteps.delete(key)
        this.stepOutputs.delete(key)
      }
  }
  async historyPage(conversationId: string, beforeRunId: string): Promise<ConversationHistory> {
    const start = this.revision
    const result = await this.historyReader.page(conversationId, beforeRunId)
    for (const { change } of this.since(start)) {
      if (change.kind === 'service') throw new Error(change.error)
      if (
        change.kind === 'messages-removed' &&
        change.value.messageIds.some((id) => result.messages.some((message) => message.id === id))
      )
        throw new Error('历史已被编辑，请回到最新消息后重新读取。')
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
    result.messages.sort((a, b) => a.sequence - b.sequence)
    result.runs.sort((a, b) => a.id.localeCompare(b.id))
    result.revision = this.revision
    return result
  }
  private async resetAttachmentStaging(): Promise<void> {
    try {
      const info = await lstat(this.stagingDirectory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('附件暂存目录无效')
      await rm(this.stagingDirectory, { recursive: true })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await mkdir(this.stagingDirectory, { mode: 0o700 })
  }
  private async withStagedAttachments<T>(
    input: AttachmentInput[] | undefined,
    action: (paths: string[]) => Promise<T>,
  ): Promise<T> {
    if (!input?.length) return action([])
    const attachments = parseAttachments(input)
    await this.ready
    if (this.closing || this.state.status !== 'ready') throw new Error('对话服务尚未就绪。')
    if (this.transfers.size >= 2) throw new Error('正在处理其他附件，请稍后重试。')
    const task = (async () => {
      const dir = await mkdtemp(join(this.stagingDirectory, 'upload-'))
      try {
        const paths: string[] = []
        for (const { bytes } of attachments) {
          const path = join(dir, String(paths.length))
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
          paths.push(path)
        }
        return await action(paths)
      } finally {
        // 受理后的临时文件清理失败不能让客户端重发。下次启动在实例锁内回收。
        await rm(dir, { recursive: true, force: true }).catch(() => {
          console.error(
            JSON.stringify({ level: 'warn', module: 'attachments', message: '附件暂存文件待清理' }),
          )
        })
      }
    })()
    this.transfers.add(task)
    try {
      return await task
    } finally {
      this.transfers.delete(task)
    }
  }
  async previewAttachment(input: AttachmentPreviewInput): Promise<AttachmentPreview> {
    return parseAttachmentPreview(
      await this.request('conversation.attachment_preview', {
        conversation_id: input.conversationId,
        message_id: input.messageId,
        index: input.index,
      }),
    )
  }
  async previewDraftAttachment(input: AttachmentInput): Promise<AttachmentPreview> {
    return this.withStagedAttachments([input], async ([path]) =>
      parseAttachmentPreview(await this.request('conversation.attachment_preview', { path })),
    )
  }
  private withMessageContent<T>(
    input: SendMessageInput | ResendMessageInput,
    action: (content: { type: string; text?: string; path?: string }[]) => Promise<T>,
  ): Promise<T> {
    return this.withStagedAttachments(input.attachments, (paths) =>
      action([
        ...(input.text.trim() ? [{ type: 'text', text: input.text }] : []),
        ...paths.map((path) => ({ type: 'image', path })),
      ]),
    )
  }
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const value = record(
      await this.withMessageContent(input, (content) =>
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
  async resend(input: ResendMessageInput): Promise<ResendMessageResult> {
    return this.gate.run(`resend:${input.conversationId}`, async () => {
      const value = record(
        await this.withMessageContent(input, (content) =>
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
      this.flush()
      for (const messageId of removedMessageIds) {
        this.messages.delete(messageId)
        this.dirty.delete(messageId)
      }
      if (removedMessageIds.length)
        this.publish({
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
  private receive(method: string, value: unknown): void {
    const p = record(value)
    if (method === 'conversation.context_usage.updated') {
      const value = contextUsageFromRpc(p.context_usage)
      if (value.conversationId !== id(p.conversation_id) || value.runId !== id(p.run_id))
        throw new Error('上下文占用通知归属不匹配')
      this.publish({ kind: 'context-usage', value })
    } else if (method === 'conversation.created' || method === 'conversation.updated') {
      this.publish({ kind: 'conversation', value: conversationFromRpc(p.conversation) })
    } else if (method === 'message.created' || method === 'message.updated') {
      const message = messageFromRpc(p.message)
      this.checkOwner(p, message)
      this.messages.set(message.id, message)
      this.dirty.delete(message.id)
      this.publish({ kind: 'message', value: message })
    } else if (method === 'step.created' || method === 'step.updated') {
      let step = stepFromRpc(p.step)
      if (
        step.id !== id(p.step_id) ||
        step.runId !== id(p.run_id) ||
        step.conversationId !== id(p.conversation_id)
      )
        throw new Error('步骤归属不匹配')
      const previous = this.steps.get(step.id)
      if (previous)
        step = {
          ...step,
          reasoning: previous.reasoning ?? '',
          reasoningTruncated: previous.reasoningTruncated ?? false,
          text: previous.text,
          commentary: previous.commentary,
          textTruncated: previous.textTruncated,
          output: previous.output,
          outputTruncated: previous.outputTruncated,
          outputSequence: previous.outputSequence,
        }
      this.saveStep(step)
      this.dirtySteps.delete(step.id)
      const run = this.runs.get(step.runId)
      if (run && !run.compaction && isManualCompactionStep(step)) {
        if (run.conversationId !== step.conversationId) throw new Error('压缩执行归属不匹配')
        const updated = { ...run, compaction: { stepId: step.id, outcome: null, error: null } }
        this.runs.set(run.id, updated)
        this.publish({ kind: 'run', value: updated, persisted: true })
      }
      this.publish({ kind: 'step', value: step })
      if (step.parentStepId && (step.type === 'tool_call' || step.type === 'user_input')) {
        const parent = this.steps.get(step.parentStepId)
        if (parent && !parent.commentary) {
          const commentary = { ...parent, commentary: true }
          this.saveStep(commentary)
          this.dirtySteps.delete(parent.id)
          this.publish({ kind: 'step', value: commentary })
        }
      }
      if (!['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(step.status))
        this.stepOutputs.delete(step.id)
    } else if (method === 'tool.output') {
      const stepId = id(p.step_id),
        previous = this.steps.get(stepId)
      // 已被缓存淘汰的输出不重建无归属步骤；持久化结果仍可按需查询。
      if (previous) {
        if (
          previous.conversationId !== id(p.conversation_id) ||
          previous.runId !== id(p.run_id) ||
          previous.type !== 'tool_call'
        )
          throw new Error('工具输出归属不匹配')
        const decoder = this.stepOutputs.get(stepId) ?? new StepOutput()
        this.stepOutputs.set(stepId, decoder)
        const step = decoder.append(previous, p.output)
        this.saveStep(step)
        this.dirtySteps.set(step.id, step)
        this.flushTimer ??= setTimeout(() => this.flush(), 16)
      }
    } else if (method === 'reasoning.delta') {
      const previous = this.steps.get(id(p.step_id))
      if (previous) {
        if (
          previous.type !== 'model_call' ||
          previous.runId !== id(p.run_id) ||
          previous.conversationId !== id(p.conversation_id)
        )
          throw new Error('思考内容归属不匹配')
        const text = string(p.text)
        if (text.length > 512 * 1024) throw new Error('思考增量过长')
        const reasoning = (previous.reasoning ?? '') + text
        const step = {
          ...previous,
          reasoning: truncateStepText(reasoning, STEP_TEXT_LIMIT),
          reasoningTruncated: previous.reasoningTruncated || reasoning.length > STEP_TEXT_LIMIT,
        }
        this.saveStep(step)
        this.dirtySteps.set(step.id, step)
        this.flushTimer ??= setTimeout(() => this.flush(), 16)
      }
    } else if (method === 'message.delta') {
      const messageId = id(p.message_id),
        previous = this.messages.get(messageId)
      if (!previous) throw new Error('消息增量缺少初始消息')
      const message = appendDelta(previous, p)
      this.messages.set(message.id, message)
      this.dirty.set(message.id, message)
      if (p.step_id !== undefined) {
        const step = this.steps.get(id(p.step_id))
        if (step) {
          if (
            step.conversationId !== message.conversationId ||
            step.runId !== message.runId ||
            step.type !== 'model_call'
          )
            throw new Error('模型步骤归属不匹配')
          const text = step.text + string(record(p.delta).text)
          const updated = {
            ...step,
            text: truncateStepText(text, STEP_TEXT_LIMIT),
            textTruncated: step.textTruncated || text.length > STEP_TEXT_LIMIT,
          }
          this.saveStep(updated)
          this.dirtySteps.set(step.id, updated)
        }
      }
      this.flushTimer ??= setTimeout(() => this.flush(), 16)
    } else if (method.startsWith('run.') && p.run !== undefined) {
      let run = runFromRpc(p.run)
      if (id(p.conversation_id) !== run.conversationId || id(p.run_id) !== run.id)
        throw new Error('执行归属不匹配')
      const previous = this.runs.get(run.id)
      if (previous?.compaction) run = { ...run, compaction: previous.compaction }
      this.runs.set(run.id, run)
      if (p.persisted === false) {
        this.persistenceFailures.add(run.conversationId)
        if (this.persistenceFailures.size > 128) throw new Error('执行状态持续保存失败')
      }
      this.flush()
      this.publish({ kind: 'run', value: run, persisted: p.persisted !== false })
      if (!isActiveRun(run)) {
        for (const [key, message] of this.messages)
          if (message.runId === run.id) this.messages.delete(key)
        this.runs.delete(run.id)
      }
    } else if (method === 'approval.requested' || method === 'approval.updated') {
      const approval = approvalFromRpc(p.approval, id(p.conversation_id))
      if (approval.runId !== id(p.run_id) || approval.id !== id(p.approval_id))
        throw new Error('审批归属不匹配')
      this.publish({ kind: 'approval', value: approval })
    } else if (method === 'directory_grant.updated') {
      const grant = directoryGrantFromRpc(p.directory_grant)
      if (grant.conversationId !== id(p.conversation_id)) throw new Error('目录授权归属不匹配')
      this.publish({ kind: 'directory-grant', value: grant })
    } else if (method === 'user_input.requested' || method === 'user_input.updated') {
      const input = userInputFromRpc(p.user_input)
      if (
        input.id !== id(p.input_id) ||
        input.runId !== id(p.run_id) ||
        input.conversationId !== id(p.conversation_id) ||
        input.stepId !== id(p.step_id)
      )
        throw new Error('问题归属不匹配')
      this.publish({ kind: 'user-input', value: input })
    }
    if (this.messages.size > 32 || this.runs.size > 64) throw new Error('活动消息超出限制')
  }
  private checkOwner(params: Record<string, unknown>, message: ChatMessage): void {
    if (
      id(params.conversation_id) !== message.conversationId ||
      id(params.run_id) !== message.runId ||
      id(params.message_id) !== message.id
    )
      throw new Error('消息归属不匹配')
  }
  private flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const message of this.dirty.values()) this.publish({ kind: 'message', value: message })
    this.dirty.clear()
    for (const step of this.dirtySteps.values()) this.publish({ kind: 'step', value: step })
    this.dirtySteps.clear()
  }
  private publish(change: ChatChange): void {
    const event = { revision: ++this.revision, change }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.history.push({ event, bytes })
    this.historyBytes += bytes
    while (this.history.length > 512 || this.historyBytes > 16 * 1024 * 1024) {
      const oldest = this.history.shift()
      if (!oldest) break
      this.historyBytes -= oldest.bytes
      this.droppedRevision = oldest.event.revision
    }
    for (const listener of this.listeners) listener(event)
  }
  private since(revision: number): ChatEvent[] {
    if (revision < this.droppedRevision) throw new Error('对话内容变化较快，请重新加载。')
    return this.history
      .filter((entry) => entry.event.revision > revision)
      .map((entry) => entry.event)
  }
  private mergeDetail(detail: ConversationDetail, change: ChatChange): void {
    if (change.kind === 'service') throw new Error(change.error)
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
    this.closeTask ??= this.shutdown()
    return this.closeTask
  }
  private async shutdown(): Promise<void> {
    this.closing = true
    this.setState({ status: 'closing' })
    // 退出可能发生在握手期间，先关闭已创建的进程，不能等待就绪超时后才取消启动。
    const closeClient = this.client?.close() ?? Promise.resolve()
    void closeClient.catch(() => undefined)
    try {
      await this.ready
    } catch {
      /* 初始化错误已记录，仍需清理已创建的子进程。 */
    }
    try {
      const results = await Promise.allSettled([closeClient, this.retryTask])
      await Promise.allSettled(this.transfers)
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length) throw new AggregateError(errors, '对话服务关闭失败。')
    } finally {
      clearTimeout(this.flushTimer)
      this.dirty.clear()
      this.messages.clear()
      this.runs.clear()
      this.steps.clear()
      this.dirtySteps.clear()
      this.stepOutputs.clear()
      this.persistenceFailures.clear()
      this.history.length = 0
      this.listeners.clear()
      this.stateListeners.clear()
    }
  }
}

/** 服务程序与客户端采用相同架构，资源路径不依赖当前工作目录。 */
export function resolveBackendExecutable(
  resourceRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (!isAbsolute(resourceRoot)) throw new Error('服务资源根目录必须是绝对路径')
  return join(
    resourceRoot,
    'backend',
    resolveResourceTarget(platform, architecture),
    platform === 'win32' ? 'callum.exe' : 'callum',
  )
}
export function publicChatError(error: unknown): string {
  if (error instanceof RpcError) return error.message.replaceAll('工作区', '项目')
  if (error instanceof Error && !/ENOENT|EACCES|JSON|格式|无效|不匹配/.test(error.message))
    return error.message
  return '无法完成对话操作，请重试。'
}
