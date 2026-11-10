import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatStep, StepPage } from '../../src/shared/chat.ts'
import { TimelineWindow } from '../../src/shared/timeline-window.ts'

function step(sequence: number): ChatStep {
  return {
    id: `step-${sequence}`,
    conversationId: 'conversation',
    runId: 'run',
    parentStepId: null,
    sequence,
    type: 'tool_call',
    name: 'run_command',
    purpose: '',
    status: 'completed',
    input: JSON.stringify({ arguments: { command: ['echo', `command-${sequence}`] } }),
    inputTruncated: false,
    error: null,
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    text: '',
    commentary: false,
    textTruncated: false,
    output: '',
    outputTruncated: false,
    outputSequence: 0,
  }
}

function fixture(source: ChatStep[]) {
  const reads: number[] = []
  const fetch = async (after: number): Promise<StepPage> => {
    reads.push(after)
    const matches = source.filter((step) => step.sequence > after)
    const steps = matches.slice(0, 50)
    return {
      steps,
      afterSequence: after,
      nextSequence: steps.at(-1)?.sequence ?? after,
      hasMore: matches.length > 50,
      revision: 1,
    }
  }
  return { window: new TimelineWindow('conversation', 'run', fetch), reads, fetch }
}

test('过程滚动跨多批记录可双向查看，概述窗口始终有界且不重复', async () => {
  const source = Array.from({ length: 500 }, (_, i) => step(i + 1))
  const { window } = fixture(source)
  const seen = new Set<number>()
  await window.start()
  for (;;) {
    assert.ok(window.steps.length <= 150)
    assert.equal(new Set(window.steps.map((step) => step.id)).size, window.steps.length)
    window.steps.forEach((step) => seen.add(step.sequence))
    if (!window.hasMore) break
    await window.next()
  }
  assert.equal(seen.size, 500)
  for (;;) {
    assert.ok(window.steps.length <= 150)
    if (!window.hasPrevious) break
    await window.previous()
  }
  assert.equal(window.steps[0]?.sequence, 1)
  assert.deepEqual(
    source.map((step) => step.sequence),
    Array.from({ length: 500 }, (_, i) => i + 1),
  )
})

test('从运行尾部进入时可定位前方记录，不假定 sequence 连续', async () => {
  const source = Array.from({ length: 220 }, (_, i) => step((i + 1) * 10))
  const { window } = fixture(source)
  await window.start(1805)
  assert.equal(window.steps[0]?.sequence, 1810)
  while (window.hasPrevious) await window.previous()
  assert.equal(window.steps[0]?.sequence, 10)
  const seen = new Set(window.steps.map((step) => step.sequence))
  while (window.hasMore) {
    await window.next()
    window.steps.forEach((step) => seen.add(step.sequence))
  }
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    source.map((step) => step.sequence),
  )
})

test('游标缓存淘汰后仍可回到开头，完整记录不受窗口容量限制', async () => {
  const { window } = fixture(Array.from({ length: 7000 }, (_, i) => step(i + 1)))
  await window.start()
  while (window.hasMore) await window.next()
  assert.equal(window.steps.at(-1)?.sequence, 7000)
  while (window.hasPrevious) await window.previous()
  assert.equal(window.steps[0]?.sequence, 1)
  assert.ok(window.steps.length <= 150)
})

test('概述只保留有界的操作标签，跨批模型说明能关联后续工具', async () => {
  const source = Array.from({ length: 51 }, (_, i) => step(i + 1))
  source[1] = {
    ...source[1]!,
    input: JSON.stringify({ arguments: { command: ['echo', '长'.repeat(500)] } }),
  }
  source[2] = {
    ...source[2]!,
    name: 'search_text',
    input: JSON.stringify({ arguments: { path: '/tmp/project', query: '待审批' } }),
  }
  source[49] = {
    ...source[49]!,
    type: 'model_call',
    purpose: 'answer',
    text: '说明'.repeat(20000),
    input: 'sensitive-command-input',
    output: 'x'.repeat(65536),
  }
  source[50] = { ...source[50]!, parentStepId: source[49]!.id }
  const { window } = fixture(source)
  await window.start()
  await window.next()
  const model = window.steps.find((step) => step.id === source[49]!.id)!
  assert.equal(model.commentary, true)
  assert.ok(model.text.length <= 16384)
  assert.equal(model.textTruncated, true)
  assert.ok(window.steps.every((step) => !step.input && !step.output))
  assert.equal(window.steps[0]?.targetLabel, 'echo command-1')
  assert.equal(window.steps[1]?.targetLabel.length, 240)
  assert.ok(window.steps[1]?.targetLabel.endsWith('…'))
  assert.equal(window.steps[2]?.targetLabel, '"待审批"')
  window.merge([{ ...source[49]!, text: '', updatedAt: 3 }])
  assert.ok(window.steps.find((step) => step.id === model.id)?.text)
  assert.equal(source[49]?.input, 'sensitive-command-input')
  const boundary = Array.from({ length: 200 }, (_, index) => step(index + 1))
  boundary[149] = { ...boundary[149]!, type: 'model_call', purpose: 'answer', text: '阶段概述' }
  boundary[150] = { ...boundary[150]!, parentStepId: boundary[149]!.id }
  const another = fixture(boundary).window
  await another.start()
  await another.next()
  await another.next()
  await another.next()
  assert.equal(another.steps.find((step) => step.id === boundary[149]!.id)?.commentary, true)
  await another.previous()
  assert.equal(another.steps.find((step) => step.id === boundary[149]!.id)?.commentary, true)
})

test('读取失败保留当前窗口，拒绝错误归属及不推进的游标', async () => {
  const source = Array.from({ length: 100 }, (_, i) => step(i + 1))
  const fixtureValue = fixture(source)
  let failed = false
  const window = new TimelineWindow('conversation', 'run', async (after) => {
    if (after && !failed) {
      failed = true
      throw new Error('controlled failure')
    }
    return fixtureValue.fetch(after)
  })
  await window.start()
  const before = window.steps.map((step) => step.id)
  await assert.rejects(window.next(), /controlled failure/)
  assert.deepEqual(
    window.steps.map((step) => step.id),
    before,
  )
  await window.next()
  assert.equal(window.steps.length, 100)
  for (const page of [
    { ...(await fixtureValue.fetch(0)), nextSequence: 0 },
    { ...(await fixtureValue.fetch(0)), steps: [{ ...step(1), runId: 'other' }] },
    { steps: [], afterSequence: 0, nextSequence: 0, hasMore: true, revision: 1 },
  ])
    await assert.rejects(
      new TimelineWindow('conversation', 'run', async () => page).start(),
      /归属|游标/,
    )
})

test('运行中逐条增长先补满尾批，短过程不提前丢失概述，文字恢复结果保留', async () => {
  const source: ChatStep[] = [{ ...step(1), type: 'model_call', purpose: 'answer', text: '' }]
  const { window, reads } = fixture(source)
  await window.start()
  window.setText('step-1', '开始核对文件。', false)
  window.setReasoning('step-1', '独立推理。', false)
  for (let sequence = 2; sequence <= 151; sequence++) {
    source.push({ ...step(sequence), parentStepId: 'step-1' })
    await window.next()
    assert.ok(window.steps.length <= 150)
    if (sequence <= 150) {
      assert.equal(window.steps[0]?.id, 'step-1')
      assert.equal(window.steps[0]?.text, '开始核对文件。')
      assert.equal(window.steps[0]?.reasoning, '独立推理。')
      assert.equal(window.steps[0]?.commentary, true)
      assert.equal(window.hasPrevious, false)
      assert.equal(window.steps.length, sequence)
    }
  }
  assert.equal(window.steps[0]?.sequence, 51)
  assert.equal(window.hasPrevious, true)
  assert.ok(reads.filter((after) => after === 0).length > 40)
  await window.previous()
  assert.equal(window.steps[0]?.id, 'step-1')
})

test('补齐尾批拒绝倒退或替换旧记录，失败不丢弃缓存并可重试', async () => {
  const source = [step(1), step(2)]
  const fixtureValue = fixture(source)
  let fault: 'none' | 'throw' | 'regress' | 'replace' = 'none'
  const window = new TimelineWindow('conversation', 'run', async (after) => {
    if (fault === 'throw') throw new Error('controlled refill failure')
    const page = await fixtureValue.fetch(after)
    if (fault === 'regress') return { ...page, steps: [step(1)], nextSequence: 1 }
    if (fault === 'replace') return { ...page, steps: [{ ...step(1), id: 'replacement' }, step(2)] }
    return page
  })
  await window.start()
  window.setText('step-1', '保留已恢复内容', false)
  const before = window.steps
  for (const value of ['throw', 'regress', 'replace'] as const) {
    fault = value
    await assert.rejects(window.next(), /controlled|倒退/)
    assert.deepEqual(window.steps, before)
  }
  fault = 'none'
  source.push(step(3))
  await window.next()
  assert.equal(window.steps.length, 3)
  assert.equal(window.steps[0]?.text, '保留已恢复内容')
})

test('压缩触发来源在轻量窗口和实时合并中保留，不持有完整参数或猜测旧记录来源', async () => {
  const source: ChatStep[] = [
    {
      ...step(1),
      type: 'context_compression',
      status: 'running',
      input: JSON.stringify({
        trigger: { type: 'automatic' },
        source_batches: [{ fingerprint: 'source' }],
      }),
    },
  ]
  const { window } = fixture(source)
  await window.start()
  assert.equal(window.steps[0]?.compactionTrigger, 'automatic')
  assert.equal(window.steps[0]?.input, '')
  window.merge([{ ...source[0]!, status: 'completed', updatedAt: 3 }])
  assert.equal(window.steps[0]?.status, 'completed')
  assert.equal(window.steps[0]?.compactionTrigger, 'automatic')
  await window.next()
  assert.equal(window.steps[0]?.status, 'completed')
  assert.equal(window.steps[0]?.compactionTrigger, 'automatic')
  for (const [input, expected] of [
    ['{}', null],
    ['{"trigger":', null],
    ['{"trigger":{"type":"unexpected"}}', null],
    ['{"trigger":{"type":"manual"}}', 'manual'],
  ] as const) {
    const another = fixture([{ ...step(1), type: 'context_compression', input }]).window
    await another.start()
    assert.equal(another.steps[0]?.compactionTrigger, expected)
    assert.equal(another.steps[0]?.input, '')
  }
})
