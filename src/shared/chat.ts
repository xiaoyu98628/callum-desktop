/** 客户端对话契约；仅包含界面需要的业务数据，不暴露厂商配置或传输方法。 */
export interface ChatModel {
  id: string
  name: string
}
export interface Conversation {
  id: string
  workspaceId: string | null
  title: string
  modelId: string
  modelName: string
  updatedAt: number
  deletedAt: number | null
  archivedAt: number | null
}
export interface Workspace {
  id: string
  name: string
  rootPath: string
  updatedAt: number
  deletedAt: number | null
  archivedAt: number | null
}
export interface WorkspaceInput {
  name: string
  rootPath: string
}
export interface SelectedDirectory {
  path: string
  name: string
}
export interface ConversationPage {
  conversations: Conversation[]
  hasMore: boolean
  revision: number
}
export interface WorkspacePage {
  workspaces: Workspace[]
  hasMore: boolean
  revision: number
}
export interface ContentBlock {
  type: string
  text: string
  path: string
}
export interface ChatMessage {
  id: string
  conversationId: string
  runId: string
  sequence: number
  role: 'user' | 'assistant'
  content: ContentBlock[]
  status: string
}
export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export interface ChatRun {
  id: string
  conversationId: string
  status: RunStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
}
export interface ChatApproval {
  id: string
  conversationId: string
  runId: string
  status: string
  toolName: string
  snapshot: string
}
export type ChatChange =
  | { kind: 'conversation'; value: Conversation }
  | { kind: 'workspace'; value: Workspace }
  | { kind: 'message'; value: ChatMessage }
  | { kind: 'run'; value: ChatRun; persisted: boolean }
  | { kind: 'approval'; value: ChatApproval }
  | { kind: 'service'; error: string }
export interface ChatEvent {
  revision: number
  change: ChatChange
}
export interface ChatOverview {
  models: ChatModel[]
  conversations: Conversation[]
  hasMore: boolean
  revision: number
}
export interface ConversationDetail {
  conversation: Conversation
  messages: ChatMessage[]
  runs: ChatRun[]
  approvals: ChatApproval[]
  revision: number
  warning: string | null
}
export interface SendMessageInput {
  conversationId: string | null
  workspaceId?: string | null
  modelId: string
  text: string
}
export interface SendMessageResult {
  conversationId: string
  runId: string
}
export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: string }
export const MAX_MESSAGE_LENGTH = 100_000
export const PAGE_SIZE = 50

export function isActiveRun(run: ChatRun): boolean {
  return ['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(run.status)
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('数据格式无效')
  return value as Record<string, unknown>
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('文本格式无效')
  return value
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('数字格式无效')
  return value
}
export function id(value: unknown): string {
  const result = string(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))
    throw new Error('标识无效')
  return result
}
export function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('列表格式无效')
  return value.map(parse)
}
export function parseModel(value: unknown): ChatModel {
  const v = record(value)
  return { id: id(v.id), name: string(v.name) }
}
export function parseConversation(value: unknown): Conversation {
  const v = record(value)
  return {
    id: id(v.id),
    workspaceId: v.workspaceId === null ? null : id(v.workspaceId),
    title: string(v.title),
    modelId: id(v.modelId),
    modelName: string(v.modelName),
    updatedAt: integer(v.updatedAt),
    deletedAt: v.deletedAt === null ? null : integer(v.deletedAt),
    archivedAt: v.archivedAt === null ? null : integer(v.archivedAt),
  }
}
export function isVisible(value: { deletedAt: number | null; archivedAt: number | null }): boolean {
  return value.deletedAt === null && value.archivedAt === null
}
export function parseName(value: unknown): string {
  const name = string(value).trim()
  if (
    !name ||
    new TextEncoder().encode(name).length > 1024 ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('名称不能为空、包含控制字符或超过 1024 字节')
  return name
}
export function parseWorkspaceInput(value: unknown): WorkspaceInput {
  const v = record(value)
  if (Object.keys(v).some((key) => !['name', 'rootPath'].includes(key)))
    throw new Error('工作区参数无效')
  const rootPath = string(v.rootPath)
  if (!rootPath || rootPath.length > 8192 || rootPath.includes('\0'))
    throw new Error('工作区路径无效')
  return { name: parseName(v.name), rootPath }
}
export function parseWorkspace(value: unknown): Workspace {
  const v = record(value)
  return {
    id: id(v.id),
    name: string(v.name),
    rootPath: string(v.rootPath),
    updatedAt: integer(v.updatedAt),
    deletedAt: v.deletedAt === null ? null : integer(v.deletedAt),
    archivedAt: v.archivedAt === null ? null : integer(v.archivedAt),
  }
}
export function parseSelectedDirectory(value: unknown): SelectedDirectory | null {
  if (value === null) return null
  const v = record(value)
  return { path: string(v.path), name: string(v.name) }
}
export function parseConversationPage(value: unknown): ConversationPage {
  const v = record(value)
  if (typeof v.hasMore !== 'boolean') throw new Error('分页格式无效')
  return {
    conversations: array(v.conversations, parseConversation),
    hasMore: v.hasMore,
    revision: integer(v.revision),
  }
}
export function parseWorkspacePage(value: unknown): WorkspacePage {
  const v = record(value)
  if (typeof v.hasMore !== 'boolean') throw new Error('分页格式无效')
  return {
    workspaces: array(v.workspaces, parseWorkspace),
    hasMore: v.hasMore,
    revision: integer(v.revision),
  }
}
export function parseMessage(value: unknown): ChatMessage {
  const v = record(value)
  if (v.role !== 'user' && v.role !== 'assistant') throw new Error('消息角色无效')
  return {
    id: id(v.id),
    conversationId: id(v.conversationId),
    runId: id(v.runId),
    sequence: integer(v.sequence, 1),
    role: v.role,
    content: array(v.content, (item) => {
      const b = record(item)
      return { type: string(b.type), text: string(b.text), path: string(b.path) }
    }),
    status: string(v.status),
  }
}
export function parseRun(value: unknown): ChatRun {
  const v = record(value)
  const status = string(v.status)
  if (
    ![
      'pending',
      'running',
      'awaiting_approval',
      'awaiting_user_input',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ].includes(status)
  )
    throw new Error('执行状态无效')
  return {
    id: id(v.id),
    conversationId: id(v.conversationId),
    status: status as RunStatus,
    error: v.error === null ? null : string(v.error),
    createdAt: integer(v.createdAt),
    finishedAt: v.finishedAt === null ? null : integer(v.finishedAt),
  }
}
export function parseApproval(value: unknown): ChatApproval {
  const v = record(value)
  return {
    id: id(v.id),
    conversationId: id(v.conversationId),
    runId: id(v.runId),
    status: string(v.status),
    toolName: string(v.toolName),
    snapshot: string(v.snapshot),
  }
}
export function parseOverview(value: unknown): ChatOverview {
  const v = record(value)
  if (typeof v.hasMore !== 'boolean') throw new Error('分页格式无效')
  return {
    models: array(v.models, parseModel),
    conversations: array(v.conversations, parseConversation),
    hasMore: v.hasMore,
    revision: integer(v.revision),
  }
}
export function parseDetail(value: unknown): ConversationDetail {
  const v = record(value)
  return {
    conversation: parseConversation(v.conversation),
    messages: array(v.messages, parseMessage),
    runs: array(v.runs, parseRun),
    approvals: array(v.approvals, parseApproval),
    revision: integer(v.revision),
    warning: v.warning === null ? null : string(v.warning),
  }
}
export function parseSendInput(value: unknown): SendMessageInput {
  const v = record(value)
  if (
    Object.keys(v).some(
      (key) => !['conversationId', 'workspaceId', 'modelId', 'text'].includes(key),
    )
  )
    throw new Error('消息参数无效')
  const text = string(v.text).trim()
  if (!text || text.length > MAX_MESSAGE_LENGTH)
    throw new Error('消息不能为空，且不能超过 100000 个字符')
  const workspaceId = v.workspaceId == null ? null : id(v.workspaceId)
  if (workspaceId && v.conversationId !== null) throw new Error('已有会话不能在发送时修改工作区')
  return {
    conversationId: v.conversationId === null ? null : id(v.conversationId),
    workspaceId,
    modelId: id(v.modelId),
    text,
  }
}
export function parseSendResult(value: unknown): SendMessageResult {
  const v = record(value)
  return { conversationId: id(v.conversationId), runId: id(v.runId) }
}
export function parseChatEvent(value: unknown): ChatEvent {
  const v = record(value),
    change = record(v.change)
  const revision = integer(v.revision)
  switch (change.kind) {
    case 'workspace':
      return { revision, change: { kind: 'workspace', value: parseWorkspace(change.value) } }
    case 'conversation':
      return { revision, change: { kind: 'conversation', value: parseConversation(change.value) } }
    case 'message':
      return { revision, change: { kind: 'message', value: parseMessage(change.value) } }
    case 'run': {
      if (typeof change.persisted !== 'boolean') throw new Error('执行数据无效')
      return {
        revision,
        change: { kind: 'run', value: parseRun(change.value), persisted: change.persisted },
      }
    }
    case 'approval':
      return { revision, change: { kind: 'approval', value: parseApproval(change.value) } }
    case 'service':
      return { revision, change: { kind: 'service', error: string(change.error) } }
    default:
      throw new Error('事件类型无效')
  }
}
export function parseResult<T>(value: unknown, parse: (item: unknown) => T): ChatResult<T> {
  const v = record(value)
  if (v.ok === false) return { ok: false, error: string(v.error) }
  if (v.ok !== true) throw new Error('响应格式无效')
  return { ok: true, value: parse(v.value) }
}
