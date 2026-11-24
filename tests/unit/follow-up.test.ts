import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { runFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { RpcError } from '../../src/main/backend/rpc-client.ts'
import type { ChatChange } from '../../src/shared/chat.ts'
import { parseFollowUpInput } from '../../src/shared/follow-up.ts'
import type { FollowUpItem, FollowUpStart } from '../../src/shared/follow-up.ts'

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

const run = runFromRpc({
  id: '019ba301-1234-7890-8000-123456789abc',
  conversation_id: '019ba300-1234-7890-8000-123456789abc',
  status: 'completed',
  created_at: 1000,
  finished_at: 2000,
})
const queueId = '019ba303-1234-7890-8000-123456789abc'

for (const scenario of [
  {
    name: '队首冲突后允许同一条消息的新版本自动续发',
    revisions: [1, 2],
    accepted: 2,
    attempts: [1, 2],
    refresh: false,
  },
  {
    name: '队首未变化时只提交一次并刷新队列',
    revisions: [1, 1],
    accepted: null,
    attempts: [1],
    refresh: true,
  },
  {
    name: '队首版本持续变化时最多尝试 32 次',
    revisions: Array.from({ length: 32 }, (_, index) => index + 1),
    accepted: null,
    attempts: Array.from({ length: 32 }, (_, index) => index + 1),
    refresh: true,
  },
]) {
  test(scenario.name, async () => {
    const attempts: { input: FollowUpStart; afterRunId: string }[] = []
    const changes: ChatChange[] = []
    let reads = 0
    const service = {
      ready: Promise.resolve(),
      async followUps(conversationId: string): Promise<FollowUpItem[]> {
        assert.equal(conversationId, run.conversationId)
        const revision = scenario.revisions[reads++]
        assert.ok(revision)
        return [
          { id: queueId, conversationId, state: 'queued', revision, text: '', attachments: [] },
        ]
      },
      async startFollowUp(input: FollowUpStart, afterRunId: string) {
        attempts.push({ input, afterRunId })
        if (input.revision !== scenario.accepted) throw new RpcError(1003, '后续消息已变化')
        return { conversationId: run.conversationId, runId: '019ba304-1234-7890-8000-123456789abc' }
      },
      events: {
        publish(change: ChatChange) {
          changes.push(change)
        },
      },
    }
    await ChatService.prototype['dispatchFollowUp'].call(service, run)
    assert.equal(reads, scenario.revisions.length)
    assert.deepEqual(
      attempts,
      scenario.attempts.map((revision) => ({
        input: { id: queueId, conversationId: run.conversationId, revision },
        afterRunId: run.id,
      })),
    )
    assert.deepEqual(
      changes,
      scenario.refresh
        ? [
            {
              kind: 'follow-ups',
              value: { id: run.conversationId, conversationId: run.conversationId },
            },
          ]
        : [],
    )
  })
}
