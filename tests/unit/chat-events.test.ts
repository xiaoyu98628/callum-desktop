import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatEventDelivery } from '../../src/main/ipc/chat-event-delivery.ts'
import { appendDelta, messageFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { MAX_MESSAGE_LENGTH, parseChatEvent, parseSendInput } from '../../src/shared/chat.ts'
import type { ChatEvent } from '../../src/shared/chat.ts'

const uuid = '019a4f39-0000-7000-8000-000000000001'
const message = messageFromRpc({
  id: uuid,
  conversation_id: uuid,
  run_id: uuid,
  sequence: 2,
  role: 'assistant',
  status: 'running',
  content: [],
})
function event(revision: number, suffix = '1'): ChatEvent {
  return {
    revision,
    change: {
      kind: 'message',
      value: {
        ...message,
        id: `019a4f39-0000-7000-8000-${suffix.padStart(12, '0')}`,
        content: [{ type: 'text', text: String(revision), path: '' }],
      },
    },
  }
}

test('慢窗口每次只接收一条通知，并合并同一消息的完整快照', () => {
  const sent: { token: number; event: ChatEvent }[] = []
  const delivery = new ChatEventDelivery((token, event) => sent.push({ token, event }))
  delivery.offer(event(1))
  delivery.offer(event(2))
  delivery.offer(event(3))
  delivery.offer(event(4, '2'))
  assert.equal(sent.length, 1)
  delivery.acknowledge(-1)
  assert.equal(sent.length, 1)
  delivery.acknowledge(sent[0]!.token)
  assert.equal(sent[1]?.event.revision, 3)
  delivery.acknowledge(sent[1]!.token)
  assert.equal(sent[2]?.event.revision, 4)
  delivery.reset()
  delivery.acknowledge(sent[2]!.token)
  assert.equal(sent.length, 3)
})

test('窗口通知积压超过边界时要求恢复快照，不继续增长', () => {
  const sent: { token: number; event: ChatEvent }[] = []
  const delivery = new ChatEventDelivery((token, event) => sent.push({ token, event }))
  for (let i = 1; i < 1000; i++) delivery.offer(event(i, String(i)))
  assert.equal(sent.length, 1)
  assert.equal(delivery.overloaded, true)
  delivery.acknowledge(sent[0]!.token)
  assert.equal(sent[1]?.event.change.kind, 'service')
  delivery.reset()
  delivery.offer(event(1001))
  assert.equal(sent.at(-1)?.event.revision, 1001)
})

test('消息边界拒绝越界、错误归属、未知字段与过长输入', () => {
  const input = { conversationId: null, modelId: uuid, text: ' 内容 ' }
  assert.equal(parseSendInput(input).text, '内容')
  for (const invalid of [
    { ...input, text: ' ' },
    { ...input, text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
    { ...input, command: 'unexpected' },
    { ...input, modelId: '../../file' },
  ])
    assert.throws(() => parseSendInput(invalid))
  assert.throws(() =>
    appendDelta(message, {
      conversation_id: uuid,
      run_id: uuid,
      block_index: 8,
      delta: { type: 'text', text: 'x' },
    }),
  )
  assert.throws(() =>
    appendDelta(message, {
      conversation_id: uuid.replace(/1$/, '2'),
      run_id: uuid,
      block_index: 0,
      delta: { type: 'text', text: 'x' },
    }),
  )
  assert.throws(() =>
    parseChatEvent({ revision: 1, change: { kind: 'run', persisted: true, value: {} } }),
  )
  const first = appendDelta(message, {
    conversation_id: uuid,
    run_id: uuid,
    block_index: 0,
    delta: { type: 'text', text: '中' },
  })
  assert.equal(first.content[0]?.text, '中')
  assert.deepEqual(message.content, [], '组装增量不修改此前发送的快照')
})
