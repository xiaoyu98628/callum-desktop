import MarkdownIt from 'markdown-it/browser'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import go from 'highlight.js/lib/languages/go'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import java from 'highlight.js/lib/languages/java'
import { parseWebLink } from '../../../../shared/message-actions.ts'
import { validateDocument, validateTexts } from './contract.ts'
import type { MarkdownDocument } from './contract.ts'
import { MAX_MARKDOWN_PARTS } from './contract.ts'

// Worker 内仅缓存高亮结果，既不保存整段对话，也不改变后置引用定义的解析语义。
const highlights = new Map<string, string>()
let highlightSize = 0
function highlight(code: string, language: string): string {
  const key = `${language}\0${code}`
  const cached = highlights.get(key)
  if (cached !== undefined) {
    highlights.delete(key)
    highlights.set(key, cached)
    return cached
  }
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value
  const size = key.length + html.length
  if (size <= 512 * 1024) {
    highlights.set(key, html)
    highlightSize += size
    while (highlightSize > 512 * 1024 || highlights.size > 64) {
      const oldest = highlights.entries().next().value
      if (!oldest) break
      highlightSize -= oldest[0].length + oldest[1].length
      highlights.delete(oldest[0])
    }
  }
  return html
}

for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  go,
  json,
  python,
  bash,
  xml,
  css,
  sql,
  java,
}))
  hljs.registerLanguage(name, grammar)

/** 完整解析保证列表、表格和后置引用正确，按顶层节点输出以避免整体替换 DOM。 */
export function renderMarkdown(texts: string[]): MarkdownDocument {
  const content = validateTexts(texts)
  const codes: string[] = []
  const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, maxNesting: 20 })
  markdown.validateLink = (href) => {
    try {
      parseWebLink(href)
      return true
    } catch {
      return false
    }
  }
  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    if (!token || codes.length >= 1024) throw new Error('代码块过多，已按文本显示。')
    const language = token.info.trim().split(/\s+/)[0] || 'text'
    const label = /^[\w.+-]{1,32}$/.test(language) ? language : 'text'
    const code = token.content
    const number = codes.push(code) - 1
    let highlighted = markdown.utils.escapeHtml(code)
    if (code.length <= 20_000 && hljs.getLanguage(label)) {
      try {
        highlighted = highlight(code, label)
      } catch {
        /* 未完成代码或语法异常时保留转义文本，不影响回答正文。 */
      }
    }
    return `<section class="markdown-code-block"><div class="markdown-code-header"><span>${markdown.utils.escapeHtml(label)}</span><button type="button" data-copy-code="${number}" aria-label="复制代码">复制</button></div><pre tabindex="0"><code class="hljs">${highlighted}</code></pre></section>\n`
  }
  markdown.renderer.rules.table_open = () => '<div class="markdown-table-wrap" tabindex="0"><table>'
  markdown.renderer.rules.table_close = () => '</table></div>\n'
  for (const tag of ['th', 'td'])
    markdown.renderer.rules[`${tag}_open`] = (tokens, index) => {
      const rawStyle = tokens[index]?.attrGet('style')
      const style = typeof rawStyle === 'string' ? rawStyle : ''
      const alignment = /text-align:(left|center|right)/.exec(style)?.[1] ?? 'left'
      return `<${tag} class="markdown-align-${alignment}">`
    }
  // 图片仅作为经过校验的链接展示，不触发远端请求或读取本机资源。
  markdown.renderer.rules.image = (tokens, index) => {
    const token = tokens[index]
    const label = markdown.utils.escapeHtml(token?.content || '图片')
    try {
      const href = parseWebLink(token?.attrGet('src'))
      return `<a href="${markdown.utils.escapeHtml(href)}">[图片：${label}]</a>`
    } catch {
      return `[图片：${label}]`
    }
  }
  let count = 0
  const html = content.map((text) => {
    // parse 已完成整篇文档的 block/inline 处理，不能按空行切 Markdown 源码。
    const environment = {}
    const tokens = markdown.parse(text, environment)
    const parts: string[] = []
    let start = 0
    let depth = 0
    for (let index = 0; index < tokens.length; index++) {
      depth += tokens[index]?.nesting ?? 0
      if (depth !== 0) continue
      if (++count > MAX_MARKDOWN_PARTS) throw new Error('排版段落较多，已按文本显示。')
      parts.push(
        markdown.renderer.render(tokens.slice(start, index + 1), markdown.options, environment),
      )
      start = index + 1
    }
    return parts
  })
  return validateDocument({ html, codes })
}
