import type { ChatStep } from './chat.ts'

export const STEP_PAGE_SIZE = 50
export const STEP_TEXT_LIMIT = 512 * 1024
export const STEP_OUTPUT_LIMIT = 64 * 1024

/** 截取展示内容时不拆开 UTF-16 代理对，原始持久化数据不受影响。 */
export function truncateStepText(text: string, limit: number): string {
  const end = Math.min(text.length, limit)
  const code = text.charCodeAt(end - 1)
  return text.slice(0, end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
}

/** 仅约束窗口缓存；被移出的持久化步骤仍可分页查询，不影响正在执行的任务。 */
export function boundSteps(steps: ChatStep[]): ChatStep[] {
  const result: ChatStep[] = []
  let chars = 0
  for (const step of steps.toReversed()) {
    const size = step.input.length + step.text.length + step.output.length
    if (result.length >= 200 || chars + size > 4 * 1024 * 1024) continue
    result.push(step)
    chars += size
  }
  return result.reverse()
}

export function stepLabel(step: ChatStep): string {
  const actions: Record<string, string> = {
    read_file: '读取文件',
    list_directory: '查看目录',
    search_text: '搜索内容',
    apply_patch: '编辑文件',
    run_command: '运行命令',
    request_user_input: '补充输入',
  }
  if (step.type === 'user_input' && step.status === 'completed') return '补充输入已结束'
  const action = step.type === 'user_input' ? '补充输入' : (actions[step.name] ?? step.name)
  const labels: Record<string, string> = {
    pending: `等待${action}`,
    running: `正在${action}`,
    completed: `已${action}`,
    failed: `${action}失败`,
    cancelled: `${action}已取消`,
    interrupted: `${action}已中断`,
    awaiting_approval: `${action} · 等待审批`,
    awaiting_user_input: '等待补充输入',
  }
  return labels[step.status] ?? action
}

export function stepTarget(step: ChatStep): string {
  try {
    const input: unknown = JSON.parse(step.input)
    if (typeof input !== 'object' || input === null || !('arguments' in input)) return ''
    const args = input.arguments
    if (typeof args !== 'object' || args === null) return ''
    if (step.name === 'search_text' && 'query' in args && typeof args.query === 'string')
      return JSON.stringify(args.query)
    if ('path' in args && typeof args.path === 'string')
      return args.path.replace(/\/+$/, '').split('/').at(-1) || args.path
    if (
      'command' in args &&
      Array.isArray(args.command) &&
      args.command.every((s) => typeof s === 'string')
    )
      return args.command
        .map((arg: string) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
        .join(' ')
    if ('patch' in args && typeof args.patch === 'string')
      return [...args.patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)]
        .map((m) => m[1])
        .join('、')
  } catch {
    /* 历史记录缺少可识别参数时，详情仍可显示服务端保存的原文。 */
  }
  return ''
}

/** 常用参数优先展示规范化请求和实际位置；审计快照由界面另行展开。 */
export function stepParameters(input: string): string {
  try {
    const value: unknown = JSON.parse(input)
    if (typeof value !== 'object' || value === null || !('arguments' in value)) return input
    const request =
      'request' in value && typeof value.request === 'object' && value.request !== null
        ? value.request
        : null
    const argumentsValue = request && 'arguments' in request ? request.arguments : value.arguments
    const result: Record<string, unknown> = { arguments: argumentsValue }
    if (
      request &&
      'target' in request &&
      typeof request.target === 'object' &&
      request.target !== null &&
      'path' in request.target
    )
      result.actual_path = request.target.path
    if (
      request &&
      'details' in request &&
      typeof request.details === 'object' &&
      request.details !== null &&
      'cwd' in request.details
    )
      result.actual_cwd = request.details.cwd
    return JSON.stringify(result, null, 2)
  } catch {
    return input
  }
}

/** 工具返回值独立于上下文副本；不能用调用终态推断实际影响。 */
export function stepResult(output: string): {
  text: string
  outcome: string
  exitCode: number | null
} {
  const fallback = { text: output, outcome: '', exitCode: null }
  try {
    const value: unknown = JSON.parse(output)
    if (typeof value !== 'object' || value === null || !('result' in value)) return fallback
    let outcome = ''
    if (
      'operation' in value &&
      typeof value.operation === 'object' &&
      value.operation !== null &&
      'outcome' in value.operation
    ) {
      const labels: Record<string, string> = {
        none: '',
        not_applied: '操作尚未生效',
        applied: '操作已执行',
        partially_applied: '操作部分生效',
        unknown: '操作影响尚未确认',
      }
      if (typeof value.operation.outcome === 'string')
        outcome = labels[value.operation.outcome] ?? ''
    }
    const result = value.result
    const exitCode =
      typeof result === 'object' &&
      result !== null &&
      'exit_code' in result &&
      typeof result.exit_code === 'number' &&
      Number.isSafeInteger(result.exit_code)
        ? result.exit_code
        : null
    return { text: JSON.stringify(result, null, 2), outcome, exitCode }
  } catch {
    return fallback
  }
}
