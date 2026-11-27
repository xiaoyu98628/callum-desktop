import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectScope } from 'vue'
import { createConversationDrafts } from '../../src/renderer/features/conversation/conversation-drafts.ts'
import { createConversationState } from '../../src/renderer/features/conversation/state.ts'
import type { FollowUpItem } from '../../src/shared/follow-up.ts'

const item = (n: number): FollowUpItem => ({
  id: `follow-${n}`,
  conversationId: `conversation-${n}`,
  state: 'draft',
  revision: 1,
  text: `server-${n}`,
  attachments: [],
})

test('撤回草稿与普通草稿共用容量，拒绝新增编辑但保留全部旧编辑和持久草稿读取', (t) => {
  const scope = effectScope()
  t.after(() => scope.stop())
  scope.run(() => {
    const state = createConversationState()
    const drafts = createConversationDrafts(state)
    for (let n = 0; n < 100; n++) {
      state.selectedId = item(n).conversationId
      state.workspaceId = 'workspace'
      drafts.rememberFollowUp(item(n), state.workspaceId)
      drafts.draft.value = `edited-${n}`
    }
    state.selectedId = item(100).conversationId
    drafts.rememberFollowUp(item(100), 'workspace')
    assert.equal(drafts.draft.value, 'server-100')
    drafts.draft.value = 'must-not-replace-old-edit'
    assert.equal(drafts.draft.value, 'server-100')
    assert.match(state.error, /上限/)
    state.selectedId = item(0).conversationId
    drafts.rememberFollowUp(item(0), 'workspace')
    assert.equal(drafts.draft.value, 'edited-0')
    drafts.clearConversation(state.selectedId)
    state.selectedId = item(100).conversationId
    drafts.rememberFollowUp(item(100), 'workspace')
    drafts.draft.value = 'new-edit-after-release'
    assert.equal(drafts.draft.value, 'new-edit-after-release')
    state.selectedId = null
    drafts.draft.value = 'ordinary-over-capacity'
    assert.equal(drafts.draft.value, '')
    drafts.clearWorkspace('workspace')
    drafts.draft.value = 'ordinary-after-clear'
    assert.equal(drafts.draft.value, 'ordinary-after-clear')
  })
})

test('会话移动后删除旧项目保留草稿，删除新项目清理文字、附件、技能及撤回编辑', (t) => {
  const scope = effectScope()
  t.after(() => scope.stop())
  scope.run(() => {
    const state = createConversationState()
    const drafts = createConversationDrafts(state)
    state.selectedId = item(1).conversationId
    state.workspaceId = 'old'
    drafts.draft.value = 'ordinary'
    drafts.selectDraftSkill({ name: 'skill', path: '/controlled/skill' })
    drafts.draft.value = 'ordinary-with-skill'
    state.draftAttachments[state.selectedId] = [new File(['x'], 'controlled.txt')]
    drafts.rememberFollowUp(item(1), 'old')
    drafts.draft.value = 'unsaved-withdrawn'
    drafts.moveConversation(state.selectedId, 'new')
    state.workspaceId = 'new'
    drafts.clearWorkspace('old')
    assert.equal(drafts.draft.value, 'unsaved-withdrawn')
    drafts.clearWorkspace('new')
    assert.equal(drafts.followUpDraft.value, undefined)
    assert.equal(drafts.draft.value, '')
    assert.deepEqual(state.draftAttachments, {})
    assert.deepEqual(state.draftSkills, {})
    drafts.dispose()
  })
})

test('相同草稿快照不覆盖编辑，版本变化保留本地编辑并提示冲突，切换无残留服务快照', (t) => {
  const scope = effectScope()
  t.after(() => scope.stop())
  scope.run(() => {
    const state = createConversationState()
    const drafts = createConversationDrafts(state)
    state.selectedId = item(1).conversationId
    drafts.rememberFollowUp(item(1), null)
    drafts.draft.value = 'local'
    drafts.rememberFollowUp(item(1), null)
    assert.equal(drafts.draft.value, 'local')
    drafts.rememberFollowUp({ ...item(1), revision: 2, text: 'remote' }, null)
    assert.equal(drafts.draft.value, 'local')
    assert.equal(drafts.followUpDraft.value?.item.revision, 1)
    assert.match(state.error, /变化/)
    state.selectedId = item(2).conversationId
    assert.equal(drafts.followUpDraft.value, undefined)
    drafts.rememberFollowUp(item(2), null)
    drafts.forgetFollowUp(state.selectedId)
    assert.equal(drafts.followUpDraft.value, undefined)
  })
})
