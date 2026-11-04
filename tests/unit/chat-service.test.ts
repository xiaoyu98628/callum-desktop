import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { isActiveRun } from '../../src/shared/chat.ts'
import type { ChatApproval, ChatEvent } from '../../src/shared/chat.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('未收到预期事件')
    await setTimeout(20)
  }
}

test(
  '真实 Go 服务：流式消息、隔离并行、取消、失败、审批与重启恢复',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-chat-integration-'))
    const file = join(profile, 'fixture.txt')
    await writeFile(file, 'controlled-file', { mode: 0o600 })
    const upstream = await startModelServer(file).catch(async (error: unknown) => {
      await rm(profile, { recursive: true, force: true })
      throw error
    })
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      assert.equal((await service.overview(0)).models[0]?.id, modelId)
      const first = await service.send({ conversationId: null, modelId, text: '你好' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === first.runId &&
            event.change.value.status === 'completed',
        ),
      )
      const detail = await service.detail(first.conversationId)
      assert.equal(detail.messages.length, 2)
      assert.equal(detail.messages[1]?.content[0]?.text, '你好，这是受控回答。')
      assert.ok(
        events.some(
          (event) =>
            event.change.kind === 'message' && event.change.value.content[0]?.text === '你好，',
        ),
      )

      const slow = await service.send({
        conversationId: first.conversationId,
        modelId,
        text: '等待甲',
      })
      const other = await service.send({ conversationId: null, modelId, text: '另一段对话' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === other.runId &&
            event.change.value.status === 'completed',
        ),
      )
      assert.ok(
        (await service.detail(slow.conversationId)).messages.some(
          (message) => message.content[0]?.text === '仅属于等待甲的内容',
        ),
      )
      assert.ok(
        !(await service.detail(other.conversationId)).messages.some((message) =>
          message.content[0]?.text.includes('等待甲'),
        ),
      )
      await service.cancel(slow.runId)
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === slow.runId &&
            event.change.value.status === 'cancelled',
        ),
      )
      assert.ok(!(await service.detail(slow.conversationId)).runs.some(isActiveRun))
      await until(() => upstream.cancelled > 0)

      for (const text of ['失败', '中断']) {
        const failed = await service.send({ conversationId: null, modelId, text })
        await until(() =>
          events.some(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === failed.runId &&
              event.change.value.status === 'failed',
          ),
        )
      }
      const approvalRun = await service.send({ conversationId: null, modelId, text: '需要审批' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'approval' &&
            event.change.value.runId === approvalRun.runId &&
            event.change.value.status === 'pending',
        ),
      )
      const approval = (await service.detail(approvalRun.conversationId)).approvals.find(
        (item) => item.status === 'pending',
      )
      assert.ok(approval)
      assert.ok(approval.snapshot.includes(file))
      assert.equal(approval.toolName, 'read_file')
      await service.decide(approval.id, 'approved')
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === approvalRun.runId &&
            event.change.value.status === 'completed',
        ),
      )
      const final = (await service.detail(approvalRun.conversationId)).messages.at(-1)?.content[0]
        ?.text
      assert.equal(final, '已读取测试文件。', '完整消息应替换工具调用前的文本')
      assert.ok(
        upstream.requests.some(
          (request) => request.lastRole === 'tool' && request.text.includes('controlled-file'),
        ),
      )
      for (const decision of ['rejected', 'cancel'] as const) {
        const run = await service.send({ conversationId: null, modelId, text: `审批-${decision}` })
        await until(() =>
          events.some(
            (event) =>
              event.change.kind === 'approval' &&
              event.change.value.runId === run.runId &&
              event.change.value.status === 'pending',
          ),
        )
        const pending: ChatApproval | undefined = (
          await service.detail(run.conversationId)
        ).approvals.find((item) => item.status === 'pending')
        assert.ok(pending)
        if (decision === 'cancel') await service.cancel(run.runId)
        else await service.decide(pending.id, decision)
        await until(() =>
          events.some(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === run.runId &&
              event.change.value.status === (decision === 'cancel' ? 'cancelled' : 'completed'),
          ),
        )
        if (decision === 'rejected')
          assert.equal(
            (await service.detail(run.conversationId)).messages.at(-1)?.content[0]?.text,
            '操作已拒绝。',
          )
        else
          assert.ok(
            events.some(
              (event) =>
                event.change.kind === 'approval' &&
                event.change.value.id === pending.id &&
                event.change.value.status === 'cancelled',
            ),
          )
      }
      const exiting = await service.send({ conversationId: null, modelId, text: '等待退出' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'message' &&
            event.change.value.runId === exiting.runId &&
            event.change.value.content[0]?.text.includes('等待退出') === true,
        ),
      )
      await service.close()
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const restored = await service.detail(first.conversationId)
      assert.equal(restored.messages.length, 4)
      assert.equal(restored.messages.at(-1)?.status, 'cancelled')
      assert.equal((await service.overview(0)).conversations.length, 8)
      assert.equal((await service.detail(exiting.conversationId)).runs.at(-1)?.status, 'cancelled')
    } finally {
      try {
        await service?.close()
      } finally {
        await upstream.close()
        await rm(profile, { recursive: true, force: true })
      }
    }
  },
)
