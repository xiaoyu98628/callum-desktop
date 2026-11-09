import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextRatio,
  contextPercent,
  contextTokens,
  parseContextUsage,
  parseContextUsageInput,
} from '../../src/shared/context-usage.ts'
import { contextUsageFromRpc } from '../../src/main/backend/protocol-mapper.ts'

const modelId = '019a4f39-0000-7000-8000-000000000001'
const snapshot = {
  conversation_id: '',
  model_id: modelId,
  revision: 3,
  updated_at: 100,
  state: 'ready',
  estimated_tokens: 2500,
  draft_tokens: 20,
  input_limit: 2000,
  context_window: 8000,
  output_reserve: 4096,
  safety_margin: 1024,
  estimation_method: 'unicode-v1',
  actual_input_tokens: null,
}
test('上下文用量保留超限比例、未知容量和实际值的独立含义', () => {
  const usage = contextUsageFromRpc(snapshot)
  assert.equal(contextRatio(usage), 1.25)
  assert.throws(() => contextUsageFromRpc({ ...snapshot, conversation_id: 0 }))
  assert.throws(() => contextUsageFromRpc({ ...snapshot, run_id: false }))
  assert.equal(usage.actualInputTokens, null)
  assert.equal(
    contextRatio(contextUsageFromRpc({ ...snapshot, input_limit: null, context_window: null })),
    null,
  )
  assert.equal(contextRatio(null), null)
  assert.equal(
    contextRatio(contextUsageFromRpc({ ...snapshot, state: 'preparing', estimated_tokens: null })),
    null,
  )
  assert.equal(contextUsageFromRpc({ ...snapshot, actual_input_tokens: 35 }).estimatedTokens, 2500)
  for (const patch of [
    { estimatedTokens: null },
    { inputLimit: 0 },
    { actualInputTokens: -1 },
    { snapshotRevision: NaN },
    { state: 'completed' },
    { id: modelId },
  ])
    assert.throws(() => parseContextUsage({ ...usage, ...patch }))
})
test('统计输入拒绝额外字段、双重项目来源和过长草稿', () => {
  const value = { conversationId: null, workspaceId: null, modelId, draft: '保留草稿' }
  assert.deepEqual(parseContextUsageInput(value), value)
  for (const patch of [
    { modelId: 'invalid' },
    { conversationId: modelId, workspaceId: modelId },
    { draft: 'x'.repeat(100001) },
    { draft: '\0' },
    { apiKey: 'private' },
  ])
    assert.throws(() => parseContextUsageInput({ ...value, ...patch }))
})

test('百分比保持小用量精度，未知、零用量和超限比例明确区分', () => {
  for (const [ratio, expected] of [
    [null, '—'],
    [0, '0%'],
    [0.0001, '<0.1%'],
    [0.001, '0.1%'],
    [0.354789, '35.5%'],
    [1, '100%'],
    [1.25, '125%'],
  ] as const)
    assert.equal(contextPercent(ratio), expected)
})

test('上下文短数值区分未知与零值，并按 k、m 缩写', () => {
  for (const [value, expected] of [
    [null, '—'],
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [259000, '259k'],
    [475000, '475k'],
    [1000000, '1m'],
  ] as const)
    assert.equal(contextTokens(value), expected)
})
