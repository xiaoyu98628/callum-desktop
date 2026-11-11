import { array, id, integer, record, string } from './validation.ts'

export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
export const MAX_ATTACHMENT_BATCH_BYTES = 32 * 1024 * 1024
export const MAX_ATTACHMENTS = 8
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp'
const types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface AttachmentInput {
  bytes: Uint8Array
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
  const attachments = array(value, (item) => {
    const input = record(item)
    if (Object.keys(input).length !== 1 || !(input.bytes instanceof Uint8Array))
      throw new Error('附件数据无效')
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new Error('图片为空或超过 16 MiB')
    return { bytes: input.bytes }
  })
  if (
    attachments.length > MAX_ATTACHMENTS ||
    attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0) > MAX_ATTACHMENT_BATCH_BYTES
  )
    throw new Error('一条消息最多添加 8 张图片，原图合计最多 32 MiB')
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
