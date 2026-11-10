import { isActiveRun } from '../../../shared/chat.ts'
import type {
  ApprovalScope,
  ChatRun,
  ChatUserInput,
  UserInputAnswer,
} from '../../../shared/chat.ts'
import type { ExecutionSettings } from '../../../shared/execution.ts'
import { getDesktopApi } from '../../lib/desktop.ts'
import type { ConversationState } from './state.ts'
import { unwrap, upsert } from './state-utils.ts'

/** 执行交互由根作用域持有；异步结果必须核对会话选择和销毁状态。 */
export function createExecutionInteractions(
  state: ConversationState,
  options: {
    selection: () => number
    disposed: () => boolean
    activeRun: () => ChatRun | null
    pendingInputs: () => ChatUserInput[]
  },
) {
  let executionSettingsRequest: Promise<ExecutionSettings | null> | null = null
  function rememberRun(run: ChatRun): void {
    if (isActiveRun(run)) {
      if (!state.activeRuns[run.conversationId] && Object.keys(state.activeRuns).length >= 64) {
        state.serviceError = '活动执行状态超出限制，请重新加载。'
        return
      }
      state.activeRuns[run.conversationId] = run
    } else if (state.activeRuns[run.conversationId]?.id === run.id)
      delete state.activeRuns[run.conversationId]
  }
  function setCardCollapsed(id: string, value: boolean): void {
    if (value) state.collapsedCards[id] = true
    else delete state.collapsedCards[id]
    const keys = Object.keys(state.collapsedCards)
    if (keys.length > 100 && keys[0]) delete state.collapsedCards[keys[0]]
  }
  function inputReply(id: string): UserInputAnswer {
    return state.inputReplies[id] ?? { optionIndex: null, text: '', skipped: false }
  }
  function setInputReply(id: string, value: UserInputAnswer): void {
    if (!options.pendingInputs().some((item) => item.id === id)) return
    state.inputReplies[id] = value
    const keys = Object.keys(state.inputReplies)
    if (keys.length > 100 && keys[0]) delete state.inputReplies[keys[0]]
  }
  function refreshExecutionSettings(): Promise<ExecutionSettings | null> {
    if (executionSettingsRequest) return executionSettingsRequest
    if (state.executionSettingsSaving) return Promise.resolve(null)
    state.executionSettingsLoading = true
    executionSettingsRequest = readExecutionSettings().finally(() => {
      executionSettingsRequest = null
      if (!options.disposed()) state.executionSettingsLoading = false
    })
    return executionSettingsRequest
  }
  async function readExecutionSettings(): Promise<ExecutionSettings | null> {
    try {
      const settings = unwrap(await getDesktopApi().getExecutionSettings())
      if (options.disposed()) return null
      state.executionSettings = settings
      state.executionSettingsError = ''
      return settings
    } catch (error) {
      if (!options.disposed()) state.executionSettingsError = message(error)
      return null
    }
  }
  async function saveExecutionSettings(next: ExecutionSettings): Promise<ExecutionSettings> {
    if (
      state.executionSettingsSaving ||
      state.executionSettingsLoading ||
      state.sending ||
      state.resending ||
      state.compacting ||
      state.serviceError
    )
      throw new Error('任务或权限设置正在更新，请稍后重试。')
    state.executionSettingsSaving = true
    try {
      const settings = unwrap(await getDesktopApi().updateExecutionSettings({ ...next }))
      if (!options.disposed()) {
        state.executionSettings = settings
        state.executionSettingsError = ''
      }
      return settings
    } catch (error) {
      if (!options.disposed()) state.executionSettingsError = message(error)
      throw error
    } finally {
      if (!options.disposed()) state.executionSettingsSaving = false
    }
  }
  async function cancel(): Promise<void> {
    const run = options.activeRun()
    if (!run || state.cancelling) return
    state.cancelling = true
    state.error = ''
    try {
      unwrap(await getDesktopApi().cancelRun(run.id))
    } catch (error) {
      if (run.conversationId === state.selectedId) state.error = message(error)
    } finally {
      if (run.conversationId === state.selectedId) state.cancelling = false
    }
  }
  async function decide(
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: ApprovalScope = 'once',
  ): Promise<void> {
    if (state.deciding) return
    state.deciding = approvalId
    state.error = ''
    const conversationId = state.selectedId
    try {
      unwrap(await getDesktopApi().decideApproval(approvalId, decision, scope))
    } catch (error) {
      if (conversationId === state.selectedId) state.error = message(error)
    } finally {
      state.deciding = ''
    }
  }
  async function loadDirectories(offset = 0): Promise<void> {
    const conversationId = state.selectedId
    if (!conversationId || state.directoriesLoading) return
    const currentSelection = options.selection()
    const before = new Map(state.detail?.directoryGrants.map((grant) => [grant.id, grant]))
    state.directoriesLoading = true
    state.directoriesError = ''
    try {
      const values = unwrap(await getDesktopApi().listDirectoryGrants(conversationId, offset))
      if (
        !options.disposed() &&
        options.selection() === currentSelection &&
        state.detail?.conversation.id === conversationId
      ) {
        // 查询期间收到的新增或撤销通知优先于早先生成的列表快照。
        const changed = state.detail.directoryGrants.filter(
          (grant) => before.get(grant.id) !== grant,
        )
        state.detail.directoryGrants = changed.reduce(
          (items, grant) => upsert(items, grant),
          values,
        )
        state.directoriesOffset = offset
      }
    } catch (error) {
      if (
        !options.disposed() &&
        options.selection() === currentSelection &&
        conversationId === state.selectedId
      )
        state.directoriesError = message(error)
    } finally {
      if (!options.disposed() && options.selection() === currentSelection)
        state.directoriesLoading = false
    }
  }
  async function revokeDirectory(grantId: string): Promise<void> {
    const conversationId = state.selectedId
    if (!conversationId || state.revokingDirectory) return
    state.revokingDirectory = grantId
    state.directoriesError = ''
    try {
      const value = unwrap(await getDesktopApi().revokeDirectoryGrant(conversationId, grantId))
      if (state.detail?.conversation.id === conversationId)
        state.detail.directoryGrants = upsert(state.detail.directoryGrants, value)
    } catch (error) {
      if (conversationId === state.selectedId) state.directoriesError = message(error)
    } finally {
      state.revokingDirectory = ''
    }
  }
  async function submitInput(inputId: string, skipped: boolean): Promise<void> {
    const input = options.pendingInputs().find((item) => item.id === inputId)
    const run = options.activeRun()
    if (
      !input ||
      !run ||
      run.id !== input.runId ||
      input.conversationId !== state.selectedId ||
      state.replying ||
      state.loading ||
      state.serviceError ||
      state.cancelling
    )
      return
    state.replying = inputId
    state.error = ''
    try {
      const reply = inputReply(inputId)
      // 跨进程只发送普通快照，不能把 Vue 的响应式代理交给 structured clone。
      const answer: UserInputAnswer = skipped
        ? { optionIndex: null, text: '', skipped: true }
        : { optionIndex: reply.optionIndex, text: reply.text, skipped: false }
      const result = unwrap(await getDesktopApi().submitUserInput(inputId, run.id, answer))
      if (!options.disposed()) {
        delete state.inputReplies[inputId]
        delete state.collapsedCards[inputId]
        if (state.detail?.conversation.id === input.conversationId)
          state.detail.userInputs = upsert(state.detail.userInputs, result).slice(-200)
      }
    } catch (error) {
      if (!options.disposed() && state.selectedId === input.conversationId)
        state.error = message(error)
    } finally {
      if (state.replying === inputId) state.replying = ''
    }
  }
  return {
    setCardCollapsed,
    inputReply,
    setInputReply,
    refreshExecutionSettings,
    saveExecutionSettings,
    cancel,
    decide,
    loadDirectories,
    revokeDirectory,
    submitInput,
    rememberRun,
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : '无法完成对话操作，请重试。'
}
