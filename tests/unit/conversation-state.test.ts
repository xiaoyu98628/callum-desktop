import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectScope } from 'vue'
import { createConversationState } from '../../src/renderer/features/conversation/state.ts'
import { createConversationLists } from '../../src/renderer/features/conversation/conversation-lists.ts'
import { createConversationDrafts } from '../../src/renderer/features/conversation/conversation-drafts.ts'
import { createConversationFollowUps } from '../../src/renderer/features/conversation/conversation-follow-ups.ts'
import type { ChatOverview, ChatResult, Conversation, ChatEvent } from '../../src/shared/chat.ts'
import type { FollowUpItem } from '../../src/shared/follow-up.ts'
const conversation: Conversation = {
  id: 'conversation',
  workspaceId: null,
  modelId: 'model',
  modelName: 'model',
  title: 'old',
  updatedAt: 1,
  pinnedAt: null,
  archivedAt: null,
  deletedAt: null,
}

test('查询期间变更按版本合并，迟到旧通知不撤销删除，删除同时清理撤回编辑', async (t) => {
  const previous = Reflect.get(globalThis, 'window')
  t.after(() => Reflect.set(globalThis, 'window', previous))
  let resolve!: (value: ChatResult<ChatOverview>) => void
  Reflect.set(globalThis, 'window', {
    callum: {
      getChatOverview: () =>
        new Promise((done) => {
          resolve = done
        }),
    },
  })
  const scope = effectScope()
  t.after(() => scope.stop())
  const state = createConversationState()
  const drafts = scope.run(() => createConversationDrafts(state))!
  state.selectedId = conversation.id
  drafts.rememberFollowUp(
    {
      id: 'follow',
      conversationId: conversation.id,
      revision: 1,
      state: 'draft',
      text: 'server',
      attachments: [],
    },
    null,
  )
  drafts.draft.value = 'local-edit'
  const lists = createConversationLists(state, {
    disposed: () => false,
    modelGeneration: () => 0,
    setModels: (models) => {
      state.models = models
    },
    recover: async () => {},
    newConversation: () => {
      state.selectedId = null
    },
    clearConversation: drafts.clearConversation,
    clearWorkspace: drafts.clearWorkspace,
    onConversation: () => {},
  })
  const loading = lists.refreshOverview()
  const changed: ChatEvent = {
    revision: 3,
    change: { kind: 'conversation', value: { ...conversation, title: 'new' } },
  }
  lists.receive(changed)
  lists.apply(changed)
  resolve({
    ok: true,
    value: { conversations: [conversation], models: [], revision: 1, hasMore: false },
  })
  await loading
  assert.equal(state.conversations[0]?.title, 'new')
  lists.apply({
    revision: 4,
    change: { kind: 'conversation', value: { ...conversation, deletedAt: 4 } },
  })
  lists.apply(changed)
  assert.deepEqual(state.conversations, [])
  state.selectedId = conversation.id
  assert.equal(drafts.draft.value, '')
  lists.dispose()
})

test('待发查询切换和销毁后迟到响应不改变新会话队列或恢复已删除草稿', async (t) => {
  const previous = Reflect.get(globalThis, 'window')
  t.after(() => Reflect.set(globalThis, 'window', previous))
  const resolvers: ((value: ChatResult<FollowUpItem[]>) => void)[] = []
  Reflect.set(globalThis, 'window', {
    callum: { listFollowUps: () => new Promise((done) => resolvers.push(done)) },
  })
  const scope = effectScope()
  t.after(() => scope.stop())
  const state = createConversationState()
  let selection = 0,
    disposed = false
  const controls = scope.run(() => {
    const drafts = createConversationDrafts(state)
    const queue = createConversationFollowUps(state, drafts, {
      selection: () => selection,
      disposed: () => disposed,
      activeRun: () => null,
    })
    return { drafts, queue }
  })!
  state.selectedId = 'a'
  selection++
  state.selectedId = 'b'
  selection++
  resolvers[0]!({
    ok: true,
    value: [
      { id: 'f', conversationId: 'a', state: 'draft', revision: 1, text: 'late', attachments: [] },
    ],
  })
  await Promise.resolve()
  assert.equal(controls.drafts.followUpDraft.value, undefined)
  disposed = true
  resolvers[1]!({
    ok: true,
    value: [
      {
        id: 'f2',
        conversationId: 'b',
        state: 'queued',
        revision: 1,
        text: 'late',
        attachments: [],
      },
    ],
  })
  await Promise.resolve()
  assert.deepEqual(controls.queue.followUps.value, [])
})
