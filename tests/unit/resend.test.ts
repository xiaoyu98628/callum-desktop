import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import type { ChatEvent } from '../../src/shared/chat.ts'
import { messageText } from '../../src/shared/message-actions.ts'
import { startModelServer } from '../helpers/model-server.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'

test(
  '真实 Go 重发：替换旧回答、保留审计、拒绝越界与活动执行、重启后历史一致',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-resend-'))
    const file = join(profile, 'fixture.txt')
    await writeFile(file, 'controlled-file')
    const endpoint = await startModelServer(file).catch(async (error: unknown) => {
      await rm(profile, { recursive: true, force: true })
      throw error
    })
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(profile, endpoint.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      const wait = async (runId: string, status = 'completed') => {
        const deadline = Date.now() + 7000
        while (
          !events.some(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === runId &&
              event.change.value.status === status,
          )
        ) {
          if (Date.now() > deadline) throw new Error('执行未结束')
          await setTimeout(20)
        }
      }
      const original = await service.send({ conversationId: null, modelId, text: '只读文件' })
      await wait(original.runId)
      const initial = await service.detail(original.conversationId)
      const user = initial.messages.find((item) => item.role === 'user')!
      const oldAnswer = initial.messages.find((item) => item.role === 'assistant')!
      assert.equal(messageText(oldAnswer.content), '已完成只读检查。')
      const audit = await service.listSteps(original.conversationId, original.runId, 0)
      assert.ok(audit.steps.some((step) => step.type === 'tool_call'))
      const other = await service.send({ conversationId: null, modelId, text: '其他会话' })
      await wait(other.runId)
      await assert.rejects(
        service.resend({
          conversationId: other.conversationId,
          messageId: user.id,
          modelId,
          text: '跨会话错误',
        }),
      )
      await assert.rejects(
        service.resend({
          conversationId: original.conversationId,
          messageId: oldAnswer.id,
          modelId,
          text: '回答不能作为提问',
        }),
      )

      const resent = await service.resend({
        conversationId: original.conversationId,
        messageId: user.id,
        modelId,
        text: '修改后的提问',
      })
      assert.deepEqual(resent.removedMessageIds, [oldAnswer.id])
      await wait(resent.runId)
      const detail = await service.detail(original.conversationId)
      assert.equal(detail.messages.length, 2)
      assert.equal(detail.messages[0]?.id, user.id)
      assert.equal(detail.messages[0]?.sequence, user.sequence)
      assert.equal(messageText(detail.messages[0]!.content), '修改后的提问')
      assert.notEqual(detail.messages[1]?.id, oldAnswer.id)
      assert.equal(detail.messages[1]?.runId, resent.runId)
      assert.equal(messageText(detail.messages[1]!.content), '你好，这是受控回答。')
      assert.ok(
        events.some(
          (event) =>
            event.change.kind === 'messages-removed' &&
            event.change.value.messageIds.includes(oldAnswer.id),
        ),
      )
      assert.deepEqual(
        (await service.listSteps(original.conversationId, original.runId, 0)).steps.map(
          (step) => step.id,
        ),
        audit.steps.map((step) => step.id),
      )
      assert.equal(
        messageText((await service.detail(other.conversationId)).messages[0]!.content),
        '其他会话',
      )

      const next = await service.send({
        conversationId: original.conversationId,
        modelId,
        text: '下一条提问',
      })
      await wait(next.runId)
      await assert.rejects(
        service.resend({
          conversationId: original.conversationId,
          messageId: user.id,
          modelId,
          text: '旧提问',
        }),
      )
      const active = await service.send({
        conversationId: other.conversationId,
        modelId,
        text: '等待甲',
      })
      const activeDetail = await service.detail(other.conversationId)
      await assert.rejects(
        service.resend({
          conversationId: other.conversationId,
          messageId: activeDetail.messages.findLast((item) => item.role === 'user')!.id,
          modelId,
          text: '活动执行不可重发',
        }),
      )
      await service.cancel(active.runId)
      await wait(active.runId, 'cancelled')
      const expected = (await service.detail(original.conversationId)).messages
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      assert.deepEqual((await service.detail(original.conversationId)).messages, expected)
      assert.ok(!expected.some((item) => item.id === oldAnswer.id))
    } finally {
      await service?.close()
      await endpoint.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)
