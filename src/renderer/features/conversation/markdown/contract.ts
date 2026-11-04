export const MAX_MARKDOWN_TEXT = 256 * 1024
export const MAX_MARKDOWN_HTML = 2 * 1024 * 1024
export const MAX_MARKDOWN_BLOCKS = 500
export interface MarkdownDocument {
  html: string[]
  codes: string[]
}
export interface MarkdownRequest {
  id: number
  revision: number
  texts: string[]
}
export type MarkdownReply =
  | { id: number; revision: number; document: MarkdownDocument }
  | { id: number; revision: number; error: string }

export function validateTexts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MARKDOWN_BLOCKS)
    throw new Error('消息内容无法排版，已按文本显示。')
  let length = 0
  const texts: string[] = []
  for (const text of value) {
    if (typeof text !== 'string') throw new Error('消息内容无法排版，已按文本显示。')
    length += text.length
    if (length > MAX_MARKDOWN_TEXT) throw new Error('内容较长，已按文本显示。')
    texts.push(text)
  }
  return texts
}
export function validateDocument(value: unknown): MarkdownDocument {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('html' in value) ||
    !('codes' in value) ||
    !Array.isArray(value.html) ||
    !Array.isArray(value.codes) ||
    value.html.length > MAX_MARKDOWN_BLOCKS ||
    value.codes.length > 1024
  )
    throw new Error('消息排版失败，已按文本显示。')
  let length = 0
  const html: string[] = [],
    codes: string[] = []
  for (const item of value.html) {
    if (typeof item !== 'string') throw new Error('消息排版失败，已按文本显示。')
    length += item.length
    html.push(item)
  }
  if (length > MAX_MARKDOWN_HTML) throw new Error('排版内容较长，已按文本显示。')
  length = 0
  for (const item of value.codes) {
    if (typeof item !== 'string') throw new Error('消息排版失败，已按文本显示。')
    length += item.length
    codes.push(item)
  }
  if (length > MAX_MARKDOWN_TEXT) throw new Error('代码内容较长，已按文本显示。')
  return { html, codes }
}
