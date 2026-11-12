import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatStep, RunStatus } from '../../src/shared/chat.ts'
import type { TimelineStep } from '../../src/shared/timeline-window.ts'
import { TimelineWindow } from '../../src/shared/timeline-window.ts'
import {
  groupTimeline,
  compactionStatus,
  currentOperationGroup,
  operationSummary,
} from '../../src/shared/timeline-groups.ts'

function step(sequence: number, name = 'read_file', status: RunStatus = 'completed'): TimelineStep {
  return {
    id: `step-${sequence}`,
    conversationId: 'conversation',
    runId: 'run',
    sequence,
    parentStepId: 'model-1',
    type: 'tool_call',
    name,
    purpose: '',
    status,
    input: '',
    inputTruncated: false,
    output: '',
    outputTruncated: false,
    outputSequence: 0,
    text: '',
    textTruncated: false,
    commentary: false,
    error: null,
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    targetLabel: '',
  }
}
function model(sequence: number): TimelineStep {
  return {
    ...step(sequence),
    id: `model-${sequence}`,
    parentStepId: null,
    type: 'model_call',
    purpose: 'answer',
    text: '阶段概述',
    commentary: true,
  }
}

test('两段概述之间的连续操作合并为一组，文字和操作顺序不变', () => {
  const source = [
    model(1),
    step(2),
    step(3, 'run_command'),
    model(4),
    { ...step(5), parentStepId: 'model-4' },
    model(6),
  ]
  const items = groupTimeline(source)
  assert.deepEqual(
    items.map((item) => item.kind),
    ['model', 'operations', 'model', 'operations', 'model'],
  )
  assert.deepEqual(
    items.flatMap((item) => (item.kind === 'model' ? [item.step] : item.steps)),
    source,
  )
  assert.equal(items[1]?.kind === 'operations' && items[1].steps.length, 2)
  assert.equal(new Set(items.map((item) => item.id)).size, items.length)
  assert.equal(source.length, 6)
  assert.deepEqual(groupTimeline([]), [])
  assert.equal(groupTimeline([step(1), step(2)]).length, 1)
})

test('跨批长组保持身份，前后读取后概述边界仍正确', async () => {
  const source: ChatStep[] = [
    model(1),
    ...Array.from({ length: 220 }, (_, index) => step(index + 2)),
    model(222),
    { ...step(223, 'run_command'), parentStepId: 'model-222' },
  ]
  const window = new TimelineWindow('conversation', 'run', async (after) => {
    const matches = source.filter((step) => step.sequence > after)
    const steps = matches.slice(0, 50)
    return {
      steps,
      afterSequence: after,
      nextSequence: steps.at(-1)?.sequence ?? after,
      hasMore: matches.length > steps.length,
      revision: 1,
    }
  })
  await window.start()
  const firstId = groupTimeline(window.steps)[1]?.id
  while (window.hasMore) {
    await window.next()
    const items = groupTimeline(window.steps)
    assert.equal(items.find((item) => item.kind === 'operations')?.id, firstId)
    assert.ok(window.steps.length <= 150)
  }
  const items = groupTimeline(window.steps)
  assert.deepEqual(
    items.map((item) => item.kind),
    ['operations', 'model', 'operations'],
  )
  const first = items[0]!
  assert.ok(first.kind === 'operations')
  assert.ok(first.steps.length < 220)
  while (window.hasPrevious) await window.previous()
  assert.equal(groupTimeline(window.steps)[0]?.kind, 'model')
  assert.equal(groupTimeline(window.steps)[1]?.id, firstId)
})

test('分组依据实际最新步骤切换，下一模型阶段和压缩记录结束上一组', () => {
  const first = step(2)
  const items = groupTimeline([model(1), first, compression(3), step(4)])
  assert.equal(currentOperationGroup(items, first), items[1]?.id)
  assert.equal(currentOperationGroup(items, step(4)), items[3]?.id)
  assert.equal(currentOperationGroup(items, model(5)), null)
  assert.equal(currentOperationGroup(items, compression(3)), null)
  assert.equal(currentOperationGroup(items, { ...step(6), parentStepId: 'other-model' }), null)
  assert.equal(currentOperationGroup(items, undefined), null)
})

test('分组汇总去重已完成动作，收起时保留审批、失败、取消和断连提示', () => {
  const steps = [
    step(1),
    step(2),
    step(3, 'run_command'),
    step(4, 'apply_patch'),
    step(5, 'read_file', 'failed'),
    step(6, 'run_command', 'awaiting_approval'),
    step(7, 'request_user_input', 'awaiting_user_input'),
    step(8, 'run_command', 'cancelled'),
    step(9, 'run_command', 'interrupted'),
    step(10, 'run_command', 'running'),
    step(11, 'run_command', 'pending'),
  ]
  const summary = operationSummary(steps)
  assert.equal(summary.label, '已读取文件、运行了命令、编辑文件')
  for (const text of [
    '1 项等待审批',
    '1 项等待补充输入',
    '1 项失败',
    '1 项已取消',
    '1 项已中断',
    '2 项正在执行',
  ])
    assert.ok(summary.notice.includes(text))
  assert.equal(summary.danger, true)
  assert.equal(summary.waiting, true)
  const offline = operationSummary(steps, false)
  assert.ok(offline.notice.includes('状态待核对'))
  assert.ok(!offline.notice.includes('正在执行'))
  assert.equal(operationSummary([step(1, 'read_file', 'failed')]).label, '操作记录')
  assert.equal(operationSummary([step(1, 'custom-tool')]).label, '已执行其他操作')
})

function compression(sequence: number, status: RunStatus = 'completed'): TimelineStep {
  return {
    ...step(sequence),
    type: 'context_compression',
    name: '压缩历史上下文',
    status,
    compactionTrigger: 'automatic',
  }
}

test('连续压缩独立成行，不进入工具分组，阶段顺序与原始批次保留', () => {
  const source = [
    model(1),
    step(2),
    compression(3),
    compression(5),
    step(7),
    model(8),
    compression(9),
  ]
  const items = groupTimeline(source)
  assert.deepEqual(
    items.map((item) => item.kind),
    ['model', 'operations', 'compaction', 'operations', 'model', 'compaction'],
  )
  const compressed = items[2]!
  assert.ok(compressed.kind === 'compaction')
  assert.equal(compressed.steps.length, 2)
  assert.deepEqual(
    items.flatMap((item) => (item.kind === 'model' ? [item.step] : item.steps)),
    source,
  )
  assert.equal(new Set(items.map((item) => item.id)).size, items.length)
})

test('压缩完成只依据压缩步骤，连续批次仍在运行时保留进度，手动与旧记录不误报自动', () => {
  const finished = compression(1),
    running = compression(3, 'running')
  assert.equal(
    compactionStatus([finished, running], true, 'running').label,
    '正在压缩上下文 · 可能需要几分钟',
  )
  assert.equal(compactionStatus([finished, running], true, 'running').pending, true)
  assert.equal(compactionStatus([finished], true, 'running').label, '上下文已自动压缩')
  assert.equal(compactionStatus([finished], false, 'completed').label, '上下文已自动压缩')
  assert.equal(
    compactionStatus([{ ...finished, compactionTrigger: 'manual' }], true, 'completed').label,
    '上下文压缩已结束',
  )
  assert.equal(
    compactionStatus([{ ...finished, compactionTrigger: null }], true, 'completed').label,
    '上下文压缩已结束',
  )
  assert.equal(
    compactionStatus([running], false, 'running').label,
    '连接已断开 · 上下文压缩状态待确认',
  )
  assert.equal(compactionStatus([running], true, 'completed').label, '上下文压缩状态待确认')
  assert.equal(compactionStatus([running], true, 'cancelled').label, '上下文压缩已取消')
  for (const [state, label] of [
    ['failed', '上下文压缩失败'],
    ['cancelled', '上下文压缩已取消'],
    ['interrupted', '上下文压缩已中断'],
  ] as const) {
    const value = compactionStatus(
      [finished, { ...compression(3, state), error: '已保留此前有效摘要' }],
      true,
      'failed',
    )
    assert.equal(value.label, label)
    assert.equal(value.pending, false)
    assert.equal(value.error, '已保留此前有效摘要')
  }
})
