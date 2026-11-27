import { computed, reactive, shallowRef, watch } from 'vue'
import { MAX_MESSAGE_LENGTH } from '../../../shared/chat.ts'
import type { FollowUpItem } from '../../../shared/follow-up.ts'
import { formatSkillPrefix } from '../../../shared/skills.ts'
import type { ConversationState, DraftSkill } from './state.ts'

const MAX_DRAFTS = 100
export interface FollowUpDraft {
  item: FollowUpItem
  text: string
}

/** 页面持有的未提交编辑统一计数；达到边界时保留旧编辑并拒绝新增，不静默淘汰。 */
export function createConversationDrafts(state: ConversationState) {
  const owners = new Map<string, string | null>()
  const editedFollowUps = reactive(new Map<string, FollowUpDraft>())
  // 未编辑的撤回草稿已持久化，只借用当前会话的一份，不进入本地编辑缓存。
  const serverDraft = shallowRef<FollowUpDraft>()
  const draftKey = () => state.selectedId ?? `new:${state.workspaceId ?? 'unbound'}`
  watch(
    () => state.selectedId,
    () => {
      serverDraft.value = undefined
    },
    { flush: 'sync' },
  )
  const followUpDraft = computed(() =>
    state.selectedId
      ? (editedFollowUps.get(state.selectedId) ??
        (serverDraft.value?.item.conversationId === state.selectedId
          ? serverDraft.value
          : undefined))
      : undefined,
  )
  function reserve(key: string, workspaceId: string | null): boolean {
    if (!owners.has(key) && owners.size >= MAX_DRAFTS) {
      state.error = '草稿数量已达上限，请发送或清空已有草稿。'
      return false
    }
    owners.set(key, workspaceId)
    return true
  }
  function releaseEmptyDraft(key: string): void {
    if (
      !state.drafts[key] &&
      !state.draftAttachments[key]?.length &&
      !state.draftSkills[key] &&
      !editedFollowUps.has(key)
    )
      owners.delete(key)
  }
  function clearOrdinary(key: string): void {
    delete state.drafts[key]
    delete state.draftAttachments[key]
    delete state.draftSkills[key]
    releaseEmptyDraft(key)
  }
  function forgetFollowUp(id: string): void {
    editedFollowUps.delete(id)
    if (serverDraft.value?.item.conversationId === id) serverDraft.value = undefined
    releaseEmptyDraft(id)
  }
  function clearConversation(id: string): void {
    forgetFollowUp(id)
    clearOrdinary(id)
  }
  function clearWorkspace(workspaceId: string): void {
    for (const [key, owner] of owners) if (owner === workspaceId) clearConversation(key)
    if (
      serverDraft.value?.item.conversationId === state.selectedId &&
      state.workspaceId === workspaceId
    )
      serverDraft.value = undefined
  }
  function rememberFollowUp(item: FollowUpItem, workspaceId: string | null): void {
    if (state.selectedId === item.conversationId) serverDraft.value = { item, text: item.text }
    if (owners.has(item.conversationId)) owners.set(item.conversationId, workspaceId)
    const cached = editedFollowUps.get(item.conversationId)
    if (cached && (cached.item.id !== item.id || cached.item.revision !== item.revision))
      state.error = '撤回草稿已在服务端变化，本地编辑已保留，请核对后重新操作。'
  }
  const draft = computed({
    get: () => followUpDraft.value?.text ?? state.drafts[draftKey()] ?? '',
    set: (value: string) => {
      const current = followUpDraft.value
      const key = draftKey()
      if (current) {
        if (value === current.text) return
        if (!reserve(key, state.workspaceId)) return
        editedFollowUps.set(key, { item: current.item, text: value })
      } else if (value) {
        if (!reserve(key, state.workspaceId)) return
        state.drafts[key] = value
      } else {
        delete state.drafts[key]
        releaseEmptyDraft(key)
      }
    },
  })
  const draftAttachments = computed(() =>
    followUpDraft.value ? [] : (state.draftAttachments[draftKey()] ?? []),
  )
  const draftSkill = computed(() => {
    const item = followUpDraft.value?.item
    return item
      ? item.skill
        ? { name: item.skill, path: '' }
        : null
      : (state.draftSkills[draftKey()] ?? null)
  })
  const prefix = computed(() => (draftSkill.value ? formatSkillPrefix(draftSkill.value) : ''))
  const draftMessageText = computed(() => {
    const skill = draftSkill.value
    const metadata = skill
      ? `\n\n${JSON.stringify({ skills: [{ type: 'skill', name: skill.name, path: skill.path }] })}`
      : ''
    return prefix.value + draft.value + metadata
  })
  const draftTextLimit = computed(() => MAX_MESSAGE_LENGTH - prefix.value.length)
  function selectDraftSkill(skill: DraftSkill): void {
    if (followUpDraft.value || !reserve(draftKey(), state.workspaceId)) return
    state.draftSkills[draftKey()] = skill
    delete state.drafts[draftKey()]
  }
  function removeDraftSkill(): void {
    if (followUpDraft.value || state.sending || state.resending || state.compacting) return
    delete state.draftSkills[draftKey()]
    releaseEmptyDraft(draftKey())
  }
  function moveConversation(id: string, workspaceId: string | null): void {
    if (owners.has(id)) owners.set(id, workspaceId)
  }
  function dispose(): void {
    for (const key of [...owners.keys()]) clearConversation(key)
    serverDraft.value = undefined
  }
  return {
    draftKey,
    followUpDraft,
    draft,
    draftAttachments,
    draftSkill,
    draftMessageText,
    draftTextLimit,
    selectDraftSkill,
    removeDraftSkill,
    reserve,
    releaseEmptyDraft,
    clearOrdinary,
    clearConversation,
    clearWorkspace,
    rememberFollowUp,
    forgetFollowUp,
    moveConversation,
    dispose,
  }
}
export type ConversationDrafts = ReturnType<typeof createConversationDrafts>
