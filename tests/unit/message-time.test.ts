import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { parseChatEvent, parseMessage } from '../../src/shared/chat.ts'
import { formatMessageTime, fullMessageTime, messageTime } from '../../src/shared/message-time.ts'

const uuid = '019a4f39-0000-7000-8000-000000000001'
const rpcMessage = {
  id: uuid,
  conversation_id: uuid,
  run_id: uuid,
  sequence: 1,
  role: 'assistant',
  status: 'completed',
  content: [],
  created_at: 10_000,
  updated_at: 99_000,
  completed_at: 20_000,
}

test('消息时间经协议和事件透传，创建与完成时间不混用，缺失字段保留未知', () => {
  const mapped = messageFromRpc(rpcMessage)
  assert.equal(mapped.createdAt, 10_000)
  assert.equal(mapped.completedAt, 20_000)
  assert.deepEqual(messageTime(mapped), { value: 20_000, label: '完成时间' })
  assert.deepEqual(messageTime({ ...mapped, role: 'user' }), { value: 20_000, label: '发送时间' })
  const event = parseChatEvent({ revision: 1, change: { kind: 'message', value: mapped } })
  assert.deepEqual(event.change, { kind: 'message', value: mapped })
  const legacy = messageFromRpc({ ...rpcMessage, created_at: undefined, completed_at: undefined })
  assert.equal(messageTime(legacy), null)
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted'])
    assert.deepEqual(messageTime({ ...mapped, completedAt: null, status }), {
      value: 10_000,
      label: '创建时间',
    })
  for (const invalid of [-1, NaN, Infinity, 1.5, '20000', 8_640_000_000_000_001]) {
    assert.throws(() => parseMessage({ ...mapped, createdAt: invalid }))
    assert.throws(() => parseMessage({ ...mapped, completedAt: invalid }))
  }
})

test('消息短时间按本地日历区分当天、最近一周、月日和跨年日期', () => {
  const now = new Date(2026, 10, 10, 20).getTime()
  const stamp = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day, 17, 6, 8).getTime()
  assert.equal(formatMessageTime(stamp(2026, 11, 10), now), '17:06')
  assert.equal(formatMessageTime(stamp(2026, 11, 9), now), '星期一 17:06')
  assert.equal(formatMessageTime(stamp(2026, 10, 29), now), '10月29日 17:06')
  assert.equal(formatMessageTime(stamp(2025, 10, 29), now), '2025年10月29日 17:06')
  assert.equal(formatMessageTime(stamp(2026, 11, 11), now), '11月11日 17:06')
  assert.match(fullMessageTime(stamp(2026, 11, 10)), /2026年11月10日.*星期二.*17:06:08/)
})
