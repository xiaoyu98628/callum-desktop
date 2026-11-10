import { isActiveRun, record } from './chat.ts'
import type { ChatMessage, ChatRun, ChatStep, StepDetails } from './chat.ts'

export interface CompactionDisplayStatus {
  label: string
  pending: boolean
  danger: boolean
  error: string | null
}
export type CompactionOutcome = 'compressed' | 'skipped' | 'unknown'

/** 仅匹配独立命令；带参数、多行或正文中的路径仍按普通消息处理。 */
export function matchesCompactCommand(text: string): boolean {
  const query = text.trim().toLowerCase()
  return /^\/[a-z]*$/.test(query) && '/compact'.startsWith(query)
}
export function isCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === '/compact'
}

export function isManualCompactionStep(step: ChatStep): boolean {
  if (step.type !== 'context_compression' || step.sequence !== 1 || step.parentStepId !== null)
    return false
  try {
    const input = record(JSON.parse(step.input) as unknown)
    return input.purpose === 'context_compaction' && record(input.trigger).type === 'manual'
  } catch {
    return false
  }
}

export function compactionOutcome(details: StepDetails): CompactionOutcome {
  if (details.outputTruncated || !details.output) return 'unknown'
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(details.output) as unknown)
  } catch (cause) {
    throw new Error('压缩结果格式无效，请重新读取。', { cause })
  }
  if (value.compressed === true) return 'compressed'
  return value.compressed === false && value.reason === 'no_earlier_complete_turns'
    ? 'skipped'
    : 'unknown'
}

export function manualCompactionStatus(
  run: ChatRun,
  connected: boolean,
  outcome: CompactionOutcome,
  reading: boolean,
  readError: string,
): CompactionDisplayStatus {
  if (isActiveRun(run))
    return {
      label: connected ? '正在压缩上下文 · 可能需要几分钟' : '连接已断开 · 上下文压缩状态待确认',
      pending: connected,
      danger: false,
      error: null,
    }
  if (run.status !== 'completed')
    return {
      label:
        run.status === 'cancelled'
          ? '上下文压缩已取消'
          : run.status === 'failed'
            ? '上下文压缩失败'
            : '上下文压缩已中断',
      pending: false,
      danger: run.status !== 'cancelled',
      error: run.error,
    }
  return {
    label: reading
      ? '正在读取压缩结果…'
      : outcome === 'compressed'
        ? '上下文已压缩'
        : outcome === 'skipped'
          ? '暂无可压缩的较早对话'
          : '上下文压缩已结束 · 结果待确认',
    pending: reading && connected,
    danger: !!readError,
    error: readError || null,
  }
}

/** UUIDv7 执行标识保留创建顺序；同一执行的用户和回答消息保持相邻。 */
export function messageCompactions(
  messages: ChatMessage[],
  runs: ChatRun[],
  range?: { oldestRunId: string; newestRunId: string },
) {
  const rows = messages.map((message) => ({ message, compactions: [] as ChatRun[] }))
  const before: ChatRun[] = []
  for (const run of runs
    .filter((item) => item.compaction)
    .toSorted((a, b) => a.id.localeCompare(b.id))) {
    if (range && (run.id < range.oldestRunId || run.id > range.newestRunId)) continue
    const row = rows.findLast((item) => item.message.runId.localeCompare(run.id) < 0)
    if (row) row.compactions.push(run)
    else if (range || !messages.length || messages[0]?.sequence === 1) before.push(run)
  }
  return { before, rows }
}
