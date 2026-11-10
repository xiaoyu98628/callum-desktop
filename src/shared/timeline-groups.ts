import type { ChatStep, RunStatus } from './chat.ts'
import type { TimelineStep } from './timeline-window.ts'

export interface OperationGroup {
  kind: 'operations'
  id: string
  steps: TimelineStep[]
}

export interface CompactionGroup {
  kind: 'compaction'
  id: string
  steps: TimelineStep[]
}

export type TimelineItem =
  { kind: 'model'; id: string; step: TimelineStep } | OperationGroup | CompactionGroup

/** 概述和思考保持原顺序；其间连续的操作合为一组，不跨过可见的模型说明。 */
export function groupTimeline(steps: TimelineStep[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const step of steps) {
    if (step.type === 'model_call') {
      items.push({ kind: 'model', id: step.id, step })
      continue
    }
    const previous = items.at(-1)
    if (step.type === 'context_compression') {
      if (previous?.kind === 'compaction') previous.steps.push(step)
      else items.push({ kind: 'compaction', id: `compaction:${step.id}`, steps: [step] })
      continue
    }
    if (previous?.kind === 'operations') previous.steps.push(step)
    else
      items.push({
        kind: 'operations',
        // 长组跨批读取时沿用父步骤身份，不因首条操作移出窗口而丢失折叠状态。
        id: `operations:${step.parentStepId ?? step.id}${previous?.kind === 'compaction' ? `:after:${previous.id}` : ''}`,
        steps: [step],
      })
  }
  return items
}

/** 下一次模型调用开始即结束上一操作组；未读完的历史不能被当成当前操作。 */
export function currentOperationGroup(
  items: TimelineItem[],
  latest: ChatStep | undefined,
): string | null {
  if (!latest || !['tool_call', 'user_input'].includes(latest.type)) return null
  const groups = items.filter((item) => item.kind === 'operations')
  // 压缩可能插入同一批工具之间，优先匹配实际步骤，避免把前一段误当成当前组。
  return (
    groups.find((item) => item.steps.some((step) => step.id === latest.id))?.id ??
    groups.findLast((item) =>
      item.steps.some(
        (step) => latest.parentStepId !== null && step.parentStepId === latest.parentStepId,
      ),
    )?.id ??
    null
  )
}

/** 标题按完成顺序列出动作类型，其他状态单独汇总。 */
export function operationSummary(steps: ChatStep[]): {
  label: string
  notice: string
  danger: boolean
  waiting: boolean
} {
  const actions: Record<string, string> = {
    read_file: '读取文件',
    list_directory: '查看目录',
    search_text: '搜索内容',
    apply_patch: '编辑文件',
    run_command: '运行命令',
    request_user_input: '结束补充输入',
  }
  const completed = new Set<string>()
  const statuses = new Map<string, number>()
  for (const step of steps) {
    if (step.status === 'completed') {
      completed.add(actions[step.name] ?? '执行其他操作')
    } else statuses.set(step.status, (statuses.get(step.status) ?? 0) + 1)
  }
  const notices: string[] = []
  for (const [status, label] of [
    ['awaiting_approval', '等待审批'],
    ['awaiting_user_input', '等待补充输入'],
    ['failed', '失败'],
    ['interrupted', '已中断'],
    ['cancelled', '已取消'],
  ] as const) {
    const count = statuses.get(status) ?? 0
    if (count) notices.push(`${count} 项${label}`)
  }
  const running = (statuses.get('running') ?? 0) + (statuses.get('pending') ?? 0)
  if (running) notices.push(`${running} 项正在执行`)
  return {
    label: completed.size ? `已${[...completed].join('、')}` : '操作记录',
    notice: notices.join('、'),
    danger: statuses.has('failed') || statuses.has('interrupted'),
    waiting: statuses.has('awaiting_approval') || statuses.has('awaiting_user_input'),
  }
}

/** 连续压缩批次只形成一条状态，不将压缩计入工具次数；成功仅来自压缩步骤终态。 */
export function compactionStatus(
  steps: TimelineStep[],
  connected: boolean,
  runStatus: RunStatus | null,
): { label: string; pending: boolean; danger: boolean; error: string | null } {
  const failure = steps.findLast((step) =>
    ['failed', 'cancelled', 'interrupted'].includes(step.status),
  )
  if (failure) {
    const label =
      failure.status === 'failed'
        ? '上下文压缩失败'
        : failure.status === 'cancelled'
          ? '上下文压缩已取消'
          : '上下文压缩已中断'
    return { label, pending: false, danger: failure.status !== 'cancelled', error: failure.error }
  }
  const pending = steps.some((step) => step.status !== 'completed')
  if (pending || !steps.length) {
    if (!connected)
      return {
        label: '连接已断开 · 上下文压缩状态待确认',
        pending: false,
        danger: false,
        error: null,
      }
    if (
      !runStatus ||
      !['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(runStatus)
    ) {
      const label =
        runStatus === 'cancelled'
          ? '上下文压缩已取消'
          : runStatus === 'failed' || runStatus === 'interrupted'
            ? '上下文压缩已中断'
            : '上下文压缩状态待确认'
      return { label, pending: false, danger: false, error: null }
    }
    return { label: '正在压缩上下文 · 可能需要几分钟', pending: true, danger: false, error: null }
  }
  return {
    label: steps.every((step) => step.compactionTrigger === 'automatic')
      ? '上下文已自动压缩'
      : '上下文压缩已结束',
    pending: false,
    danger: false,
    error: null,
  }
}
