import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConversationHistoryReader } from '../../src/main/backend/conversation-history.ts'
import { boundMessages } from '../../src/renderer/features/conversation/state-utils.ts'
import { parseConversationHistory } from '../../src/shared/chat.ts'
import { messageCompactions } from '../../src/shared/manual-compaction.ts'
import { boundSteps } from '../../src/shared/steps.ts'
import { stepFromRpc } from '../../src/main/backend/protocol-mapper.ts'

const id = (n: number) => `019a4f39-0000-7000-8000-${String(n).padStart(12, '0')}`
const run = (n: number, stream = true) => ({
  id: id(n),
  conversation_id: id(1),
  stream,
  status: 'completed',
  created_at: n,
  finished_at: n + 1,
})
const message = (n: number, sequence: number) => ({
  id: id(1000 + sequence),
  conversation_id: id(1),
  run_id: id(n),
  sequence,
  role: sequence % 2 ? 'user' : 'assistant',
  content: [],
  status: 'completed',
})

test('历史消息与执行使用同一页；超过 200 轮仍能回读原执行，后续压缩不混入历史页', async () => {
  const requests: unknown[] = []
  const reader = new ConversationHistoryReader(
    async (method, params) => {
      requests.push({ method, params })
      assert.equal(method, 'conversation.history')
      return {
        messages: [message(2, 1), message(2, 2)],
        runs: [run(2)],
        before_run_id: id(2),
        has_more: false,
      }
    },
    () => undefined,
    () => undefined,
  )
  const page = await reader.page(id(1), id(205))
  assert.equal(page.runs[0]?.id, id(2))
  assert.ok(page.messages.every((message) => page.runs.some((run) => run.id === message.runId)))
  assert.equal(requests.length, 1)
  assert.deepEqual(
    messageCompactions(page.messages, page.runs).rows.map((row) => row.compactions),
    [[], []],
  )
  assert.throws(() => parseConversationHistory({ ...page, runs: [] }), /顺序|归属/)
  assert.throws(() => parseConversationHistory({ ...page, beforeRunId: id(3) }), /顺序/)
})

test('没有消息的压缩页仍保留执行游标，可以继续读取更早消息', async () => {
  const reader = new ConversationHistoryReader(
    async (method) => {
      if (method === 'conversation.history')
        return { messages: [], runs: [run(4, false)], before_run_id: id(4), has_more: true }
      if (method === 'step.list')
        return [
          {
            id: id(5),
            conversation_id: id(1),
            run_id: id(4),
            sequence: 1,
            type: 'context_compression',
            name: '压缩历史上下文',
            status: 'completed',
            input: { purpose: 'context_compaction', trigger: { type: 'manual' } },
            updated_at: 4,
          },
        ]
      return {
        step_id: id(5),
        field: 'output',
        present: true,
        offset: 0,
        next_offset: 19,
        total_bytes: 19,
        done: true,
        fragment: '{"compressed":true}',
      }
    },
    () => undefined,
    () => undefined,
  )
  const page = await reader.page(id(1))
  assert.equal(page.messages.length, 0)
  assert.equal(page.hasMore, true)
  assert.equal(page.beforeRunId, id(4))
  assert.equal(page.runs[0]?.compaction?.outcome, 'compressed')
  assert.equal(messageCompactions(page.messages, page.runs).before.length, 1)
})

test('推理和其他展示文字共同占用步骤窗口容量', () => {
  const steps = Array.from({ length: 200 }, (_, n) => ({
    ...stepFromRpc({
      id: id(n + 2),
      run_id: id(2),
      conversation_id: id(1),
      sequence: n + 1,
      type: 'model_call',
      name: '思考',
      status: 'completed',
      updated_at: 1,
    }),
    input: '',
    reasoning: '思'.repeat(512 * 1024),
  }))
  const retained = boundSteps(steps)
  assert.equal(retained.length, 8)
  assert.equal(retained.at(-1)?.id, steps.at(-1)?.id)
  assert.ok(
    retained.reduce(
      (sum, step) =>
        sum +
        (step.reasoning?.length ?? 0) +
        step.input.length +
        step.text.length +
        step.output.length,
      0,
    ) <=
      4 * 1024 * 1024,
  )
})

test('历史压缩严格停留在执行页边界内，页首压缩也保留顺序', () => {
  const messages = parseConversationHistory({
    messages: [
      {
        id: id(1001),
        conversationId: id(1),
        runId: id(10),
        sequence: 21,
        role: 'user',
        content: [],
        status: 'completed',
      },
    ],
    runs: [
      {
        id: id(10),
        conversationId: id(1),
        status: 'completed',
        createdAt: 10,
        finishedAt: 11,
        error: null,
      },
    ],
    beforeRunId: id(10),
    hasMore: true,
    revision: 1,
  }).messages
  const compression = (n: number) => ({
    id: id(n),
    conversationId: id(1),
    status: 'completed' as const,
    error: null,
    createdAt: n,
    finishedAt: n + 1,
    compaction: { stepId: id(100 + n), outcome: 'compressed' as const, error: null },
  })
  const timeline = messageCompactions(
    messages,
    [compression(2), compression(8), compression(12), compression(30)],
    { oldestRunId: id(8), newestRunId: id(12) },
  )
  assert.deepEqual(
    timeline.before.map((run) => run.id),
    [id(8)],
  )
  assert.deepEqual(
    timeline.rows[0]?.compactions.map((run) => run.id),
    [id(12)],
  )
})

test('消息窗口按整轮淘汰，不留下缺少提问的回答', () => {
  const messages = Array.from({ length: 202 }, (_, n) => ({
    id: id(1000 + n),
    conversationId: id(1),
    runId: id(2 + Math.floor(n / 2)),
    sequence: n + 1,
    role: n % 2 ? ('assistant' as const) : ('user' as const),
    content: [],
    status: 'completed' as const,
  }))
  const retained = boundMessages(messages)
  assert.equal(retained.length, 200)
  assert.equal(retained[0]?.role, 'user')
  assert.ok(
    retained.every(
      (message) => retained.filter((other) => other.runId === message.runId).length === 2,
    ),
  )
})
