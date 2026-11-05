import type {
  ChatEvent,
  ChatMessage,
  ChatOverview,
  ChatResult,
  ConversationDetail,
  Conversation,
  ConversationPage,
  Workspace,
  WorkspaceInput,
  WorkspacePage,
  SelectedDirectory,
  SendMessageInput,
  SendMessageResult,
} from './chat'
import type { ModelCatalog, ModelInput, ProviderInput } from './models'

/** 只描述界面需要的数据，不依赖 Electron、Node.js 或 Vue。 */
export interface AppInfo {
  name: string
  version: string
  platform: 'darwin' | 'win32' | 'linux'
}

/** preload 暴露的能力清单，每个方法对应固定的用途。 */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>
  copyCode(text: string): Promise<ChatResult<boolean>>
  openWebLink(url: string): Promise<ChatResult<boolean>>
  getModelCatalog(): Promise<ChatResult<ModelCatalog>>
  saveModelProvider(input: ProviderInput): Promise<ChatResult<string>>
  deleteModelProvider(providerId: string): Promise<ChatResult<string>>
  saveModel(input: ModelInput): Promise<ChatResult<string>>
  setModelEnabled(modelId: string, enabled: boolean): Promise<ChatResult<string>>
  deleteModel(modelId: string): Promise<ChatResult<string>>
  getChatOverview(offset: number): Promise<ChatResult<ChatOverview>>
  chooseWorkspaceDirectory(): Promise<ChatResult<SelectedDirectory | null>>
  listWorkspaces(offset: number): Promise<ChatResult<WorkspacePage>>
  getWorkspaceConversations(
    workspaceId: string,
    offset: number,
  ): Promise<ChatResult<ConversationPage>>
  createWorkspace(input: WorkspaceInput): Promise<ChatResult<Workspace>>
  renameWorkspace(workspaceId: string, name: string): Promise<ChatResult<Workspace>>
  deleteWorkspace(workspaceId: string): Promise<ChatResult<Workspace>>
  renameConversation(conversationId: string, title: string): Promise<ChatResult<Conversation>>
  deleteConversation(conversationId: string): Promise<ChatResult<Conversation>>
  getConversation(conversationId: string): Promise<ChatResult<ConversationDetail>>
  getEarlierMessages(
    conversationId: string,
    beforeSequence: number,
  ): Promise<ChatResult<ChatMessage[]>>
  sendMessage(input: SendMessageInput): Promise<ChatResult<SendMessageResult>>
  cancelRun(runId: string): Promise<ChatResult<boolean>>
  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ChatResult<boolean>>
  /** 每个窗口一个订阅，由根组件持有；返回可重复调用的取消订阅函数。 */
  onChatEvent(listener: (event: ChatEvent) => void): () => void
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
    !('platform' in value) ||
    (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux')
  ) {
    throw new Error('无效的应用信息')
  }

  return { name: value.name, version: value.version, platform: value.platform }
}
