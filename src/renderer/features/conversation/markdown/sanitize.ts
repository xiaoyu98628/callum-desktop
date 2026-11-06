import DOMPurify from 'dompurify'

/** 只允许排版需要的 HTML；模型内容不能创建图片、表单、样式、脚本或系统协议链接。 */
export function sanitizeMarkdown(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'em',
      's',
      'blockquote',
      'ul',
      'ol',
      'li',
      'pre',
      'code',
      'span',
      'section',
      'div',
      'button',
      'a',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ],
    ALLOWED_ATTR: [
      'href',
      'title',
      'class',
      'type',
      'data-copy-code',
      'aria-label',
      'tabindex',
      'start',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // 这两个字段是渲染器生成的普通值，不能按 URL 正则过滤；仍限制为显式属性清单。
    ADD_URI_SAFE_ATTR: ['data-copy-code', 'aria-label'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    SANITIZE_NAMED_PROPS: true,
  })
}
