import { array, id, integer, record, string } from './validation.ts'

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
export const MAX_ATTACHMENT_BATCH_BYTES = 32 * 1024 * 1024
export const MAX_ATTACHMENTS = 8
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp'
const types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface AttachmentInput {
  bytes: Uint8Array
  name?: string
  kind?: 'image' | 'file'
}
export interface AttachmentPreviewInput {
  conversationId: string
  messageId: string
  index: number
}
export interface AttachmentPreview {
  mime: (typeof types)[number]
  data: string
}

export function parseAttachments(value: unknown): AttachmentInput[] {
  const attachments = array(value, (item): AttachmentInput => {
    const input = record(item)
    if (
      Object.keys(input).some((key) => !['bytes', 'name', 'kind'].includes(key)) ||
      !(input.bytes instanceof Uint8Array)
    )
      throw new Error('附件数据无效')
    if (input.kind !== undefined && input.kind !== 'image' && input.kind !== 'file')
      throw new Error('附件类型无效')
    const name = input.name === undefined ? undefined : string(input.name)
    if (
      name !== undefined &&
      (!name || name.length > 1024 || /[\p{Cc}/\\]/u.test(name) || name === '.' || name === '..')
    )
      throw new Error('附件名称无效')
    if (
      (input.bytes.byteLength === 0 && input.kind !== 'file') ||
      input.bytes.byteLength > MAX_ATTACHMENT_BYTES
    )
      throw new Error('图片不能为空；单个附件不能超过 16 MiB')
    return {
      bytes: input.bytes,
      ...(name === undefined ? {} : { name }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    }
  })
  if (
    attachments.length > MAX_ATTACHMENTS ||
    attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0) > MAX_ATTACHMENT_BATCH_BYTES
  )
    throw new Error('一条消息最多添加 8 个附件，合计最多 32 MiB')
  return attachments
}

export function parseAttachmentPreviewInput(value: unknown): AttachmentPreviewInput {
  const v = record(value)
  const index = integer(v.index)
  if (Object.keys(v).length !== 3 || index >= 64) throw new Error('图片位置无效')
  return { conversationId: id(v.conversationId), messageId: id(v.messageId), index }
}

export function parseAttachmentPreview(value: unknown): AttachmentPreview {
  const v = record(value)
  const mime = types.find((type) => type === v.mime)
  const data = string(v.data)
  if (
    !mime ||
    !data ||
    data.length > Math.ceil((4 * 1024 * 1024) / 3) * 4 ||
    /[^A-Za-z0-9+/=]/.test(data)
  )
    throw new Error('图片预览格式无效')
  return { mime, data }
}
