import { record } from './chat.ts'

interface SummaryField {
  label: string
  value: string
}
export interface ApprovalSummary {
  description: string
  fields: SummaryField[]
  recognized: boolean
}

/** 摘要只读取服务端固定快照中的展示字段；完整原文仍由面板提供，不据此生成审批请求。 */
export function approvalSummary(snapshot: string): ApprovalSummary {
  const fallback: ApprovalSummary = { description: '', fields: [], recognized: false }
  if (snapshot.length > 256 * 1024) return fallback
  try {
    const request = record(JSON.parse(snapshot) as unknown)
    const fields: SummaryField[] = []
    const add = (label: string, value: unknown): void => {
      if (typeof value === 'string' && value) fields.push({ label, value })
    }
    if (request.target !== undefined && request.target !== null) {
      const target = record(request.target)
      add('实际目标', target.path)
      if (target.requested_path !== target.path) add('请求路径', target.requested_path)
    }
    if (request.details !== undefined && request.details !== null) {
      const details = record(request.details)
      add('可执行文件', details.executable)
      add('工作目录', details.cwd)
    }
    const hasLocation = fields.length > 0
    if (request.arguments !== undefined && request.arguments !== null) {
      const command = record(request.arguments).command
      if (
        Array.isArray(command) &&
        command.length &&
        command.every((part) => typeof part === 'string')
      )
        add('命令参数', JSON.stringify(command))
    }
    return {
      description: typeof request.summary === 'string' ? request.summary : '',
      fields,
      recognized: hasLocation && request.plan == null,
    }
  } catch {
    return fallback
  }
}
