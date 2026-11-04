export const MARKDOWN_START =
  '# Markdown 示例\n\n这段回答支持 **粗体**、*斜体*、~~删除线~~ 与 `inline code`。\n\n- 第一项\n- 第二项\n\n> 引用内容会独立排版。\n\n```typescript\nconst message = "<Callum>";\n'
export const MARKDOWN_END =
  'console.log(message);\n```\n\n## 参数表\n\n| 参数 | 说明 |\n| :--- | :--- |\n| model | 使用配置的模型 |\n| stream | 持续接收回答 |\n\n[项目文档](https://example.com/docs?source=callum)\n\n```unknown-language\n<b>原样代码</b>\n```\n\n回答已经完成。'
export const MARKDOWN_CODE = 'const message = "<Callum>";\nconsole.log(message);\n'
export const MARKDOWN_UNSAFE =
  '# 安全展示\n\n<script>window.markdownExecuted = true</script>\n<img src="https://example.invalid/tracker" onerror="window.markdownExecuted=true">\n<iframe src="https://example.invalid/frame"></iframe>\n\n[脚本](javascript:alert(1))\n[本机文件](file:///etc/passwd)\n[系统应用](mailto:test@example.com)\n![远程图片](https://example.invalid/image.png)\n\n[网页](https://example.com/safe)\n\n```html\n<img src=x onerror=alert(1)>\n```'
