import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { stepFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { parseCompactInput, parseRun } from '../../src/shared/chat.ts'
import type { ChatEvent, ChatMessage, ChatRun, StepDetails } from '../../src/shared/chat.ts'
import {
  compactionOutcome,
  isManualCompactionStep,
  manualCompactionStatus,
  matchesCompactCommand,
  isCompactCommand,
  messageCompactions,
} from '../../src/shared/manual-compaction.ts'
import { seedModel, resourceRoot, supportedBackend } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'

const uuid = (n: number) => `019a4f39-0000-7000-8000-${n.toString().padStart(12, '0')}`
const run = (n: number, status: ChatRun['status'] = 'completed'): ChatRun => ({
  id: uuid(n),
  conversationId: uuid(1),
  status,
  error: null,
  createdAt: n,
  finishedAt: status === 'running' ? null : n + 1,
})

test('压缩命令只匹配独立命令，输入边界拒绝额外字段与无效归属', () => {
  for (const text of ['/', '/c', '/comp', '/compact', ' /COMPACT '])
    assert.equal(matchesCompactCommand(text), true)
  for (const text of [
    '',
    '正文 /compact',
    '/compact 说明',
    '/compact\n另一行',
    '/compact-file',
    '/unknown',
  ])
    assert.equal(matchesCompactCommand(text), false)
  assert.equal(isCompactCommand('/comp'), false)
  assert.equal(isCompactCommand(' /compact '), true)
  assert.deepEqual(parseCompactInput({ conversationId: uuid(1), modelId: uuid(2) }), {
    conversationId: uuid(1),
    modelId: uuid(2),
  })
  for (const value of [
    { conversationId: null, modelId: uuid(2) },
    { conversationId: '../../invalid', modelId: uuid(2) },
    { conversationId: uuid(1), modelId: uuid(2), text: '/compact' },
  ])
    assert.throws(() => parseCompactInput(value))
  assert.throws(() =>
    parseRun({ ...run(2), compaction: { stepId: uuid(3), outcome: 'success', error: null } }),
  )
})

test('压缩状态区分真实完成、无操作、失败与断连，不将受理当成压缩成功', () => {
  const first = stepFromRpc({
    id: uuid(3),
    run_id: uuid(2),
    conversation_id: uuid(1),
    sequence: 1,
    type: 'context_compression',
    parent_step_id: null,
    name: '压缩历史上下文',
    status: 'completed',
    input: { purpose: 'context_compaction', trigger: { type: 'manual' } },
    updated_at: 2,
  })
  assert.equal(isManualCompactionStep(first), true)
  assert.equal(isManualCompactionStep({ ...first, sequence: 2 }), false)
  assert.equal(
    isManualCompactionStep({ ...first, input: first.input.replace('manual', 'automatic') }),
    false,
  )
  assert.equal(isManualCompactionStep({ ...first, input: '{invalid' }), false)
  const details: StepDetails = {
    id: first.id,
    conversationId: first.conversationId,
    runId: first.runId,
    input: first.input,
    inputTruncated: false,
    output: '{"compressed":false,"reason":"no_earlier_complete_turns"}',
    outputTruncated: false,
    text: null,
    textTruncated: false,
  }
  assert.equal(compactionOutcome(details), 'skipped')
  assert.equal(compactionOutcome({ ...details, output: '{"compressed":true}' }), 'compressed')
  assert.equal(compactionOutcome({ ...details, outputTruncated: true }), 'unknown')
  assert.throws(() => compactionOutcome({ ...details, output: '{invalid' }), /压缩结果格式无效/)
  assert.equal(manualCompactionStatus(run(2, 'running'), true, 'unknown', false, '').pending, true)
  assert.equal(
    manualCompactionStatus(run(2, 'running'), false, 'unknown', false, '').pending,
    false,
  )
  assert.match(manualCompactionStatus(run(2), true, 'unknown', false, '').label, /待确认/)
  assert.match(manualCompactionStatus(run(2), true, 'skipped', false, '').label, /暂无可压缩/)
  assert.equal(manualCompactionStatus(run(2), true, 'compressed', false, '').label, '上下文已压缩')
  for (const status of ['failed', 'cancelled', 'interrupted'] as const)
    assert.notEqual(
      manualCompactionStatus(run(2, status), true, 'compressed', false, '').label,
      '上下文已压缩',
    )
})

test('独立压缩记录放在原有消息之后，后续回答不会将旧压缩记录移到末尾', () => {
  const messages: ChatMessage[] = [2, 2, 4, 4].map((n, index) => ({
    id: uuid(10 + index),
    conversationId: uuid(1),
    runId: uuid(n),
    sequence: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    content: [],
    status: 'completed',
    createdAt: null,
    completedAt: null,
  }))
  const compact: ChatRun = {
    ...run(3),
    compaction: { stepId: uuid(9), outcome: 'compressed', error: null },
  }
  const result = messageCompactions(messages, [run(2), compact, run(4)])
  assert.deepEqual(
    result.rows.map((row) => row.compactions.map((item) => item.id)),
    [[], [uuid(3)], [], []],
  )
  assert.equal(messageCompactions(messages.slice(2), [compact]).before.length, 0)
})

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('未收到预期压缩事件')
    await setTimeout(15)
  }
}

test(
  '真实 Go 手动压缩：独立执行、无操作、原消息保留、使用摘要继续与重启恢复',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-manual-compaction-'))
    const fixture = join(profile, 'fixture.txt')
    await writeFile(fixture, 'fixture', { mode: 0o600 })
    const upstream = await startModelServer(fixture).catch(async (error: unknown) => {
      await rm(profile, { recursive: true, force: true })
      throw error
    })
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      const completed = (runId: string) =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === runId &&
            event.change.value.status === 'completed',
        )
      const first = await service.send({
        conversationId: null,
        modelId,
        text: '历史约束 '.repeat(200),
      })
      await until(() => completed(first.runId))
      const noop = await service.compact({ conversationId: first.conversationId, modelId })
      await until(() => completed(noop.runId))
      assert.equal(
        (await service.detail(first.conversationId)).runs.find((row) => row.id === noop.runId)
          ?.compaction?.outcome,
        'skipped',
      )
      assert.equal(
        upstream.requests.some((request) => request.summaryRequest),
        false,
      )
      for (let i = 0; i < 5; i++) {
        const sent = await service.send({
          conversationId: first.conversationId,
          modelId,
          text: `历史第 ${i} 轮 ` + '保留事实与约束。'.repeat(150),
        })
        await until(() => completed(sent.runId))
      }
      const before = (await service.detail(first.conversationId)).messages
      const accepted = await service.compact({ conversationId: first.conversationId, modelId })
      await until(() => completed(accepted.runId))
      const after = await service.detail(first.conversationId)
      assert.deepEqual(after.messages, before)
      assert.equal(
        after.runs.find((row) => row.id === accepted.runId)?.compaction?.outcome,
        'compressed',
      )
      assert.equal(after.runs.filter((row) => row.compaction).length, 2)
      const next = await service.send({
        conversationId: first.conversationId,
        modelId,
        text: '使用压缩后的上下文继续',
      })
      await until(() => completed(next.runId))
      assert.ok(
        upstream.requests.some((request) => request.contextSummary && !request.summaryRequest),
      )
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const restored = await service.detail(first.conversationId)
      assert.equal(
        restored.runs.find((row) => row.id === accepted.runId)?.compaction?.outcome,
        'compressed',
      )
      assert.equal(restored.messages.length, before.length + 2)
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
