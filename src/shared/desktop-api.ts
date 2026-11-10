import type {
  ChatEvent,
  StepPage,
  StepDetails,
  ApprovalScope,
  DirectoryGrant,
  ChatUserInput,
  UserInputAnswer,
  ChatOverview,
  ChatResult,
  ConversationDetail,
  ConversationHistory,
  Conversation,
  ConversationPage,
  ConversationUpdate,
  Workspace,
  WorkspaceInput,
  WorkspaceChange,
  WorkspacePage,
  WorkspaceUpdate,
  SelectedDirectory,
  SendMessageInput,
  SendMessageResult,
  ResendMessageInput,
  ResendMessageResult,
  CompactConversationInput,
} from './chat'
import type { ModelCatalog, ModelInput, ProviderInput } from './models'
import type { ExecutionSettings } from './execution'
import type { ContextUsage, ContextUsageInput } from './context-usage'

/** 只描述界面需要的数据，不依赖 Electron、Node.js 或 Vue。 */
export interface AppInfo {
  name: string
  version: string
  platform: 'darwin' | 'win32' | 'linux'
  /** 主进程读取的真实用户目录，用于路径显示。 */
  homeDirectory: string
}

/** 应用持有的服务生命周期；失败与正常关闭分别展示。 */
export type ServiceState =
  | { status: 'starting' | 'ready' | 'closing' }
  | { status: 'startup-failed' | 'failed'; error: string }

/** preload 暴露的能力清单，每个方法对应固定的用途。 */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>
  getServiceState(): Promise<ServiceState>
  /** 仅重试尚未就绪的失败启动，不重放业务请求。 */
  retryServiceStart(): Promise<ChatResult<ServiceState>>
  /** 根组件先订阅再查询快照；卸载时取消订阅。 */
  onServiceState(listener: (state: ServiceState) => void): () => void
  copyCode(text: string): Promise<ChatResult<boolean>>
  copyMessage(text: string): Promise<ChatResult<boolean>>
  openWebLink(url: string): Promise<ChatResult<boolean>>
  getExecutionSettings(): Promise<ChatResult<ExecutionSettings>>
  updateExecutionSettings(input: ExecutionSettings): Promise<ChatResult<ExecutionSettings>>
  getModelCatalog(): Promise<ChatResult<ModelCatalog>>
  saveModelProvider(input: ProviderInput): Promise<ChatResult<string>>
  deleteModelProvider(providerId: string): Promise<ChatResult<string>>
  saveModel(input: ModelInput): Promise<ChatResult<string>>
  setModelEnabled(modelId: string, enabled: boolean): Promise<ChatResult<string>>
  deleteModel(modelId: string): Promise<ChatResult<string>>
  getChatOverview(offset: number): Promise<ChatResult<ChatOverview>>
  chooseWorkspaceDirectories(selectionId: string): Promise<ChatResult<SelectedDirectory[]>>
  discardWorkspaceDirectories(selectionId: string, path?: string): Promise<ChatResult<null>>
  listWorkspaces(offset: number): Promise<ChatResult<WorkspacePage>>
  getWorkspaceConversations(
    workspaceId: string,
    offset: number,
  ): Promise<ChatResult<ConversationPage>>
  createWorkspace(input: WorkspaceInput, selectionId: string): Promise<ChatResult<Workspace>>
  updateWorkspace(
    workspaceId: string,
    input: WorkspaceChange,
    selectionId?: string,
  ): Promise<ChatResult<WorkspaceUpdate>>
  deleteWorkspace(workspaceId: string): Promise<ChatResult<Workspace>>
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<ChatResult<WorkspaceUpdate>>
  setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<ChatResult<WorkspaceUpdate>>
  listArchivedWorkspaces(offset: number): Promise<ChatResult<WorkspacePage>>
  renameConversation(conversationId: string, title: string): Promise<ChatResult<Conversation>>
  deleteConversation(conversationId: string): Promise<ChatResult<Conversation>>
  setConversationPinned(
    conversationId: string,
    pinned: boolean,
  ): Promise<ChatResult<ConversationUpdate>>
  setConversationArchived(
    conversationId: string,
    archived: boolean,
  ): Promise<ChatResult<ConversationUpdate>>
  listArchivedConversations(offset: number): Promise<ChatResult<ConversationPage>>
  getConversation(conversationId: string): Promise<ChatResult<ConversationDetail>>
  getContextUsage(input: ContextUsageInput): Promise<ChatResult<ContextUsage>>
  getConversationHistory(
    conversationId: string,
    beforeRunId: string,
  ): Promise<ChatResult<ConversationHistory>>
  listRunSteps(
    conversationId: string,
    runId: string,
    afterSequence: number,
  ): Promise<ChatResult<StepPage>>
  getStepDetails(
    conversationId: string,
    runId: string,
    stepId: string,
  ): Promise<ChatResult<StepDetails>>
  sendMessage(input: SendMessageInput): Promise<ChatResult<SendMessageResult>>
  resendMessage(input: ResendMessageInput): Promise<ChatResult<ResendMessageResult>>
  compactConversation(input: CompactConversationInput): Promise<ChatResult<SendMessageResult>>
  cancelRun(runId: string): Promise<ChatResult<boolean>>
  submitUserInput(
    inputId: string,
    runId: string,
    answer: UserInputAnswer,
  ): Promise<ChatResult<ChatUserInput>>
  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope?: ApprovalScope,
  ): Promise<ChatResult<boolean>>
  listDirectoryGrants(conversationId: string, offset: number): Promise<ChatResult<DirectoryGrant[]>>
  revokeDirectoryGrant(conversationId: string, grantId: string): Promise<ChatResult<DirectoryGrant>>
  /** 每个窗口一个订阅，由根组件持有；返回可重复调用的取消订阅函数。 */
  onChatEvent(listener: (event: ChatEvent) => void): () => void
}

/** 仅接收已知生命周期，不将任意错误对象传入界面。 */
export function parseServiceState(value: unknown): ServiceState {
  if (typeof value === 'object' && value !== null && 'status' in value) {
    if (value.status === 'starting' || value.status === 'ready' || value.status === 'closing')
      return { status: value.status }
    if (
      (value.status === 'startup-failed' || value.status === 'failed') &&
      'error' in value &&
      typeof value.error === 'string' &&
      value.error.length > 0 &&
      value.error.length <= 4096
    )
      return { status: value.status, error: value.error }
  }
  throw new Error('无效的服务状态')
}

/** 通信边界使用运行时校验，不能仅信任静态类型。 */
export function parseAppInfo(value: unknown): AppInfo {
  if (typeof value !== 'object' || value === null) {
    throw new Error('无效的应用信息')
  }

  if (
    !('name' in value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    !('homeDirectory' in value) ||
    typeof value.homeDirectory !== 'string' ||
    value.homeDirectory.length === 0 ||
    !('platform' in value) ||
    (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux')
  ) {
    throw new Error('无效的应用信息')
  }

  return {
    name: value.name,
    version: value.version,
    platform: value.platform,
    homeDirectory: value.homeDirectory,
  }
}
