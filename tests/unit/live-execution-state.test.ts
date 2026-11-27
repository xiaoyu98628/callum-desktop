import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatEventHistory } from '../../src/main/backend/chat-event-history.ts'
import { LiveExecutionState } from '../../src/main/backend/live-execution-state.ts'
import type { ChatEvent } from '../../src/shared/chat.ts'
const id = (n: number) => `019a4f39-0000-7000-8000-${String(n).padStart(12, '0')}`
const owner = { conversation_id: id(1), run_id: id(2), message_id: id(3) }
const run = {
  id: id(2),
  conversation_id: id(1),
  status: 'running',
  created_at: 1,
  finished_at: null,
}
const message = {
  id: id(3),
  conversation_id: id(1),
  run_id: id(2),
  role: 'assistant',
  status: 'streaming',
  sequence: 1,
  created_at: 1,
  completed_at: null,
  content: [],
}

test('执行终态先提交待发增量，只在完成且已持久化时触发待发调度，关闭清理缓存', () => {
  const history = new ChatEventHistory()
  const events: ChatEvent[] = []
  history.subscribe((event) => events.push(event))
  const dispatched: string[] = []
  const live = new LiveExecutionState(history, async (value) => {
    dispatched.push(value.id)
  })
  live.receive('run.started', { ...owner, run })
  live.receive('message.created', { ...owner, message })
  live.receive('message.delta', {
    ...owner,
    block_index: 0,
    delta: { type: 'text', text: 'last delta' },
  })
  live.receive('run.completed', {
    ...owner,
    run: { ...run, status: 'completed', finished_at: 2 },
    persisted: true,
  })
  const terminal = events.findIndex(
    (event) => event.change.kind === 'run' && event.change.value.status === 'completed',
  )
  assert.ok(terminal > 0)
  assert.equal(events[terminal - 1]?.change.kind, 'message')
  const last = events[terminal - 1]!
  assert.equal(last.change.kind === 'message' && last.change.value.content[0]?.text, 'last delta')
  assert.deepEqual(dispatched, [id(2)])
  live.receive('run.completed', {
    ...owner,
    run: { ...run, status: 'completed', finished_at: 2 },
    persisted: false,
  })
  assert.deepEqual(dispatched, [id(2)])
  assert.equal(live.persistenceFailures.has(id(1)), true)
  live.close()
  assert.equal(
    live.messages.size + live.runs.size + live.steps.size + live.persistenceFailures.size,
    0,
  )
  history.close()
})

test('跨会话增量仍作为协议错误拒绝，不以订阅隔离吞掉无效后端数据', () => {
  const history = new ChatEventHistory()
  const live = new LiveExecutionState(history, async () => {})
  live.receive('message.created', { ...owner, message })
  assert.throws(
    () =>
      live.receive('message.delta', {
        ...owner,
        conversation_id: id(4),
        block_index: 0,
        delta: { type: 'text', text: 'wrong owner' },
      }),
    /归属/,
  )
  live.close()
  history.close()
})
