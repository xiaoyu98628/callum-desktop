import { MAX_MESSAGE_LENGTH, parseSendInput } from './chat.ts'
import type { SendMessageInput } from './chat.ts'
import { array, id, integer, record, string } from './validation.ts'

export type FollowUpMode = 'queue' | 'steer'

export interface FollowUpItem {
  id: string
  conversationId: string
  state: 'queued' | 'draft' | 'steering' | 'applied' | 'sent' | 'removed'
  revision: number
  text: string
  attachments: string[]
  skill?: string
  retained?: { index: number; name: string; kind: 'file' | 'image'; size?: number }[]
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
  action:
    | 'steer'
    | 'remove'
    | 'edit'
    | 'up'
    | 'down'
    | 'withdraw'
    | 'restore_draft'
    | 'queue_draft'
    | 'steer_draft'
  expectedRunId?: string
  text?: string
  modelId?: string
}

export interface FollowUpStart {
  conversationId: string
  id: string
  revision: number
  text?: string
  modelId?: string
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
  const text = item.text === undefined ? undefined : string(item.text)
  if (
    (text !== undefined && text.length > MAX_MESSAGE_LENGTH) ||
    (text === undefined && item.modelId !== undefined)
  )
    throw new Error('后续消息正文或模型无效')
  return {
    id: id(item.id),
    conversationId: id(item.conversationId),
    revision: integer(item.revision, 1),
    ...(text === undefined ? {} : { text }),
    ...(item.modelId === undefined ? {} : { modelId: id(item.modelId) }),
  }
}

export function parseFollowUpChange(value: unknown): FollowUpChange {
  const item = record(value)
  switch (item.action) {
    case 'edit':
    case 'queue_draft':
    case 'steer_draft': {
      const text = string(item.text)
      if (text.length > MAX_MESSAGE_LENGTH) throw new Error('后续消息过长')
      return {
        ...parseFollowUpStart(item),
        action: item.action,
        text,
        ...(item.action === 'edit' ? {} : { expectedRunId: id(item.expectedRunId) }),
      }
    }
    case 'restore_draft':
      return {
        ...parseFollowUpStart(item),
        action: item.action,
        ...(item.expectedRunId === undefined ? {} : { expectedRunId: id(item.expectedRunId) }),
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
    case 'withdraw':
      return { ...parseFollowUpStart(item), action: item.action }
    default:
      throw new Error('后续消息操作无效')
  }
}

export function parseFollowUpItem(value: unknown): FollowUpItem {
  const item = record(value)
  if (
    item.state !== 'queued' &&
    item.state !== 'draft' &&
    item.state !== 'steering' &&
    item.state !== 'applied' &&
    item.state !== 'sent' &&
    item.state !== 'removed'
  )
    throw new Error('后续消息状态无效')
  return {
    ...parseFollowUpStart({
      id: item.id,
      conversationId: item.conversationId,
      revision: item.revision,
    }),
    state: item.state,
    text: string(item.text),
    attachments: array(item.attachments, string),
    ...(item.skill === undefined ? {} : { skill: string(item.skill) }),
    ...(item.retained === undefined
      ? {}
      : {
          retained: array(item.retained, (value) => {
            const attachment = record(value)
            if (attachment.kind !== 'image' && attachment.kind !== 'file')
              throw new Error('附件类型无效')
            return {
              kind: attachment.kind,
              index: integer(attachment.index),
              name: string(attachment.name),
              ...(attachment.size === undefined ? {} : { size: integer(attachment.size) }),
            }
          }),
        }),
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
    ...(item.status !== 'draft'
      ? {}
      : {
          retained: blocks.flatMap((block, index) =>
            block.type === 'file' || block.type === 'image'
              ? [{ index, kind: block.type, name: block.name ?? '附件', size: block.size }]
              : [],
          ),
        }),
  })
}
