import {
  array,
  id,
  integer,
  parseApproval,
  parseConversation,
  parseMessage,
  parseRun,
  record,
  string,
} from '../../shared/chat.ts'
import type { ChatApproval, ChatMessage, ChatRun, Conversation } from '../../shared/chat.ts'

export function conversationFromRpc(value: unknown): Conversation {
  const v = record(value),
    model = record(v.model)
  return parseConversation({
    id: v.id,
    title: v.title,
    modelId: model.id,
    modelName: model.display_name,
    updatedAt: v.updated_at,
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
