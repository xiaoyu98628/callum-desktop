import { parseContextUsage } from './context-usage.ts'
import type { ContextUsage } from './context-usage.ts'
import { array, id, integer, record, string } from './validation.ts'
export { array, id, integer, record, string } from './validation.ts'

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
  pinnedAt: number | null
  deletedAt: number | null
  archivedAt: number | null
}
export interface Workspace {
  id: string
  name: string
  rootPath: string
  otherPaths: string[]
  updatedAt: number
  pinnedAt: number | null
  deletedAt: number | null
  archivedAt: number | null
}
export interface WorkspaceInput {
  name: string
  rootPath: string
  otherPaths?: string[]
}
/** 编辑项目；完整目录更新携带原目录快照，第一项为原主要目录。 */
export interface WorkspaceChange {
  name: string
  rootPath?: string
  otherPaths?: string[]
  expectedFolders?: string[]
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
/** 管理操作返回所发布快照的版本，用于丢弃迟到通知和查询。 */
export interface ConversationUpdate {
  conversation: Conversation
  revision: number
}
export interface WorkspacePage {
  workspaces: Workspace[]
  hasMore: boolean
  revision: number
}
/** 项目管理快照与其发布版本。 */
export interface WorkspaceUpdate {
  workspace: Workspace
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
  /** 仅在首个持久化步骤明确标记为手动压缩时提供。 */
  compaction?: {
    stepId: string
    outcome: 'compressed' | 'skipped' | 'unknown' | null
    error: string | null
  }
}
/** 步骤快照包含有界的即时文字和工具输出；持久化详情通过专用查询读取。 */
export interface ChatStep {
  id: string
  conversationId: string
  runId: string
  parentStepId: string | null
  sequence: number
  type: string
  name: string
  purpose: string
  status: RunStatus
  input: string
  inputTruncated: boolean
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  updatedAt: number
  text: string
  commentary: boolean
  textTruncated: boolean
  reasoning?: string
  reasoningTruncated?: boolean
  output: string
  outputTruncated: boolean
  outputSequence: number
}
export interface StepPage {
  steps: ChatStep[]
  afterSequence: number
  nextSequence: number
  hasMore: boolean
  revision: number
}
export interface StepDetails {
  id: string
  conversationId: string
  runId: string
  input: string
  inputTruncated: boolean
  output: string
  outputTruncated: boolean
  text: string | null
  textTruncated: boolean
  reasoning?: string
  reasoningTruncated?: boolean
}
export interface DirectoryScope {
  rootPath: string
  access: 'read' | 'read_write'
}
export interface DirectoryGrant {
  id: string
  conversationId: string
  approvalId: string
  scope: DirectoryScope
  createdAt: number
  revokedAt: number | null
}
export type ApprovalScope = 'once' | 'conversation_directory'
export interface ApprovalReview {
  stepId: string
  decision: 'approved' | 'rejected' | 'handoff'
  reason: string
}
export interface ChatApproval {
  id: string
  conversationId: string
  runId: string
  status: string
  toolName: string
  snapshot: string
  directoryScope: DirectoryScope | null
  decidedBy?: string
  review?: ApprovalReview
}
export interface UserInputAnswer {
  optionIndex: number | null
  text: string
  skipped: boolean
}
export interface ChatUserInput {
  id: string
  conversationId: string
  runId: string
  stepId: string
  question: string
  options: string[]
  status: 'pending' | 'answered' | 'skipped' | 'cancelled' | 'interrupted' | 'failed'
  answer: UserInputAnswer | null
  createdAt: number
  updatedAt: number
}
export type ChatChange =
  | { kind: 'context-usage'; value: ContextUsage }
  | { kind: 'conversation'; value: Conversation }
  | { kind: 'workspace'; value: Workspace }
  | { kind: 'message'; value: ChatMessage }
  | {
      kind: 'messages-removed'
      value: { id: string; conversationId: string; messageIds: string[] }
    }
  | { kind: 'step'; value: ChatStep }
  | { kind: 'run'; value: ChatRun; persisted: boolean }
  | { kind: 'approval'; value: ChatApproval }
  | { kind: 'directory-grant'; value: DirectoryGrant }
  | { kind: 'user-input'; value: ChatUserInput }
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
  steps: ChatStep[]
  approvals: ChatApproval[]
  directoryGrants: DirectoryGrant[]
  userInputs: ChatUserInput[]
  revision: number
  warning: string | null
  history?: { beforeRunId: string; hasMore: boolean }
}
/** 消息和独立执行共用游标，单页最多 25 个执行、50 条消息。 */
export interface ConversationHistory {
  messages: ChatMessage[]
  runs: ChatRun[]
  beforeRunId: string
  hasMore: boolean
  revision: number
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
export interface CompactConversationInput {
  conversationId: string
  modelId: string
}
export interface ResendMessageInput {
  conversationId: string
  messageId: string
  modelId: string
  text: string
}
export interface ResendMessageResult extends SendMessageResult {
  removedMessageIds: string[]
}
export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: string }
export const MAX_MESSAGE_LENGTH = 100_000
export const PAGE_SIZE = 50
export const MAX_WORKSPACE_FOLDERS = 16

export function isActiveRun(run: ChatRun): boolean {
  return ['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(run.status)
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
    pinnedAt: v.pinnedAt === null ? null : integer(v.pinnedAt),
    deletedAt: v.deletedAt === null ? null : integer(v.deletedAt),
    archivedAt: v.archivedAt === null ? null : integer(v.archivedAt),
  }
}
export function isVisible(value: { deletedAt: number | null; archivedAt: number | null }): boolean {
  return value.deletedAt === null && value.archivedAt === null
}
/** 与 Go 的 pinned_at、updated_at、id 倒序保持一致。 */
export function comparePinnedItems(
  a: { id: string; pinnedAt: number | null; updatedAt: number },
  b: { id: string; pinnedAt: number | null; updatedAt: number },
): number {
  return (
    (b.pinnedAt ?? -1) - (a.pinnedAt ?? -1) || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)
  )
}
export function parseConversationUpdate(value: unknown): ConversationUpdate {
  const v = record(value)
  return { conversation: parseConversation(v.conversation), revision: integer(v.revision, 1) }
}
export function parseWorkspaceUpdate(value: unknown): WorkspaceUpdate {
  const v = record(value)
  return { workspace: parseWorkspace(v.workspace), revision: integer(v.revision, 1) }
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
  if (Object.keys(v).some((key) => !['name', 'rootPath', 'otherPaths'].includes(key)))
    throw new Error('项目参数无效')
  const rootPath = v.rootPath === '' ? '' : workspacePath(v.rootPath)
  return {
    name: parseName(v.name),
    rootPath,
    ...(v.otherPaths === undefined
      ? {}
      : { otherPaths: otherWorkspacePaths(rootPath, v.otherPaths) }),
  }
}
export function parseWorkspaceChange(value: unknown): WorkspaceChange {
  const v = record(value)
  if (
    Object.keys(v).some(
      (key) => !['name', 'rootPath', 'otherPaths', 'expectedFolders'].includes(key),
    )
  )
    throw new Error('项目更新参数无效')
  const rootPath =
    v.rootPath === undefined ? undefined : v.rootPath === '' ? '' : workspacePath(v.rootPath)
  if (
    (v.otherPaths === undefined) !== (v.expectedFolders === undefined) ||
    (v.otherPaths !== undefined && rootPath === undefined)
  )
    throw new Error('项目目录更新必须包含完整列表和原目录快照')
  if (rootPath === '' && v.otherPaths === undefined)
    throw new Error('清空主要目录必须同时提交完整目录列表')
  const expected =
    v.expectedFolders === undefined ? undefined : array(v.expectedFolders, workspacePath)
  if (
    expected &&
    (expected.length > MAX_WORKSPACE_FOLDERS || new Set(expected).size !== expected.length)
  )
    throw new Error('原项目目录快照无效')
  return {
    name: parseName(v.name),
    ...(rootPath === undefined ? {} : { rootPath }),
    ...(v.otherPaths === undefined
      ? {}
      : {
          otherPaths: otherWorkspacePaths(rootPath ?? '', v.otherPaths),
          expectedFolders: expected ?? [],
        }),
  }
}
export function parseWorkspace(value: unknown): Workspace {
  const v = record(value)
  const rootPath = v.rootPath === '' ? '' : workspacePath(v.rootPath)
  return {
    id: id(v.id),
    name: string(v.name),
    rootPath,
    otherPaths: otherWorkspacePaths(rootPath, v.otherPaths ?? []),
    updatedAt: integer(v.updatedAt),
    pinnedAt: v.pinnedAt === null ? null : integer(v.pinnedAt),
    deletedAt: v.deletedAt === null ? null : integer(v.deletedAt),
    archivedAt: v.archivedAt === null ? null : integer(v.archivedAt),
  }
}
function workspacePath(value: unknown): string {
  const path = string(value)
  if (!path || new TextEncoder().encode(path).length > 8192 || path.includes('\0'))
    throw new Error('项目路径无效')
  return path
}
function otherWorkspacePaths(rootPath: string, value: unknown): string[] {
  const paths = array(value, workspacePath)
  if (!rootPath && paths.length) throw new Error('没有主要目录时不能包含其他目录')
  if (paths.length >= MAX_WORKSPACE_FOLDERS)
    throw new Error(`项目最多可添加 ${MAX_WORKSPACE_FOLDERS} 个文件夹。`)
  if (new Set([rootPath, ...paths]).size !== paths.length + 1)
    throw new Error('项目文件夹不能重复。')
  return paths
}
export function parseSelectedDirectory(value: unknown): SelectedDirectory {
  const v = record(value)
  return { path: workspacePath(v.path), name: string(v.name) }
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
  const compaction = v.compaction === undefined ? null : record(v.compaction)
  if (
    compaction &&
    compaction.outcome !== null &&
    !['compressed', 'skipped', 'unknown'].includes(string(compaction.outcome))
  )
    throw new Error('压缩结果状态无效')
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
    ...(compaction
      ? {
          compaction: {
            stepId: id(compaction.stepId),
            outcome: compaction.outcome as 'compressed' | 'skipped' | 'unknown' | null,
            error: compaction.error === null ? null : string(compaction.error),
          },
        }
      : {}),
  }
}
function reasoningProjection(v: Record<string, unknown>): {
  reasoning?: string
  reasoningTruncated?: boolean
} {
  if (v.reasoning === undefined && v.reasoningTruncated === undefined) return {}
  const reasoning = string(v.reasoning)
  if (reasoning.length > 512 * 1024 || typeof v.reasoningTruncated !== 'boolean')
    throw new Error('思考内容格式无效或过长')
  return { reasoning, reasoningTruncated: v.reasoningTruncated }
}
export function parseStep(value: unknown): ChatStep {
  const v = record(value)
  const status = parseRun({
    id: v.runId,
    conversationId: v.conversationId,
    status: v.status,
    error: null,
    createdAt: 0,
    finishedAt: null,
  }).status
  if (
    typeof v.inputTruncated !== 'boolean' ||
    typeof v.commentary !== 'boolean' ||
    typeof v.textTruncated !== 'boolean' ||
    typeof v.outputTruncated !== 'boolean'
  )
    throw new Error('步骤格式无效')
  const input = string(v.input),
    text = string(v.text),
    output = string(v.output)
  if (input.length > 128 * 1024 || text.length > 512 * 1024 || output.length > 64 * 1024)
    throw new Error('步骤内容过长')
  return {
    id: id(v.id),
    conversationId: id(v.conversationId),
    runId: id(v.runId),
    parentStepId: v.parentStepId === null ? null : id(v.parentStepId),
    sequence: integer(v.sequence, 1),
    type: string(v.type),
    name: string(v.name),
    purpose: string(v.purpose),
    status,
    input,
    inputTruncated: v.inputTruncated,
    error: v.error === null ? null : string(v.error),
    startedAt: v.startedAt === null ? null : integer(v.startedAt),
    finishedAt: v.finishedAt === null ? null : integer(v.finishedAt),
    updatedAt: integer(v.updatedAt),
    text,
    commentary: v.commentary,
    textTruncated: v.textTruncated,
    ...reasoningProjection(v),
    output,
    outputTruncated: v.outputTruncated,
    outputSequence: integer(v.outputSequence),
  }
}
export function parseStepPage(value: unknown): StepPage {
  const v = record(value)
  if (typeof v.hasMore !== 'boolean') throw new Error('步骤分页格式无效')
  const steps = array(v.steps, parseStep),
    afterSequence = integer(v.afterSequence),
    nextSequence = integer(v.nextSequence)
  if (
    steps.length > 50 ||
    nextSequence !== (steps.at(-1)?.sequence ?? afterSequence) ||
    (v.hasMore && !steps.length) ||
    steps.some(
      (step, index) =>
        step.sequence <= (steps[index - 1]?.sequence ?? afterSequence) ||
        step.runId !== steps[0]?.runId ||
        step.conversationId !== steps[0]?.conversationId,
    )
  )
    throw new Error('步骤分页顺序无效')
  return { steps, afterSequence, nextSequence, hasMore: v.hasMore, revision: integer(v.revision) }
}
export function parseStepDetails(value: unknown): StepDetails {
  const v = record(value)
  if (
    typeof v.inputTruncated !== 'boolean' ||
    typeof v.outputTruncated !== 'boolean' ||
    typeof v.textTruncated !== 'boolean'
  )
    throw new Error('步骤详情格式无效')
  const input = string(v.input),
    output = string(v.output)
  const text = v.text === null ? null : string(v.text)
  if (input.length > 128 * 1024 || output.length > 256 * 1024 || (text?.length ?? 0) > 512 * 1024)
    throw new Error('步骤详情过长')
  return {
    id: id(v.id),
    conversationId: id(v.conversationId),
    runId: id(v.runId),
    input,
    inputTruncated: v.inputTruncated,
    output,
    text,
    outputTruncated: v.outputTruncated,
    textTruncated: v.textTruncated,
    ...reasoningProjection(v),
  }
}
export function parseDirectoryScope(value: unknown): DirectoryScope {
  const v = record(value)
  if (v.access !== 'read' && v.access !== 'read_write') throw new Error('目录授权范围无效')
  const rootPath = string(v.rootPath)
  if (!rootPath) throw new Error('目录路径无效')
  return { rootPath, access: v.access }
}
export function parseDirectoryGrant(value: unknown): DirectoryGrant {
  const v = record(value)
  return {
    id: id(v.id),
    conversationId: id(v.conversationId),
    approvalId: id(v.approvalId),
    scope: parseDirectoryScope(v.scope),
    createdAt: integer(v.createdAt),
    revokedAt: v.revokedAt === null ? null : integer(v.revokedAt),
  }
}
export function parseApprovalReview(value: unknown): ApprovalReview {
  const v = record(value)
  if (v.decision !== 'approved' && v.decision !== 'rejected' && v.decision !== 'handoff')
    throw new Error('审批审核结论无效')
  const reason = string(v.reason)
  if (!reason.trim() || new TextEncoder().encode(reason).length > 512)
    throw new Error('审批审核理由无效')
  return { stepId: id(v.stepId), decision: v.decision, reason }
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
    directoryScope: v.directoryScope == null ? null : parseDirectoryScope(v.directoryScope),
    ...(v.decidedBy == null ? {} : { decidedBy: string(v.decidedBy) }),
    ...(v.review == null ? {} : { review: parseApprovalReview(v.review) }),
  }
}
export function parseUserInputAnswer(value: unknown): UserInputAnswer {
  const v = record(value)
  if (Object.keys(v).some((key) => !['optionIndex', 'text', 'skipped'].includes(key)))
    throw new Error('回复包含不支持的字段')
  const text = string(v.text)
  const optionIndex = v.optionIndex === null ? null : integer(v.optionIndex)
  if (
    typeof v.skipped !== 'boolean' ||
    (optionIndex !== null && optionIndex > 7) ||
    new TextEncoder().encode(text).length > 4096 ||
    text.includes('\0')
  )
    throw new Error('回复格式无效或内容过长')
  if (v.skipped ? optionIndex !== null || text !== '' : optionIndex === null && !text.trim())
    throw new Error('请选择选项或填写回复')
  return { optionIndex, text, skipped: v.skipped }
}
export function parseUserInput(value: unknown): ChatUserInput {
  const v = record(value)
  const status = v.status
  if (
    status !== 'pending' &&
    status !== 'answered' &&
    status !== 'skipped' &&
    status !== 'cancelled' &&
    status !== 'interrupted' &&
    status !== 'failed'
  )
    throw new Error('问题状态无效')
  const question = string(v.question)
  const options = array(v.options, string)
  if (
    !question.trim() ||
    new TextEncoder().encode(question).length > 4096 ||
    options.length > 8 ||
    options.some((option) => !option.trim() || new TextEncoder().encode(option).length > 1024) ||
    new Set(options).size !== options.length
  )
    throw new Error('问题内容无效')
  const answer = v.answer === null ? null : parseUserInputAnswer(v.answer)
  if (
    answer?.optionIndex !== null &&
    answer?.optionIndex !== undefined &&
    answer.optionIndex >= options.length
  )
    throw new Error('回复选项无效')
  if (
    (status === 'answered' || status === 'skipped') !== (answer !== null) ||
    (answer !== null && answer.skipped !== (status === 'skipped'))
  )
    throw new Error('问题与回复状态不匹配')
  const inputId = id(v.id),
    stepId = id(v.stepId)
  if (inputId !== stepId) throw new Error('问题步骤归属无效')
  return {
    id: inputId,
    conversationId: id(v.conversationId),
    runId: id(v.runId),
    stepId,
    question,
    options,
    status,
    answer,
    createdAt: integer(v.createdAt),
    updatedAt: integer(v.updatedAt),
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
    steps: array(v.steps ?? [], parseStep),
    approvals: array(v.approvals, parseApproval),
    directoryGrants: array(v.directoryGrants ?? [], parseDirectoryGrant),
    userInputs: array(v.userInputs, parseUserInput),
    revision: integer(v.revision),
    warning: v.warning === null ? null : string(v.warning),
    ...(v.history === undefined ? {} : { history: parseHistoryCursor(v.history) }),
  }
}
function parseHistoryCursor(value: unknown): { beforeRunId: string; hasMore: boolean } {
  const v = record(value)
  if (typeof v.hasMore !== 'boolean') throw new Error('历史分页格式无效')
  return { beforeRunId: v.beforeRunId === '' ? '' : id(v.beforeRunId), hasMore: v.hasMore }
}
export function parseConversationHistory(value: unknown): ConversationHistory {
  const v = record(value)
  const cursor = parseHistoryCursor(v)
  const messages = array(v.messages, parseMessage),
    runs = array(v.runs, parseRun)
  if (
    messages.length > 50 ||
    runs.length > 25 ||
    (cursor.hasMore && !runs.length) ||
    cursor.beforeRunId !== (runs[0]?.id ?? '') ||
    runs.some(
      (run, index) =>
        (index > 0 && run.id <= runs[index - 1]!.id) ||
        run.conversationId !== runs[0]?.conversationId,
    ) ||
    messages.some(
      (message, index) =>
        !runs.some(
          (run) => run.id === message.runId && run.conversationId === message.conversationId,
        ) || message.sequence <= (messages[index - 1]?.sequence ?? 0),
    )
  )
    throw new Error('历史分页顺序或归属无效')
  return { messages, runs, ...cursor, revision: integer(v.revision) }
}
export function parseCompactInput(value: unknown): CompactConversationInput {
  const v = record(value)
  if (Object.keys(v).some((key) => key !== 'conversationId' && key !== 'modelId'))
    throw new Error('压缩参数无效')
  return { conversationId: id(v.conversationId), modelId: id(v.modelId) }
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
  if (workspaceId && v.conversationId !== null) throw new Error('已有会话不能在发送时修改项目')
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
export function parseResendInput(value: unknown): ResendMessageInput {
  const v = record(value)
  if (
    Object.keys(v).some((key) => !['conversationId', 'messageId', 'modelId', 'text'].includes(key))
  )
    throw new Error('重发参数无效')
  const text = string(v.text).trim()
  if (!text || text.length > MAX_MESSAGE_LENGTH)
    throw new Error('消息不能为空，且不能超过 100000 个字符')
  return {
    conversationId: id(v.conversationId),
    messageId: id(v.messageId),
    modelId: id(v.modelId),
    text,
  }
}
export function parseResendResult(value: unknown): ResendMessageResult {
  const v = record(value)
  return { ...parseSendResult(v), removedMessageIds: array(v.removedMessageIds, id) }
}
export function parseChatEvent(value: unknown): ChatEvent {
  const v = record(value),
    change = record(v.change)
  const revision = integer(v.revision)
  switch (change.kind) {
    case 'context-usage':
      return { revision, change: { kind: 'context-usage', value: parseContextUsage(change.value) } }
    case 'workspace':
      return { revision, change: { kind: 'workspace', value: parseWorkspace(change.value) } }
    case 'conversation':
      return { revision, change: { kind: 'conversation', value: parseConversation(change.value) } }
    case 'message':
      return { revision, change: { kind: 'message', value: parseMessage(change.value) } }
    case 'messages-removed': {
      const value = record(change.value)
      return {
        revision,
        change: {
          kind: 'messages-removed',
          value: {
            id: id(value.id),
            conversationId: id(value.conversationId),
            messageIds: array(value.messageIds, id),
          },
        },
      }
    }
    case 'run': {
      if (typeof change.persisted !== 'boolean') throw new Error('执行数据无效')
      return {
        revision,
        change: { kind: 'run', value: parseRun(change.value), persisted: change.persisted },
      }
    }
    case 'step':
      return { revision, change: { kind: 'step', value: parseStep(change.value) } }
    case 'approval':
      return { revision, change: { kind: 'approval', value: parseApproval(change.value) } }
    case 'directory-grant':
      return {
        revision,
        change: { kind: 'directory-grant', value: parseDirectoryGrant(change.value) },
      }
    case 'user-input':
      return { revision, change: { kind: 'user-input', value: parseUserInput(change.value) } }
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
