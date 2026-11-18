import { id, integer, record, string } from './validation.ts'

export interface ContextUsageInput {
  conversationId: string | null
  workspaceId: string | null
  modelId: string
  draft: string
  draftImages?: number
}
export interface ContextUsage {
  id: string
  conversationId: string | null
  modelId: string
  runId: string | null
  snapshotRevision: number
  updatedAt: number
  state: 'ready' | 'preparing' | 'refresh_required' | 'unavailable'
  reason: string
  estimatedTokens: number | null
  draftTokens: number
  inputLimit: number | null
  contextWindow: number | null
  outputReserve: number
  safetyMargin: number
  estimationMethod: string
  actualInputTokens: number | null
}

export function parseContextUsageInput(value: unknown): ContextUsageInput {
  const v = record(value)
  if (
    Object.keys(v).some(
      (key) => !['conversationId', 'workspaceId', 'modelId', 'draft', 'draftImages'].includes(key),
    )
  )
    throw new Error('上下文统计参数无效')
  const conversationId = v.conversationId == null ? null : id(v.conversationId)
  const workspaceId = v.workspaceId == null ? null : id(v.workspaceId)
  const draft = string(v.draft)
  const draftImages = v.draftImages === undefined ? undefined : integer(v.draftImages)
  if (
    (conversationId && workspaceId) ||
    draft.length > 100_000 ||
    draft.includes('\0') ||
    (draftImages ?? 0) > 8
  )
    throw new Error('上下文统计参数无效')
  return {
    conversationId,
    workspaceId,
    modelId: id(v.modelId),
    draft,
    ...(draftImages === undefined ? {} : { draftImages }),
  }
}

export function parseContextUsage(value: unknown): ContextUsage {
  const v = record(value)
  const conversationId = v.conversationId === null ? null : id(v.conversationId)
  const state = string(v.state)
  if (
    !['ready', 'preparing', 'refresh_required', 'unavailable'].includes(state) ||
    v.id !== (conversationId ?? '')
  )
    throw new Error('上下文统计状态无效')
  const result: ContextUsage = {
    id: conversationId ?? '',
    conversationId,
    modelId: id(v.modelId),
    runId: v.runId === null ? null : id(v.runId),
    snapshotRevision: integer(v.snapshotRevision),
    updatedAt: integer(v.updatedAt),
    state: state as ContextUsage['state'],
    reason: string(v.reason),
    estimatedTokens: v.estimatedTokens === null ? null : integer(v.estimatedTokens),
    draftTokens: integer(v.draftTokens),
    inputLimit: v.inputLimit === null ? null : integer(v.inputLimit, 1),
    contextWindow: v.contextWindow === null ? null : integer(v.contextWindow, 1),
    outputReserve: integer(v.outputReserve, 1),
    safetyMargin: integer(v.safetyMargin, 1),
    estimationMethod: string(v.estimationMethod),
    actualInputTokens: v.actualInputTokens === null ? null : integer(v.actualInputTokens),
  }
  if ((result.state === 'ready') !== (result.estimatedTokens !== null))
    throw new Error('上下文统计数值与状态不一致')
  return result
}

export function contextRatio(usage: ContextUsage | null): number | null {
  return usage?.state === 'ready' && usage.estimatedTokens !== null && usage.inputLimit !== null
    ? usage.estimatedTokens / usage.inputLimit
    : null
}

/** 小比例保留精度；未知值不展示为 0%，超限数值不截断。 */
export function contextPercent(ratio: number | null): string {
  if (ratio === null) return '—'
  const percent = ratio * 100
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${Number(percent.toFixed(1))}%`
}

const contextTokenFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 0,
})

/** 展示用量的近似短数值；原始 Token 统计保持不变。 */
export function contextTokens(value: number | null): string {
  return value === null ? '—' : contextTokenFormat.format(value).toLowerCase()
}
