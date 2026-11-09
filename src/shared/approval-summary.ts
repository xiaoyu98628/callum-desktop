import { record } from './chat.ts'

interface SummaryField {
  label: string
  value: string
}
export interface ApprovalSummary {
  description: string
  fields: SummaryField[]
  recognized: boolean
  executionNotice?: string
}

/** 摘要只读取服务端固定快照中的展示字段；完整原文仍由面板提供，不据此生成审批请求。 */
export function approvalSummary(snapshot: string): ApprovalSummary {
  const fallback: ApprovalSummary = { description: '', fields: [], recognized: false }
  if (snapshot.length > 256 * 1024) return fallback
  try {
    const request = record(JSON.parse(snapshot) as unknown)
    const fields: SummaryField[] = []
    let executionNotice: string | undefined
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
      if (details.execution_boundary != null) {
        const boundary = record(details.execution_boundary)
        if (boundary.escalated === true && boundary.sandboxed === false) {
          executionNotice =
            '本次请求在沙箱外运行。批准后，此命令可使用当前系统用户的文件及网络权限；不会保存为后续命令授权。'
          add('执行方式', '本次沙箱外运行')
        } else if (boundary.sandboxed === true) {
          if (boundary.sandbox_mode === 'workspace-write') {
            executionNotice =
              '批准后，本次命令可修改或删除项目内的文件。命令仍在系统沙箱内运行，网络关闭。'
            add('执行方式', '沙箱内项目写入')
            if (Array.isArray(details.writable_roots)) add('可写项目', details.writable_roots[0])
          } else {
            executionNotice = '此命令在只读沙箱内运行，仅本次私有临时目录可写，网络关闭。'
            add('执行方式', '只读沙箱')
          }
          add('网络访问', '关闭')
        } else {
          executionNotice =
            '此命令未使用系统沙箱。批准只针对本次命令，使用当前系统用户的文件及网络权限。'
          add('执行方式', '未使用系统沙箱')
        }
        if (boundary.risk === 'destructive_command')
          add('审批原因', '识别到删除、权限修改等高风险命令')
        if (boundary.risk === 'sensitive_git_command')
          add('审批原因', '识别到会改变 Git 状态或发布内容的命令')
        if (boundary.risk === 'sandbox_backend_unsupported')
          add('审批原因', '此平台尚未接入系统沙箱')
        add('权限申请原因', details.justification)
      }
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
      ...(executionNotice ? { executionNotice } : {}),
    }
  } catch {
    return fallback
  }
}
