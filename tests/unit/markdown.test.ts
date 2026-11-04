import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMarkdown } from '../../src/renderer/features/conversation/markdown/render.ts'
import {
  MAX_MARKDOWN_TEXT,
  validateDocument,
} from '../../src/renderer/features/conversation/markdown/contract.ts'
import { MAX_CODE_LENGTH, parseCodeText, parseWebLink } from '../../src/shared/message-actions.ts'

test('Markdown 排版支持标题、强调、列表、引用、表格和代码高亮', () => {
  const rendered = renderMarkdown([
    '# 标题\n\n**粗体**和 *斜体*、~~删除线~~、`inline`\n\n- 列表\n\n> 引用\n\n| 列一 | 列二 |\n| :--- | ---: |\n| a | b |\n\n```go\npackage main\n```',
  ])
  const html = rendered.html[0] ?? ''
  for (const fragment of [
    '<h1>标题</h1>',
    '<strong>粗体</strong>',
    '<em>斜体</em>',
    '<s>删除线</s>',
    '<code>inline</code>',
    '<ul>',
    '<blockquote>',
    '<table>',
    'markdown-align-right',
    'hljs-keyword',
  ])
    assert.ok(html.includes(fragment), fragment)
  assert.deepEqual(rendered.codes, ['package main\n'])
})

test('未闭合代码块可安全渲染，完整快照替换不重复拼接', () => {
  const partial = renderMarkdown(['```typescript\nconst value = "<tag>"'])
  assert.deepEqual(partial.codes, ['const value = "<tag>"'])
  assert.ok(partial.html[0]?.includes('&lt;tag&gt;'))
  const complete = renderMarkdown([
    '回答完成\n\n```typescript\nconst value = 1\n```',
    '```unknown-language\n<script>literal</script>\n```',
  ])
  assert.equal(complete.codes.length, 2)
  assert.ok(complete.html[0]?.includes('data-copy-code="0"'))
  assert.ok(complete.html[1]?.includes('data-copy-code="1"'))
  assert.ok(!complete.html.join('').includes('&lt;tag&gt;'))
  assert.ok(complete.html[1]?.includes('&lt;script&gt;'))
})

test('模型 HTML、危险链接及图片不会成为可执行或自动加载的内容', () => {
  const html =
    renderMarkdown([
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert(1))\n[本机](file:///etc/passwd)\n[相对](/settings)\n[网页](https://example.com/path)\n\n![说明](https://example.com/image.png)',
    ]).html[0] ?? ''
  assert.doesNotMatch(html, /<(script|img|iframe|style)\b/i)
  assert.doesNotMatch(html, /<a[^>]+href="(javascript|file|data):/i)
  assert.ok(html.includes('href="https://example.com/path"'))
  assert.ok(html.includes('[图片：说明]'))
})

test('排版输入、输出及复制代码均有明确上限', () => {
  assert.throws(() => renderMarkdown(['x'.repeat(MAX_MARKDOWN_TEXT + 1)]), /内容较长/)
  assert.throws(() => validateDocument({ html: ['x'], codes: [1] }))
  assert.throws(() => validateDocument({ html: ['x'.repeat(2 * 1024 * 1024 + 1)], codes: [] }))
  assert.equal(parseCodeText('const a = 1\n'), 'const a = 1\n')
  for (const value of [null, {}, 'x\0y', 'x'.repeat(MAX_CODE_LENGTH + 1)])
    assert.throws(() => parseCodeText(value))
})

test('网页链接校验只接受无凭据的绝对 HTTP/HTTPS 地址', () => {
  assert.equal(
    parseWebLink('https://example.com/中文?q=1#part'),
    'https://example.com/%E4%B8%AD%E6%96%87?q=1#part',
  )
  for (const value of [
    null,
    '',
    'file:///tmp/file',
    'javascript:alert(1)',
    'data:text/html,x',
    'mailto:a@example.com',
    'callum://app/',
    '/relative',
    '//example.com',
    'https://user:pass@example.com',
    'https://example.com/\nfile',
    'https://example.com/a b',
  ])
    assert.throws(() => parseWebLink(value))
})
