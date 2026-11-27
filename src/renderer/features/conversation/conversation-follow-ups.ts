import { ref, watch } from 'vue'
import type { ChatRun } from '../../../shared/chat.ts'
import type { FollowUpChange, FollowUpItem } from '../../../shared/follow-up.ts'
import { getDesktopApi } from '../../lib/desktop.ts'
import { unwrap } from '../../lib/result.ts'
import type { ConversationDrafts } from './conversation-drafts.ts'
import type { ConversationState } from './state.ts'

/** 待发队列读取与操作共享选中会话令牌，迟到响应不改变新页面。 */
export function createConversationFollowUps(
  state: ConversationState,
  drafts: ConversationDrafts,
  hooks: {
    selection: () => number
    disposed: () => boolean
    activeRun: () => ChatRun | null
  },
) {
  const followUps = ref<FollowUpItem[]>([])
  const followUpError = ref('')
  const followUpBusy = ref(false)
  let followUpRequest = 0
  const rememberFollowUpDraft = (item: FollowUpItem) =>
    drafts.rememberFollowUp(item, state.workspaceId)

  async function loadFollowUps(): Promise<void> {
    const id = state.selectedId
    const request = ++followUpRequest
    if (!id || state.serviceError) return
    try {
      const items = unwrap(await getDesktopApi().listFollowUps(id))
      if (!hooks.disposed() && request === followUpRequest) {
        followUps.value = items.filter((item) => item.state === 'queued')
        const item = items.find((item) => item.state === 'draft')
        if (item) rememberFollowUpDraft(item)
        else drafts.forgetFollowUp(id)
      }
    } catch (error) {
      if (!hooks.disposed() && request === followUpRequest) followUpError.value = message(error)
    }
  }

  watch(
    () => [state.selectedId, state.serviceError],
    () => {
      followUps.value = []
      followUpError.value = ''
      void loadFollowUps()
    },
    { flush: 'sync' },
  )

  async function actOnFollowUp(
    item: FollowUpItem,
    action: FollowUpChange['action'] | 'start',
  ): Promise<boolean> {
    if (followUpBusy.value || state.selectedId !== item.conversationId || state.serviceError)
      return false
    if (action === 'withdraw' && (drafts.followUpDraft.value || state.editing)) return false
    const run = hooks.activeRun()
    if (action === 'steer' && (!run || run.status !== 'running' || run.compaction)) return false
    if (action === 'start' && run) return false
    const token = hooks.selection()
    const workspaceId = state.workspaceId
    followUpBusy.value = true
    followUpError.value = ''
    try {
      const api = getDesktopApi()
      const input = { id: item.id, conversationId: item.conversationId, revision: item.revision }
      if (action === 'start') {
        unwrap(await api.startFollowUp(input))
      } else {
        const updated = unwrap(
          await api.changeFollowUp({
            ...input,
            action,
            ...((action === 'steer' || action === 'restore_draft') && run
              ? { expectedRunId: run.id }
              : {}),
          }),
        )
        if (updated.state === 'draft') {
          // 废弃受理前的列表读取，避免快照在同一会话里撤销刚取出的草稿。
          drafts.rememberFollowUp(updated, workspaceId)
          if (token === hooks.selection()) {
            ++followUpRequest
            followUps.value = followUps.value.filter((row) => row.id !== updated.id)
          }
        } else if (action === 'restore_draft') drafts.forgetFollowUp(item.conversationId)
      }
      return token === hooks.selection()
    } catch (error) {
      if (token === hooks.selection()) followUpError.value = message(error)
      return false
    } finally {
      if (token === hooks.selection()) await loadFollowUps()
      followUpBusy.value = false
    }
  }

  return { followUps, followUpError, followUpBusy, loadFollowUps, actOnFollowUp }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : '无法完成待发消息操作，请重试。'
}
