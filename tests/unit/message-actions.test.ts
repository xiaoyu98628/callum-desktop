import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_MESSAGE_COPY_LENGTH,
  messageText,
  parseMessageText,
} from '../../src/shared/message-actions.ts'

test('整条消息复制保留正文、空白和 Markdown，不加入图片路径或过程说明', () => {
  const markdown = '# 标题\n\n```go\npackage main\n```\n'
  assert.equal(
    messageText([
      { type: 'text', text: markdown, path: '' },
      { type: 'image', text: '', path: '/private/picture.png' },
      { type: 'text', text: '第二段。', path: '' },
    ]),
    markdown + '\n\n第二段。',
  )
  assert.equal(parseMessageText('  提问\n第二行  '), '  提问\n第二行  ')
  assert.equal(messageText([]), '')
})

test('消息复制拒绝非文本、空值、NUL 及超长内容，不截断正文', () => {
  for (const value of [null, {}, 1, '', 'x\0y', 'x'.repeat(MAX_MESSAGE_COPY_LENGTH + 1)])
    assert.throws(() => parseMessageText(value))
  const long = '中'.repeat(100_001)
  assert.equal(parseMessageText(long), long)
})
