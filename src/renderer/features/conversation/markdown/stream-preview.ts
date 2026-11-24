import { sanitizeMarkdown } from './sanitize'

const maxPreviewLength = 8192
const paragraphBreak = /\n(?:[ \t]*\n)+/
const escapedText: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
}

export type MarkdownPart = { html: string } | { text: string }

// 仅接管结构已经明确的纯文本段落，保留 Worker 对其他排版的解释权。
export function markdownPart(html: string): MarkdownPart {
  const text = /^<p>([\s\S]*)<\/p>\n?$/.exec(html)?.[1]?.replaceAll('<br>\n', '\n')
  return text !== undefined && !text.includes('<')
    ? { text: text.replace(/&(?:amp|lt|gt|quot);/g, (entity) => escapedText[entity]!) }
    : { html: sanitizeMarkdown(html) }
}

function plainParagraph(source: string): { text: string; complete: boolean } {
  const lines: string[] = []
  const sourceLines = source.trimEnd().split('\n')
  for (const line of sourceLines) {
    if (
      line.includes('\0') ||
      /^(?: {4}| *\t)|^ {0,3}(?:[#>*+~-]|=+ *$|\d+[.)](?:\s|$))/.test(line)
    )
      return { text: lines.join('\n'), complete: false }
    // 一旦遇到可能改变样式的标记，只预览之前的正文。
    const prefix = /^[^\r&*_[\]<>\\`~|]*/.exec(line)?.[0]?.trim() ?? ''
    if (prefix) lines.push(prefix)
    if (prefix !== line.trim()) return { text: lines.join('\n'), complete: false }
  }
  return { text: lines.join('\n'), complete: true }
}

/** 使用已解析的末段确认源码边界，再把还未排版的普通正文补到同一组段落。 */
export function previewParts(
  parts: MarkdownPart[],
  parsed: string,
  current: string,
): MarkdownPart[] {
  if (parsed === current || !current.startsWith(parsed)) return parts
  const last = parts.at(-1)
  let start = 0
  if (parsed) {
    if (!last || !('text' in last)) return parts
    const end = parsed.trimEnd().length
    const lastSource = parsed
      .slice(Math.max(0, end - maxPreviewLength), end)
      .split(paragraphBreak)
      .at(-1)!
    const tail = plainParagraph(lastSource)
    if (!tail.complete || tail.text !== last.text) return parts
    // 保留尾部空行，让后续文字自然进入下一段。
    start = end - lastSource.length
  }
  const preview = parts.slice(0, last ? -1 : 0)
  // 超过预览范围时保留已经显示的前缀，余下内容由 Worker 接管。
  const end = Math.min(start + maxPreviewLength, current.length)
  const boundary = current.charCodeAt(end)
  const tail = current.slice(start, boundary >= 0xdc00 && boundary <= 0xdfff ? end - 1 : end)
  for (const source of tail.split(paragraphBreak)) {
    const paragraph = plainParagraph(source)
    if (!paragraph.text && paragraph.complete) continue
    if (
      !paragraph.text ||
      (last &&
        preview.length === parts.length - 1 &&
        'text' in last &&
        !paragraph.text.startsWith(last.text))
    )
      break
    preview.push({ text: paragraph.text })
    if (!paragraph.complete) break
  }
  return preview.length >= parts.length ? preview : parts
}
