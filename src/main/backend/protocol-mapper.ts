import { truncateStepText } from '../../shared/steps.ts'
import {
  array,
  id,
  integer,
  parseApproval,
  parseDirectoryGrant,
  parseConversation,
  parseMessage,
  parseRun,
  parseStep,
  parseWorkspace,
  parseUserInput,
  record,
  string,
} from '../../shared/chat.ts'
import type {
  ChatApproval,
  DirectoryGrant,
  ChatMessage,
  ChatRun,
  ChatStep,
  ChatUserInput,
  Conversation,
  Workspace,
} from '../../shared/chat.ts'

export function userInputFromRpc(value: unknown): ChatUserInput {
  const v = record(value)
  const answer = v.answer === null ? null : record(v.answer)
  return parseUserInput({
    id: v.id,
    conversationId: v.conversation_id,
    runId: v.run_id,
    stepId: v.step_id,
    question: v.question,
    options: v.options,
    status: v.status,
    answer:
      answer === null
        ? null
        : { optionIndex: answer.option_index, text: answer.text, skipped: answer.skipped },
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  })
}
export function conversationFromRpc(value: unknown): Conversation {
  const v = record(value),
    model = record(v.model)
  return parseConversation({
    id: v.id,
    workspaceId: v.workspace_id ?? null,
    title: v.title,
    modelId: model.id,
    modelName: model.display_name,
    updatedAt: v.updated_at,
    deletedAt: v.deleted_at ?? null,
    archivedAt: v.archived_at ?? null,
  })
}
export function workspaceFromRpc(value: unknown): Workspace {
  const v = record(value)
  return parseWorkspace({
    id: v.id,
    name: v.name,
    rootPath: v.root_path,
    updatedAt: v.updated_at,
    deletedAt: v.deleted_at ?? null,
    archivedAt: v.archived_at ?? null,
  })
}
export function messageFromRpc(value: unknown): ChatMessage {
  const v = record(value)
  return parseMessage({
    id: v.id,
    conversationId: v.conversation_id,
    runId: v.run_id,
    sequence: v.sequence,
    role: v.role,
    status: v.status,
    content: array(v.content ?? [], (item) => {
      const b = record(item)
      return {
        type: string(b.type),
        text: b.text === undefined ? '' : string(b.text),
        path: b.path === undefined ? '' : string(b.path),
      }
    }),
  })
}
export function runFromRpc(value: unknown): ChatRun {
  const v = record(value)
  return parseRun({
    id: v.id,
    conversationId: v.conversation_id,
    status: v.status,
    error: v.error_message ?? null,
    createdAt: v.created_at,
    finishedAt: v.finished_at ?? null,
  })
}
export function approvalFromRpc(value: unknown, conversationId: string): ChatApproval {
  const v = record(value),
    request = record(v.request)
  const tool = request.tool === undefined ? null : record(request.tool)
  return parseApproval({
    id: v.id,
    conversationId,
    runId: v.run_id,
    status: v.status,
    toolName: tool ? string(tool.name) : '工具操作',
    snapshot: JSON.stringify(request, null, 2),
    directoryScope:
      v.directory_scope == null
        ? null
        : {
            rootPath: record(v.directory_scope).root_path,
            access: record(v.directory_scope).access,
          },
  })
}
export function directoryGrantFromRpc(value: unknown): DirectoryGrant {
  const v = record(value),
    scope = record(v.scope)
  return parseDirectoryGrant({
    id: v.id,
    conversationId: v.conversation_id,
    approvalId: v.approval_id,
    scope: { rootPath: scope.root_path, access: scope.access },
    createdAt: v.created_at,
    revokedAt: v.revoked_at,
  })
}
export function appendDelta(message: ChatMessage, params: Record<string, unknown>): ChatMessage {
  if (id(params.conversation_id) !== message.conversationId || id(params.run_id) !== message.runId)
    throw new Error('消息归属不匹配')
  const index = integer(params.block_index),
    delta = record(params.delta)
  if (index > 499 || delta.type !== 'text') throw new Error('不支持的消息增量')
  const content = message.content.map((block) => ({ ...block }))
  if (index > content.length) throw new Error('消息块不连续')
  content[index] ??= { type: 'text', text: '', path: '' }
  const block = content[index]
  if (!block || block.type !== 'text') throw new Error('消息块类型不匹配')
  block.text += string(delta.text)
  if (Buffer.byteLength(content.map((item) => item.text).join('')) > 1024 * 1024)
    throw new Error('回答内容超出限制')
  return { ...message, content }
}

export function stepFromRpc(value: unknown): ChatStep {
  const v = record(value)
  const input = v.input == null ? {} : record(v.input)
  const rawInput = JSON.stringify(input, null, 2)
  return parseStep({
    id: v.id,
    conversationId: v.conversation_id,
    runId: v.run_id,
    parentStepId: v.parent_step_id ?? null,
    sequence: v.sequence,
    type: v.type,
    name: v.name,
    purpose:
      typeof input.purpose === 'string'
        ? input.purpose
        : v.type === 'model_call' && v.parent_step_id == null
          ? 'answer'
          : '',
    status: v.status,
    input: truncateStepText(rawInput, 128 * 1024),
    inputTruncated: rawInput.length > 128 * 1024,
    error: v.error_message ?? null,
    startedAt: v.started_at ?? null,
    finishedAt: v.finished_at ?? null,
    updatedAt: v.updated_at,
    text: '',
    commentary: false,
    textTruncated: false,
    output: '',
    outputTruncated: false,
    outputSequence: 0,
  })
}
