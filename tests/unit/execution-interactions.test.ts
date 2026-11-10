import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConversationState } from '../../src/renderer/features/conversation/state.ts'
import { createExecutionInteractions } from '../../src/renderer/features/conversation/execution-interactions.ts'
import type { ExecutionSettings } from '../../src/shared/execution.ts'
import type { ChatResult } from '../../src/shared/chat.ts'

const id = (n: number) => `019a4f39-0000-7000-8000-${String(n).padStart(12, '0')}`

test('权限读取合并请求，保存冲突保留已确认的设置，销毁后不接收迟到状态', async (t) => {
  const state = createConversationState()
  let resolve!: (value: ChatResult<ExecutionSettings>) => void
  let reads = 0,
    disposed = false
  const previous = Reflect.get(globalThis, 'window')
  Reflect.set(globalThis, 'window', {
    callum: {
      getExecutionSettings: () => {
        reads++
        return new Promise((done) => {
          resolve = done
        })
      },
      updateExecutionSettings: async () => ({ ok: false, error: '设置版本已变化' }),
    },
  })
  t.after(() => {
    Reflect.set(globalThis, 'window', previous)
  })
  const controller = createExecutionInteractions(state, {
    selection: () => 0,
    disposed: () => disposed,
    activeRun: () => null,
    pendingInputs: () => [],
  })
  const first = controller.refreshExecutionSettings(),
    second = controller.refreshExecutionSettings()
  assert.equal(first, second)
  assert.equal(reads, 1)
  const settings: ExecutionSettings = {
    revision: 1,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  }
  resolve({ ok: true, value: settings })
  await first
  await assert.rejects(
    controller.saveExecutionSettings({ ...settings, approvalPolicy: 'always' }),
    /版本/,
  )
  assert.equal(state.executionSettings?.approvalPolicy, 'on-request')
  assert.equal(state.executionSettingsSaving, false)
  const pending = controller.refreshExecutionSettings()
  disposed = true
  resolve({ ok: true, value: { ...settings, revision: 2 } })
  await pending
  assert.equal(state.executionSettings?.revision, 1)
})

test('活动执行与历史页独立，迟到终态不能删除新执行，缓存数量有界', () => {
  const state = createConversationState()
  const controller = createExecutionInteractions(state, {
    selection: () => 0,
    disposed: () => false,
    activeRun: () => null,
    pendingInputs: () => [],
  })
  const run = {
    id: id(2),
    conversationId: id(1),
    status: 'running' as const,
    error: null,
    createdAt: 1,
    finishedAt: null,
  }
  controller.rememberRun(run)
  controller.rememberRun({ ...run, id: id(3) })
  controller.rememberRun({ ...run, status: 'completed', finishedAt: 2 })
  assert.equal(state.activeRuns[id(1)]?.id, id(3))
  for (let n = 2; n < 70; n++)
    controller.rememberRun({ ...run, id: id(100 + n), conversationId: id(200 + n) })
  assert.equal(Object.keys(state.activeRuns).length, 64)
  assert.match(state.serviceError, /超出限制/)
})
