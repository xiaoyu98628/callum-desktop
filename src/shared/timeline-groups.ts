import type { ChatMessage, ChatStep, RunStatus } from './chat.ts'
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
  | { kind: 'model'; id: string; step: TimelineStep }
  | { kind: 'steering'; id: string; message: ChatMessage }
  | OperationGroup
  | CompactionGroup

/** 按步骤顺序插入引导消息，连续操作在压缩或引导处结束分组。 */
export function groupTimeline(steps: TimelineStep[], steering: ChatMessage[] = []): TimelineItem[] {
  const items: TimelineItem[] = []
  let next = 0
  function insertSteering(beforeSequence: number): void {
    while (next < steering.length) {
      const message = steering[next]!
      if ((message.steeringAfterStep ?? Number.MAX_SAFE_INTEGER) >= beforeSequence) break
      items.push({ kind: 'steering', id: message.id, message })
      next++
    }
  }
  for (const step of steps) {
    insertSteering(step.sequence)
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
        // 连续操作沿用父步骤身份，避免窗口更新重新挂载仍在查看的单条详情。
        id: `operations:${step.parentStepId ?? step.id}${previous?.kind === 'compaction' || previous?.kind === 'steering' ? `:after:${previous.id}` : ''}`,
        steps: [step],
      })
  }
  insertSteering(Infinity)
  return items
}

/** 下一模型阶段开始即结束上一操作组；窗口尾部不能代替执行的实际最新步骤。 */
export function currentOperationGroup(
  items: TimelineItem[],
  latest: ChatStep | undefined,
): string | null {
  if (!latest || !['tool_call', 'user_input'].includes(latest.type)) return null
  const groups = items.filter((item) => item.kind === 'operations')
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

/** 汇总已完成的动作类型；等待、失败及其他终态单独展示，不把失败归为完成。 */
export function operationSummary(
  steps: ChatStep[],
  connected = true,
): { label: string; notice: string; danger: boolean; waiting: boolean } {
  const actions: Record<string, string> = {
    read_file: '读取文件',
    list_directory: '查看目录',
    search_text: '搜索内容',
    apply_patch: '编辑文件',
    run_command: '运行了命令',
    request_user_input: '结束补充输入',
  }
  const completed = new Set<string>()
  const statuses = new Map<string, number>()
  for (const step of steps) {
    if (step.status === 'completed') completed.add(actions[step.name] ?? '执行其他操作')
    else statuses.set(step.status, (statuses.get(step.status) ?? 0) + 1)
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
  const waiting = statuses.has('awaiting_approval') || statuses.has('awaiting_user_input')
  if (connected && running) notices.push(`${running} 项正在执行`)
  if (!connected && (running || waiting)) notices.push('连接已断开，状态待核对')
  return {
    label: completed.size ? `已${[...completed].join('、')}` : '操作记录',
    notice: notices.join('、'),
    danger: statuses.has('failed') || statuses.has('interrupted'),
    waiting,
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
