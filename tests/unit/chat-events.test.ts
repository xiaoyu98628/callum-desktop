import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatEventHistory } from '../../src/main/backend/chat-event-history.ts'
import { ChatEventDelivery } from '../../src/main/ipc/chat-event-delivery.ts'
import { appendDelta, messageFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import {
  chatEventBufferKey,
  MAX_MESSAGE_LENGTH,
  parseChatEvent,
  parseSendInput,
  parseResendInput,
} from '../../src/shared/chat.ts'
import type { ChatChange, ChatEvent } from '../../src/shared/chat.ts'

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

test('查询回放与实时订阅共用事件版本，保留同一执行的每次消息移除', () => {
  const history = new ChatEventHistory()
  const received: ChatEvent[] = []
  const unsubscribe = history.subscribe((value) => received.push(value))
  history.publish(event(1).change)
  const start = history.revision
  const remove = (messageId: string): ChatChange => ({
    kind: 'messages-removed',
    value: { id: uuid, conversationId: uuid, messageIds: [messageId], steeringRequeued: true },
  })
  const first = remove(uuid)
  const second = remove(uuid.slice(0, -1) + '2')
  const messageUpdate = event(3, '2').change
  history.publish(first)
  history.publish(messageUpdate)
  unsubscribe()
  unsubscribe()
  history.publish(second)

  assert.deepEqual(received, [event(1), { revision: 2, change: first }, event(3, '2')])
  assert.deepEqual([...history.changesSince(start)], [first, messageUpdate, second])
  assert.equal(history.revision, 4)
  assert.deepEqual([...history.changesSince(history.revision)], [])
})

test('事件缓存超过 512 条后，拒绝缺少历史的快照', () => {
  const history = new ChatEventHistory()
  for (let i = 1; i <= 513; i++) history.publish(event(i).change)
  assert.throws(() => [...history.changesSince(0)], /请重新加载/)
  const replayed = [...history.changesSince(1)]
  assert.equal(replayed.length, 512)
  assert.deepEqual(replayed[0], event(2).change)
  assert.deepEqual(replayed.at(-1), event(513).change)
})

test('事件缓存按 UTF-8 字节淘汰，实时订阅仍接收完整事件', () => {
  const history = new ChatEventHistory()
  const received: number[] = []
  history.subscribe(({ revision }) => received.push(revision))
  const text = '中'.repeat(3 * 1024 * 1024)
  const change: ChatChange = {
    kind: 'message',
    value: { ...message, content: [{ type: 'text', text, path: '' }] },
  }
  history.publish(change)
  history.publish(change)
  assert.deepEqual(received, [1, 2])
  assert.throws(() => [...history.changesSince(0)], /请重新加载/)
  assert.deepEqual([...history.changesSince(1)], [change])
})

test('连接中断拒绝回放快照，关闭后释放订阅并忽略迟到事件', () => {
  const history = new ChatEventHistory()
  const received: ChatEvent[] = []
  const unsubscribe = history.subscribe((value) => received.push(value))
  history.publish(event(1).change)
  history.publish({ kind: 'service', error: '受控连接中断' })
  assert.throws(() => [...history.changesSince(0)], /受控连接中断/)
  assert.equal(received[1]?.change.kind, 'service')
  history.close()
  history.close()
  unsubscribe()
  history.subscribe(() => assert.fail('关闭后不能建立新订阅'))()
  history.publish(event(3).change)
  assert.equal(received.length, 2)
  assert.equal(history.revision, 2)
  assert.throws(() => [...history.changesSince(history.revision)], /正在关闭/)
})

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

test('重发只接受固定会话和用户消息标识，不允许混入项目归属或执行参数', () => {
  const input = { conversationId: uuid, messageId: uuid, modelId: uuid, text: ' 修改 ' }
  assert.equal(parseResendInput(input).text, '修改')
  for (const value of [
    { ...input, conversationId: null },
    { ...input, messageId: 'wrong' },
    { ...input, text: '' },
    { ...input, text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
    { ...input, workspaceId: uuid },
    { ...input, stream: false },
  ])
    assert.throws(() => parseResendInput(value))
})

test('慢窗口按重发执行保留移除通知，旧消息快照不会排在移除通知之后', () => {
  const sent: { token: number; event: ChatEvent }[] = []
  const delivery = new ChatEventDelivery((token, event) => sent.push({ token, event }))
  delivery.offer(event(1))
  delivery.offer(event(2))
  const removed = parseChatEvent({
    revision: 3,
    change: {
      kind: 'messages-removed',
      value: {
        id: uuid,
        conversationId: uuid,
        messageIds: [uuid],
      },
    },
  })
  delivery.offer(removed)
  delivery.offer(event(4, '2'))
  delivery.acknowledge(sent[0]!.token)
  delivery.acknowledge(sent[1]!.token)
  delivery.acknowledge(sent[2]!.token)
  assert.deepEqual(
    sent.map((item) => item.event.revision),
    [1, 2, 3, 4],
  )
  assert.throws(() =>
    parseChatEvent({ revision: 5, change: { kind: 'messages-removed', value: { id: uuid } } }),
  )
})

test('同一执行的两次引导退回按版本保留和回放', () => {
  const first = event(2, '2')
  const second = event(4, '3')
  assert.equal(first.change.kind, 'message')
  assert.equal(second.change.kind, 'message')
  const firstId = first.change.value.id
  const secondId = second.change.value.id
  const removed = (revision: number, messageId: string): ChatEvent =>
    parseChatEvent({
      revision,
      change: {
        kind: 'messages-removed',
        value: { id: uuid, conversationId: uuid, messageIds: [messageId], steeringRequeued: true },
      },
    })
  const changes = [first, removed(3, firstId), second, removed(5, secondId)]

  const sent: { token: number; event: ChatEvent }[] = []
  const delivery = new ChatEventDelivery((token, event) => sent.push({ token, event }))
  delivery.offer(event(1))
  for (const change of changes) delivery.offer(change)
  for (const { token } of sent) delivery.acknowledge(token)
  assert.deepEqual(
    sent.slice(1).map((item) => item.event),
    changes,
  )

  const buffered = new Map<string, ChatEvent>()
  for (const change of changes) buffered.set(chatEventBufferKey(change), change)
  const visible = new Set([firstId, secondId])
  for (const { change } of [...buffered.values()].sort((a, b) => a.revision - b.revision)) {
    if (change.kind === 'message') visible.add(change.value.id)
    if (change.kind === 'messages-removed')
      for (const id of change.value.messageIds) visible.delete(id)
  }
  assert.equal(visible.size, 0)
})
