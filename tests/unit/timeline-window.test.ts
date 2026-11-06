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

test('概述不持有命令参数和输出原文，跨批模型说明能关联后续工具', async () => {
  const source = Array.from({ length: 51 }, (_, i) => step(i + 1))
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
  assert.ok(
    window.steps
      .filter((step) => step.name === 'run_command')
      .every((step) => step.targetLabel === ''),
  )
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
