export const MARKDOWN_CODE_START =
  'const message = "<Callum>";\n' +
  `const endpoint = "https://example.com/${'long-path-segment/'.repeat(16)}";\n`
export const MARKDOWN_START = [
  '# Markdown 示例',
  '',
  '这段回答支持 **粗体**、*斜体*、~~删除线~~ 与 `inline code`。',
  '',
  '正文、列表和代码使用一致的阅读节奏，长回答也能保持清晰的层次。',
  '',
  '- 第一项',
  '  - 嵌套内容保持自然缩进',
  '  - 较长的列表文字会在正文宽度内自动换行，不挤压旁边的编号或符号。',
  '- 第二项',
  '',
  '> 引用内容会独立排版。',
  '>',
  '> 边线与文字保持适当距离。',
  '',
  '```typescript',
  MARKDOWN_CODE_START,
].join('\n')
export const MARKDOWN_END = [
  'console.log(message);',
  '```',
  '',
  '## 参数表',
  '',
  '| 参数 | 说明 | 默认值 |',
  '| :--- | :--- | ---: |',
  '| model | 使用配置的模型 | — |',
  '| stream | 持续接收回答 | true |',
  `| endpoint | \`https://example.com/${'table-path/'.repeat(12)}\` | — |`,
  '',
  '[项目文档](https://example.com/docs?source=callum)',
  '',
  '```unknown-language',
  '<b>原样代码</b>',
  '```',
  '',
  '回答已经完成。',
].join('\n')
export const MARKDOWN_CODE = MARKDOWN_CODE_START + 'console.log(message);\n'
export const MARKDOWN_UNSAFE =
  '# 安全展示\n\n<script>window.markdownExecuted = true</script>\n<img src="https://example.invalid/tracker" onerror="window.markdownExecuted=true">\n<iframe src="https://example.invalid/frame"></iframe>\n\n[脚本](javascript:alert(1))\n[本机文件](file:///etc/passwd)\n[系统应用](mailto:test@example.com)\n![远程图片](https://example.invalid/image.png)\n\n[网页](https://example.com/safe)\n\n```html\n<img src=x onerror=alert(1)>\n```'
