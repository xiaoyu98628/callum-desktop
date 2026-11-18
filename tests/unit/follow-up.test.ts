import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFollowUpInput } from '../../src/shared/follow-up.ts'

test('后续消息独立校验处理方式及执行标识，正文与附件继续使用发送边界', () => {
  const conversationId = '019ba300-1234-7890-8000-123456789abc'
  const expectedRunId = '019ba301-1234-7890-8000-123456789abc'
  const input = {
    conversationId,
    expectedRunId,
    mode: 'queue',
    modelId: '019ba302-1234-7890-8000-123456789abc',
    text: ' 后续要求 ',
  }
  const parsed = parseFollowUpInput(input)
  assert.equal(parsed.text, '后续要求')
  assert.equal(parsed.mode, 'queue')
  assert.equal(parsed.expectedRunId, expectedRunId)
  assert.throws(() => parseFollowUpInput({ ...input, expectedRunId: 'invalid' }))
  assert.throws(() => parseFollowUpInput({ ...input, workspaceId: conversationId }))
  assert.throws(() =>
    parseFollowUpInput({ ...input, content: [{ type: 'file', path: '/private' }] }),
  )
})
