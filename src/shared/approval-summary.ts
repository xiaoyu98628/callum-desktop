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
    let recognizedPlan = false
    if (request.plan != null && request.target == null) {
      const plan = record(request.plan)
      if (Array.isArray(plan.targets) && plan.targets.length > 0 && plan.targets.length <= 32) {
        const targets = plan.targets.map(record)
        recognizedPlan = targets.every(
          (target) =>
            typeof target.path === 'string' &&
            target.path &&
            ['file', 'directory'].includes(String(target.kind)) &&
            ['create', 'update'].includes(String(target.action)),
        )
        if (recognizedPlan)
          for (const target of targets) {
            add(
              target.action === 'create'
                ? target.kind === 'directory'
                  ? '创建目录'
                  : '创建文件'
                : '修改文件',
              target.path,
            )
            if (target.requested_path !== target.path) add('请求路径', target.requested_path)
          }
      }
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
    if (request.tool != null) {
      const effects = record(request.tool).effects
      if (Array.isArray(effects)) {
        const labels: Record<string, string> = {
          destructive: '删除或大范围覆盖',
          external: '外发',
          unknown: '未知影响',
        }
        const warnings = effects
          .filter(
            (effect): effect is string =>
              typeof effect === 'string' && Object.hasOwn(labels, effect),
          )
          .map((effect) => labels[effect])
        if (warnings.length) add('操作影响', warnings.join('、'))
      }
    }
    return {
      description: typeof request.summary === 'string' ? request.summary : '',
      fields,
      recognized: hasLocation && (request.plan == null || recognizedPlan),
    }
  } catch {
    return fallback
  }
}
