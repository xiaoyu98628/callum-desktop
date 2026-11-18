import { MAX_MESSAGE_LENGTH, parseSendInput } from './chat.ts'
import type { SendMessageInput } from './chat.ts'
import { array, id, integer, record, string } from './validation.ts'

export type FollowUpMode = 'queue' | 'steer'

export interface FollowUpItem {
  id: string
  conversationId: string
  state: 'queued' | 'steering' | 'applied' | 'sent' | 'removed'
  revision: number
  text: string
  attachments: string[]
  skill?: string
}

export interface FollowUpInput extends SendMessageInput {
  conversationId: string
  expectedRunId: string
  mode: FollowUpMode
}

export interface FollowUpChange {
  conversationId: string
  id: string
  revision: number
  action: 'steer' | 'remove' | 'edit' | 'up' | 'down'
  expectedRunId?: string
  text?: string
}

export interface FollowUpStart {
  conversationId: string
  id: string
  revision: number
}

export function parseFollowUpInput(value: unknown): FollowUpInput {
  const { mode, expectedRunId, ...message } = record(value)
  if (mode !== 'queue' && mode !== 'steer') throw new Error('后续消息处理方式无效')
  return {
    ...parseSendInput(message),
    conversationId: id(message.conversationId),
    expectedRunId: id(expectedRunId),
    mode,
  }
}

export function parseFollowUpStart(value: unknown): FollowUpStart {
  const item = record(value)
  return {
    id: id(item.id),
    conversationId: id(item.conversationId),
    revision: integer(item.revision, 1),
  }
}

export function parseFollowUpChange(value: unknown): FollowUpChange {
  const item = record(value)
  switch (item.action) {
    case 'edit': {
      const text = string(item.text)
      if (text.length > MAX_MESSAGE_LENGTH) throw new Error('后续消息过长')
      return { ...parseFollowUpStart(item), action: item.action, text }
    }
    case 'steer':
      return {
        ...parseFollowUpStart(item),
        action: item.action,
        expectedRunId: id(item.expectedRunId),
      }
    case 'remove':
    case 'up':
    case 'down':
      return { ...parseFollowUpStart(item), action: item.action }
    default:
      throw new Error('后续消息操作无效')
  }
}

export function parseFollowUpItem(value: unknown): FollowUpItem {
  const item = record(value)
  if (
    item.state !== 'queued' &&
    item.state !== 'steering' &&
    item.state !== 'applied' &&
    item.state !== 'sent' &&
    item.state !== 'removed'
  )
    throw new Error('后续消息状态无效')
  return {
    ...parseFollowUpStart(item),
    state: item.state,
    text: string(item.text),
    attachments: array(item.attachments, string),
    ...(item.skill === undefined ? {} : { skill: string(item.skill) }),
  }
}

export function followUpFromRpc(value: unknown): FollowUpItem {
  const item = record(value)
  const blocks = array(item.content, record)
  return parseFollowUpItem({
    id: item.id,
    conversationId: item.conversation_id,
    state: item.status,
    revision: item.revision,
    text: blocks
      .filter((block) => block.type === 'text')
      .map((block) => string(block.text))
      .join(''),
    attachments: blocks
      .filter((block) => block.type === 'file' || block.type === 'image')
      .map((block) => string(block.name ?? '附件')),
    skill: blocks.find((block) => block.type === 'skill')?.name,
  })
}
