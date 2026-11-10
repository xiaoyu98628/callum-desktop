import { integer, record } from './chat.ts'

export type ApprovalMode = 'request' | 'assist' | 'full'

export interface ExecutionSettings {
  revision: number
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'on-request' | 'always' | 'never'
  approvalsReviewer: 'user' | 'auto_review'
}

/** 客户端只提交已知的执行设置组合。 */
export function parseExecutionSettings(value: unknown): ExecutionSettings {
  const v = record(value)
  if (
    Object.keys(v).some(
      (key) => !['revision', 'sandboxMode', 'approvalPolicy', 'approvalsReviewer'].includes(key),
    )
  )
    throw new Error('执行设置参数无效')
  if (
    v.sandboxMode !== 'read-only' &&
    v.sandboxMode !== 'workspace-write' &&
    v.sandboxMode !== 'danger-full-access'
  )
    throw new Error('沙箱模式无效')
  if (
    v.approvalPolicy !== 'on-request' &&
    v.approvalPolicy !== 'always' &&
    v.approvalPolicy !== 'never'
  )
    throw new Error('审批策略无效')
  if (v.approvalsReviewer !== 'user' && v.approvalsReviewer !== 'auto_review')
    throw new Error('审批人无效')
  if (
    (v.sandboxMode === 'danger-full-access' &&
      (v.approvalPolicy !== 'never' || v.approvalsReviewer !== 'user')) ||
    (v.approvalsReviewer === 'auto_review' && v.approvalPolicy === 'never')
  )
    throw new Error('执行权限组合无效')
  return {
    revision: integer(v.revision, 1),
    sandboxMode: v.sandboxMode,
    approvalPolicy: v.approvalPolicy,
    approvalsReviewer: v.approvalsReviewer,
  }
}

export function executionSettingsFromRpc(value: unknown): ExecutionSettings {
  const v = record(value),
    execution = record(v.value)
  if (v.key !== 'execution') throw new Error('执行设置归属无效')
  return parseExecutionSettings({
    revision: v.revision,
    sandboxMode: execution.sandbox_mode,
    approvalPolicy: execution.approval_policy,
    approvalsReviewer: execution.approvals_reviewer,
  })
}

export function approvalMode(settings: ExecutionSettings): ApprovalMode | null {
  if (settings.sandboxMode === 'danger-full-access') return 'full'
  if (settings.approvalPolicy === 'never') return null
  return settings.approvalsReviewer === 'auto_review' ? 'assist' : 'request'
}

export function withApprovalMode(
  settings: ExecutionSettings,
  mode: ApprovalMode,
): ExecutionSettings {
  if (mode === 'full')
    return {
      revision: settings.revision,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    }
  return {
    revision: settings.revision,
    sandboxMode:
      settings.sandboxMode === 'danger-full-access' ? 'workspace-write' : settings.sandboxMode,
    approvalPolicy: settings.approvalPolicy === 'never' ? 'on-request' : settings.approvalPolicy,
    approvalsReviewer: mode === 'assist' ? 'auto_review' : 'user',
  }
}
