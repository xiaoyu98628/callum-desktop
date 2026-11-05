import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseChatEvent, parseRun } from '../../src/shared/chat.ts'
import type { ChatRun } from '../../src/shared/chat.ts'
import { elapsedRunTime, formatRunTime } from '../../src/shared/run-time.ts'
import { runFromRpc } from '../../src/main/backend/protocol-mapper.ts'

const uuid = '019a4f39-0000-7000-8000-000000000001'
const run: ChatRun = {
  id: uuid,
  conversationId: uuid,
  status: 'running',
  error: null,
  createdAt: 10_000,
  finishedAt: null,
}

test('协议映射与 IPC 保留真实的创建、结束时间，缺失结束时间保持未知', () => {
  const mapped = runFromRpc({
    id: uuid,
    conversation_id: uuid,
    status: 'completed',
    created_at: 10_000,
    finished_at: 51_250,
  })
  assert.equal(mapped.createdAt, 10_000)
  assert.equal(mapped.finishedAt, 51_250)
  const event = parseChatEvent({
    revision: 1,
    change: { kind: 'run', value: mapped, persisted: true },
  })
  assert.deepEqual(event.change, { kind: 'run', value: mapped, persisted: true })
  assert.equal(
    runFromRpc({ id: uuid, conversation_id: uuid, status: 'completed', created_at: 10_000 })
      .finishedAt,
    null,
  )
  for (const invalid of [-1, '51250', NaN, Infinity, 12.5, undefined])
    assert.throws(() => parseRun({ ...run, finishedAt: invalid }))
})

test('活动执行按原始创建时间计时，等待审批和切换状态不会重置起点', () => {
  assert.equal(elapsedRunTime(run, 11_750), 1750)
  assert.equal(elapsedRunTime({ ...run, status: 'awaiting_approval' }, 51_250), 41_250)
  assert.equal(elapsedRunTime({ ...run, status: 'awaiting_user_input' }, 55_000), 45_000)
  assert.equal(elapsedRunTime({ ...run, status: 'pending' }, 10_000), 0)
})

test('完成、取消与失败只使用后端结束时间，重新打开历史不会继续增长', () => {
  for (const status of ['completed', 'cancelled', 'failed'] as const) {
    const terminal = { ...run, status, finishedAt: 51_250 }
    assert.equal(elapsedRunTime(terminal, 52_000), 41_250)
    assert.equal(elapsedRunTime(terminal, 1_000_000), 41_250)
    assert.equal(elapsedRunTime({ ...terminal, finishedAt: null }, 1_000_000), null)
  }
})

test('中断恢复时间、倒置时间和时钟异常不能成为推测的处理用时', () => {
  assert.equal(elapsedRunTime({ ...run, status: 'interrupted', finishedAt: 80_000 }, 90_000), null)
  assert.equal(elapsedRunTime(run, 9000), null)
  assert.equal(elapsedRunTime(run, NaN), null)
  assert.equal(elapsedRunTime({ ...run, createdAt: -1 }, 20_000), null)
  assert.equal(elapsedRunTime({ ...run, status: 'completed', finishedAt: 9000 }, 90_000), null)
})

test('用时显示区分不到一秒、整秒、分钟与小时，不把小数向上伪装成整秒', () => {
  for (const [milliseconds, text] of [
    [0, '不到 1 秒'],
    [999, '不到 1 秒'],
    [1000, '1 秒'],
    [41_250, '41 秒'],
    [59_999, '59 秒'],
    [60_000, '1 分'],
    [61_000, '1 分 1 秒'],
    [3_600_000, '1 小时'],
    [3_661_000, '1 小时 1 分 1 秒'],
  ] as const)
    assert.equal(formatRunTime(milliseconds), text)
  for (const invalid of [-1, NaN, Infinity, 0.5]) assert.throws(() => formatRunTime(invalid))
})
