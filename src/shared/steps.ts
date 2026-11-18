import type { ChatStep } from './chat.ts'
import { elapsedStepTime } from './run-time.ts'

export const STEP_PAGE_SIZE = 50
export const STEP_TEXT_LIMIT = 512 * 1024
export const STEP_OUTPUT_LIMIT = 64 * 1024

const completedToolLabels: Record<string, string> = {
  read_file: '已读取',
  search_text: '已在',
  list_directory: '已查看目录',
  apply_patch: '已编辑',
}

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
    const size =
      step.input.length + step.text.length + step.output.length + (step.reasoning?.length ?? 0)
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

/** 单行工具状态仅依据服务端步骤；不将参数拒绝或未知终态显示为执行成功。 */
export function toolStepSummary(
  step: ChatStep,
  now: number,
  connected: boolean,
  hasTarget = true,
): { label: string; hideTarget: boolean; running: boolean } {
  if (
    !connected &&
    ['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(step.status)
  )
    return { label: '连接已断开 · 状态待核对', hideTarget: false, running: false }
  const running = step.status === 'running'
  let label = stepLabel(step)
  let hideTarget = false
  if (step.name === 'run_command') {
    const elapsed = elapsedStepTime(step, now)
    if (running) {
      label = '正在运行'
      if (elapsed !== null && elapsed >= 1000) {
        label = `命令已运行 ${Math.floor(elapsed / 1000)}s`
        hideTarget = true
      }
    } else if (step.status === 'completed') {
      // “在 N 秒内”采用向上取整，不能把 2.9 秒显示成在 2 秒内完成。
      label =
        elapsed !== null && elapsed >= 1000 ? `已在 ${Math.ceil(elapsed / 1000)}s 内运行` : '已运行'
    }
  } else if (step.status === 'completed' && hasTarget) {
    label = completedToolLabels[step.name] ?? label
  } else if (step.name === 'search_text' && running && hasTarget) label = '正在'
  return { label, hideTarget, running }
}

export function stepTarget(step: ChatStep): string {
  try {
    const input: unknown = JSON.parse(step.input)
    if (typeof input !== 'object' || input === null || !('arguments' in input)) return ''
    const args = input.arguments
    if (typeof args !== 'object' || args === null) return ''
    if (step.name === 'search_text' && 'query' in args && typeof args.query === 'string') {
      const path = 'path' in args && typeof args.path === 'string' ? args.path : ''
      return `${path ? pathName(path, parseStepParameters(step.input)?.actual_path) : '指定目录'} 中搜索 ${JSON.stringify(args.query)}`
    }
    if ('path' in args && typeof args.path === 'string') {
      const actual = parseStepParameters(step.input)?.actual_path
      return pathName(args.path, actual)
    }
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

function pathName(path: string, actual: unknown): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(typeof actual === 'string' ? actual : path)
  const normalized = windows ? path.replaceAll('\\', '/') : path
  return normalized.replace(/\/+$/, '').split('/').at(-1) || path
}

/** 文件标题优先展示服务端固定的实际路径；命令仍由详情保留完整参数边界。 */
export function stepTargetTitle(step: ChatStep): string {
  const parameters = parseStepParameters(step.input)
  const args = parameters?.arguments
  if (
    typeof args === 'object' &&
    args !== null &&
    'path' in args &&
    typeof args.path === 'string'
  ) {
    const path = typeof parameters?.actual_path === 'string' ? parameters.actual_path : args.path
    if (step.name === 'search_text' && 'query' in args && typeof args.query === 'string')
      return `在 ${path} 中搜索 ${JSON.stringify(args.query)}`
    return path
  }
  return stepTarget(step)
}

function parseStepParameters(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    if (typeof value !== 'object' || value === null || !('arguments' in value)) return null
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
    return result
  } catch {
    return null
  }
}

/** 常用参数优先展示规范化请求和实际位置；审计快照由界面另行展开。 */
export function stepParameters(input: string): string {
  const parameters = parseStepParameters(input)
  return parameters ? JSON.stringify(parameters, null, 2) : input
}

/** 按记录的实际路径选择命令展示语法，跨平台查看历史时仍使用原执行平台的格式。 */
export function commandStepInput(
  input: string,
): { command: string; cwd: string; prompt?: string } | null {
  const parameters = parseStepParameters(input)
  const args = parameters?.arguments
  if (typeof args !== 'object' || args === null || !('command' in args)) return null
  const command = args.command
  if (
    !Array.isArray(command) ||
    !command.length ||
    !command.every((arg) => typeof arg === 'string')
  )
    return null
  const cwd = typeof parameters?.actual_cwd === 'string' ? parameters.actual_cwd : ''
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd || command[0] || '')
  if (windows)
    return {
      command: `& ${command.map((arg: string) => `'${arg.replaceAll("'", "''")}'`).join(' ')}`,
      cwd,
      prompt: 'PS>',
    }
  return {
    command: command
      .map((arg: string) =>
        /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
      )
      .join(' '),
    cwd,
  }
}

function commandStream(value: unknown): { text: string; truncated: boolean } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('encoding' in value) ||
    !('data' in value) ||
    !('truncated' in value) ||
    typeof value.data !== 'string' ||
    typeof value.truncated !== 'boolean'
  )
    return null
  if (value.encoding === 'utf-8') return { text: value.data, truncated: value.truncated }
  if (value.encoding !== 'base64') return null
  return { text: '二进制输出，Base64 数据见原始记录。', truncated: value.truncated }
}

/** 工具返回值独立于上下文副本；不能用调用终态推断实际影响。 */
export function stepResult(output: string): {
  text: string
  outcome: string
  exitCode: number | null
  commandOutput?: { text: string; truncated: boolean }
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
    const view = { text: JSON.stringify(result, null, 2), outcome, exitCode }
    if (
      typeof result !== 'object' ||
      result === null ||
      !('stdout' in result) ||
      !('stderr' in result)
    )
      return view
    const stdout = commandStream(result.stdout),
      stderr = commandStream(result.stderr)
    if (!stdout || !stderr) return view
    return {
      ...view,
      commandOutput: {
        text: [stdout.text, stderr.text ? `[stderr]\n${stderr.text}` : '']
          .filter(Boolean)
          .join('\n'),
        truncated: stdout.truncated || stderr.truncated,
      },
    }
  } catch {
    return fallback
  }
}
