import { integer, record } from './chat.ts'

export interface ExecutionSettings {
  revision: number
  sandboxMode: 'read-only' | 'workspace-write'
  approvalPolicy: 'on-request' | 'always' | 'never'
}

/** 只允许客户端修改已展示的执行设置，审批人由服务端固定为 user。 */
export function parseExecutionSettings(value: unknown): ExecutionSettings {
  const v = record(value)
  if (Object.keys(v).some((key) => !['revision', 'sandboxMode', 'approvalPolicy'].includes(key)))
    throw new Error('执行设置参数无效')
  if (v.sandboxMode !== 'read-only' && v.sandboxMode !== 'workspace-write')
    throw new Error('沙箱模式无效')
  if (
    v.approvalPolicy !== 'on-request' &&
    v.approvalPolicy !== 'always' &&
    v.approvalPolicy !== 'never'
  )
    throw new Error('审批策略无效')
  return {
    revision: integer(v.revision, 1),
    sandboxMode: v.sandboxMode,
    approvalPolicy: v.approvalPolicy,
  }
}

export function executionSettingsFromRpc(value: unknown): ExecutionSettings {
  const v = record(value),
    execution = record(v.value)
  if (v.key !== 'execution' || execution.approvals_reviewer !== 'user')
    throw new Error('执行设置归属无效')
  return parseExecutionSettings({
    revision: v.revision,
    sandboxMode: execution.sandbox_mode,
    approvalPolicy: execution.approval_policy,
  })
}
