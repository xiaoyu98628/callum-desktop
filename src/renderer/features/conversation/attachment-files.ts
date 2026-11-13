import {
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from '../../../shared/attachments.ts'
import type { AttachmentInput, AttachmentPreviewInput } from '../../../shared/attachments.ts'

export interface AttachmentItem {
  /** 历史图片包含执行版本，编辑重发后不能复用旧消息同索引的预览。 */
  key?: string
  label: string
  source: File | AttachmentPreviewInput
  kind?: 'image' | 'file'
  size?: number
}

export function isImageFile(file: File): boolean {
  return (
    /^image\/(png|jpeg|gif|webp)$/.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name)
  )
}

export function isImageAttachment(item: AttachmentItem): boolean {
  return item.kind === undefined
    ? !(item.source instanceof File) || isImageFile(item.source)
    : item.kind === 'image'
}

/** 浏览器只交付用户选中的文件。实际格式由 Go 读取并验证。 */
export function addAttachmentFiles(current: File[], files: File[], retained = 0): File[] {
  const combined = [...current, ...files]
  if (combined.length + retained > MAX_ATTACHMENTS) throw new Error('一条消息最多添加 8 个附件。')
  if (
    combined.some(
      (file) => (isImageFile(file) && file.size === 0) || file.size > MAX_ATTACHMENT_BYTES,
    )
  )
    throw new Error('单个附件应在 16 MiB 以内，图片不能为空。')
  if (combined.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BATCH_BYTES)
    throw new Error('一条消息的附件合计最多 32 MiB。')
  return combined
}

export async function attachmentInputs(files: File[]): Promise<AttachmentInput[]> {
  const result: AttachmentInput[] = []
  // 顺序读取有界批次，文件不再可读时保留草稿供用户处理。
  for (const file of files) {
    try {
      result.push({
        bytes: new Uint8Array(await file.arrayBuffer()),
        name: file.name || 'attachment',
        kind: isImageFile(file) ? 'image' : 'file',
      })
    } catch {
      throw new Error(`无法读取“${file.name}”，请重新添加。`)
    }
  }
  return result
}

export function dropFiles(event: DragEvent, receive: (files: File[]) => void): void {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  receive(Array.from(event.dataTransfer.files))
}

export function dragFiles(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
}

export function pasteFiles(event: ClipboardEvent, receive: (files: File[]) => void): void {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  receive(files)
}
