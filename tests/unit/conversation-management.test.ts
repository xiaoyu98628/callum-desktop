import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import {
  comparePinnedItems,
  parseConversation,
  parseConversationUpdate,
  parseName,
  parseSendInput,
  parseWorkspaceInput,
  parseWorkspace,
  parseWorkspaceUpdate,
} from '../../src/shared/chat.ts'
import type { ChatEvent } from '../../src/shared/chat.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'

const uuid = '019a4f39-0000-7000-8000-000000000001'
test('置顶快照按后端顺序排序，跨进程拒绝损坏的状态和版本', () => {
  const item = parseConversation({
    id: uuid,
    workspaceId: null,
    title: '会话',
    modelId: uuid,
    modelName: '模型',
    updatedAt: 100,
    pinnedAt: null,
    deletedAt: null,
    archivedAt: null,
  })
  const pinned = { ...item, id: '019a4f39-0000-7000-8000-000000000002', updatedAt: 1, pinnedAt: 10 }
  assert.deepEqual(
    [item, pinned].sort(comparePinnedItems).map((value) => value.id),
    [pinned.id, item.id],
  )
  assert.ok(comparePinnedItems({ ...item, pinnedAt: 20 }, pinned) < 0)
  assert.ok(comparePinnedItems({ ...pinned, updatedAt: 2 }, pinned) < 0)
  assert.ok(
    comparePinnedItems({ ...pinned, id: '019a4f39-0000-7000-8000-000000000003' }, pinned) < 0,
  )
  assert.equal(
    parseConversationUpdate({ conversation: pinned, revision: 1 }).conversation.pinnedAt,
    10,
  )
  for (const pinnedAt of [undefined, '10', -1, 1.5])
    assert.throws(() => parseConversation({ ...item, pinnedAt }))
  for (const revision of [undefined, 0, -1, '1', 1.5])
    assert.throws(() => parseConversationUpdate({ conversation: item, revision }))
  const workspace = parseWorkspace({
    id: uuid,
    name: '项目',
    rootPath: '/tmp/project',
    updatedAt: 10,
    pinnedAt: null,
    deletedAt: null,
    archivedAt: null,
  })
  assert.equal(parseWorkspaceUpdate({ workspace, revision: 1 }).workspace.name, '项目')
  for (const pinnedAt of [undefined, '1', -1, 1.5])
    assert.throws(() => parseWorkspace({ ...workspace, pinnedAt }))
  for (const revision of [0, -1, '1', 1.5])
    assert.throws(() => parseWorkspaceUpdate({ workspace, revision }))
})
test('会话与工作区输入按 UTF-8 限制名称，拒绝未知字段及发送时改绑', () => {
  assert.equal(parseName(' 中文标题 '), '中文标题')
  assert.equal(parseName('中'.repeat(341)).length, 341)
  for (const value of ['', '  ', '中'.repeat(342), '名称\0', '标题\n第二行'])
    assert.throws(() => parseName(value))
  assert.throws(() => parseWorkspaceInput({ name: '工作区', rootPath: '/tmp', deleted: true }))
  assert.throws(() => parseWorkspaceInput({ name: '工作区', rootPath: '/tmp\0' }))
  assert.throws(() =>
    parseSendInput({ conversationId: uuid, workspaceId: uuid, modelId: uuid, text: '内容' }),
  )
  assert.equal(
    parseSendInput({ conversationId: null, workspaceId: uuid, modelId: uuid, text: '内容' })
      .workspaceId,
    uuid,
  )
})

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('未收到受控执行状态')
    await setTimeout(10)
  }
}

test(
  '真实 Go 管理：分组、人工标题、活动执行限制、软删除与重启恢复',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-management-test-'))
    let service: ChatService | undefined
    let upstream: Awaited<ReturnType<typeof startModelServer>> | undefined
    try {
      const folder = join(profile, 'workspace')
      await mkdir(folder)
      const file = join(folder, 'kept.txt')
      await writeFile(file, 'must remain', { mode: 0o600 })
      upstream = await startModelServer(file)
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      const workspace = await service.createWorkspace({ name: '工作区 A', rootPath: folder })
      await assert.rejects(
        service.createWorkspace({ name: '重复目录', rootPath: folder }),
        /工作区|存在|冲突/,
      )
      await assert.rejects(
        service.createWorkspace({ name: '相对目录', rootPath: 'relative' }),
        /绝对路径/,
      )
      await assert.rejects(service.createWorkspace({ name: '文件', rootPath: file }), /文件夹/)
      const run = await service.send({
        conversationId: null,
        workspaceId: workspace.id,
        modelId,
        text: '等待甲',
      })
      await until(() =>
        events.some(
          ({ change }) =>
            change.kind === 'run' &&
            change.value.id === run.runId &&
            change.value.status === 'running',
        ),
      )
      assert.equal((await service.overview(0)).conversations.length, 0)
      assert.equal(
        (await service.workspaceConversations(workspace.id, 0)).conversations[0]?.id,
        run.conversationId,
      )
      await assert.rejects(service.deleteConversation(run.conversationId), /执行/)
      const pinned = await service.setConversationPinned(run.conversationId, true)
      assert.ok(pinned.conversation.pinnedAt)
      assert.ok(pinned.revision > 0)
      await assert.rejects(service.setConversationArchived(run.conversationId, true), /执行/)
      assert.equal(
        (await service.workspaceConversations(workspace.id, 0)).conversations[0]?.archivedAt,
        null,
      )
      await assert.rejects(service.deleteWorkspace(workspace.id), /执行/)
      assert.ok((await service.setWorkspacePinned(workspace.id, true)).workspace.pinnedAt)
      await assert.rejects(service.setWorkspaceArchived(workspace.id, true), /执行/)
      assert.equal((await service.listWorkspaces(0)).workspaces[0]?.archivedAt, null)
      assert.equal(
        (await service.renameConversation(run.conversationId, '人工保留的标题')).title,
        '人工保留的标题',
      )
      assert.equal((await service.renameWorkspace(workspace.id, '工作区改名')).name, '工作区改名')
      await service.cancel(run.runId)
      await until(() =>
        events.some(
          ({ change }) =>
            change.kind === 'run' &&
            change.value.id === run.runId &&
            change.value.status === 'cancelled',
        ),
      )
      const unbound = await service.send({ conversationId: null, modelId, text: '独立对话' })
      await until(() =>
        events.some(
          ({ change }) =>
            change.kind === 'run' &&
            change.value.id === unbound.runId &&
            change.value.status === 'completed',
        ),
      )
      assert.equal((await service.overview(0)).conversations[0]?.id, unbound.conversationId)
      assert.equal((await service.detail(run.conversationId)).conversation.title, '人工保留的标题')
      await service.setConversationPinned(unbound.conversationId, true)
      await service.setConversationArchived(run.conversationId, true)
      await service.setConversationArchived(unbound.conversationId, true)
      assert.equal((await service.overview(0)).conversations.length, 0)
      assert.equal((await service.workspaceConversations(workspace.id, 0)).conversations.length, 0)
      assert.equal((await service.archivedConversations(0)).conversations.length, 2)
      await assert.rejects(service.detail(run.conversationId), /归档/)
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      service.subscribe((event) => events.push(event))
      assert.equal((await service.archivedConversations(0)).conversations.length, 2)
      const restoredProjectChat = await service.setConversationArchived(run.conversationId, false)
      assert.equal(restoredProjectChat.conversation.workspaceId, workspace.id)
      assert.ok(restoredProjectChat.conversation.pinnedAt)
      await service.setConversationArchived(unbound.conversationId, false)
      assert.equal((await service.overview(0)).conversations[0]?.id, unbound.conversationId)
      assert.equal((await service.archivedConversations(0)).conversations.length, 0)
      assert.ok((await service.detail(run.conversationId)).messages.length)
      assert.equal(
        (await service.setConversationPinned(run.conversationId, false)).conversation.pinnedAt,
        null,
      )
      // 在项目读取完成后暂停详情，确定性验证期间归档的项目状态会进入快照。
      const request: (method: string, params: unknown) => Promise<unknown> = Reflect.get(
        service,
        'request',
      ).bind(service)
      let releaseParent!: () => void, parentRead!: () => void
      const parentReady = new Promise<void>((resolve) => {
        parentRead = resolve
      })
      const parentGate = new Promise<void>((resolve) => {
        releaseParent = resolve
      })
      Reflect.set(service, 'request', async (method: string, params: unknown) => {
        const result = await request(method, params)
        if (method === 'workspace.get') {
          parentRead()
          await parentGate
        }
        return result
      })
      try {
        const details = service.detail(run.conversationId)
        void details.catch(() => undefined)
        await parentReady
        await service.setWorkspaceArchived(workspace.id, true)
        releaseParent()
        await assert.rejects(details, /项目|归档/)
      } finally {
        releaseParent()
        Reflect.set(service, 'request', request)
      }
      await service.setWorkspaceArchived(workspace.id, false)
      await service.setConversationArchived(run.conversationId, true)
      await service.setWorkspaceArchived(workspace.id, true)
      assert.equal((await service.listWorkspaces(0)).workspaces.length, 0)
      assert.equal((await service.archivedWorkspaces(0)).workspaces[0]?.id, workspace.id)
      await assert.rejects(service.workspaceConversations(workspace.id, 0), /归档/)
      await assert.rejects(service.setConversationArchived(run.conversationId, false), /项目|归档/)
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      service.subscribe((event) => events.push(event))
      assert.ok((await service.archivedWorkspaces(0)).workspaces[0]?.pinnedAt)
      const restoredWorkspace = await service.setWorkspaceArchived(workspace.id, false)
      assert.equal(restoredWorkspace.workspace.rootPath, await realpath(folder))
      assert.ok(restoredWorkspace.workspace.pinnedAt)
      await service.setConversationArchived(run.conversationId, false)
      assert.ok((await service.detail(run.conversationId)).messages.length)
      await service.setWorkspaceArchived(workspace.id, true)
      await assert.rejects(service.detail(run.conversationId), /项目|归档/)
      await service.setWorkspaceArchived(workspace.id, false)
      assert.equal((await service.setWorkspacePinned(workspace.id, false)).workspace.pinnedAt, null)
      const deleted = await service.deleteConversation(unbound.conversationId)
      assert.ok(deleted.deletedAt)
      assert.equal((await service.overview(0)).conversations.length, 0)
      await assert.rejects(service.detail(unbound.conversationId), /删除/)
      await service.deleteWorkspace(workspace.id)
      assert.equal((await service.listWorkspaces(0)).workspaces.length, 0)
      await assert.rejects(service.workspaceConversations(workspace.id, 0), /删除/)
      assert.equal(await readFile(file, 'utf8'), 'must remain')
      const restored = await service.createWorkspace({ name: '重新添加', rootPath: folder })
      assert.equal(restored.id, workspace.id)
      assert.equal(
        (await service.workspaceConversations(workspace.id, 0)).conversations[0]?.title,
        '人工保留的标题',
      )
      assert.ok(
        events.some(({ change }) => change.kind === 'workspace' && change.value.deletedAt !== null),
      )
      assert.ok(
        events.some(
          ({ change }) =>
            change.kind === 'conversation' && change.value.workspaceId === workspace.id,
        ),
      )
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      assert.equal((await service.listWorkspaces(0)).workspaces[0]?.name, '重新添加')
      assert.equal((await service.detail(run.conversationId)).conversation.title, '人工保留的标题')
    } finally {
      await service?.close()
      await upstream?.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)

test(
  '真实 Go 管理：工作区与所属会话分别分页，删除不会跨组污染',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-management-pages-'))
    let service: ChatService | undefined
    let upstream: Awaited<ReturnType<typeof startModelServer>> | undefined
    try {
      upstream = await startModelServer(join(profile, 'fixture.txt'))
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      for (let index = 0; index < 51; index++) {
        const rootPath = join(profile, `folder-${index}`)
        await mkdir(rootPath)
        await service.createWorkspace({ name: `工作区 ${index}`, rootPath })
      }
      const firstPage = await service.listWorkspaces(0)
      const nextPage = await service.listWorkspaces(50)
      assert.equal(firstPage.workspaces.length, 50)
      assert.equal(firstPage.hasMore, true)
      assert.equal(nextPage.workspaces.length, 1)
      assert.equal(
        new Set([...firstPage.workspaces, ...nextPage.workspaces].map((item) => item.id)).size,
        51,
      )
      const workspace = firstPage.workspaces[0]!
      for (let index = 0; index < 51; index++) {
        const run = await service.send({
          conversationId: null,
          workspaceId: workspace.id,
          modelId,
          text: `受控问题 ${index}`,
        })
        await until(() =>
          events.some(
            ({ change }) =>
              change.kind === 'run' &&
              change.value.id === run.runId &&
              change.value.status === 'completed',
          ),
        )
      }
      const conversations = await service.workspaceConversations(workspace.id, 0)
      const older = await service.workspaceConversations(workspace.id, 50)
      assert.equal(conversations.conversations.length, 50)
      assert.equal(conversations.hasMore, true)
      assert.equal(older.conversations.length, 1)
      assert.equal(
        new Set([...conversations.conversations, ...older.conversations].map((item) => item.id))
          .size,
        51,
      )
      assert.equal((await service.overview(0)).conversations.length, 0)
      assert.equal(
        (await service.workspaceConversations(nextPage.workspaces[0]!.id, 0)).conversations.length,
        0,
      )
      await service.deleteConversation(conversations.conversations[0]!.id)
      assert.equal((await service.workspaceConversations(workspace.id, 0)).conversations.length, 50)
      assert.equal((await service.workspaceConversations(workspace.id, 50)).conversations.length, 0)
      const remaining = (await service.workspaceConversations(workspace.id, 0)).conversations
      const last = remaining.at(-1)!
      await service.setConversationPinned(last.id, true)
      assert.equal(
        (await service.workspaceConversations(workspace.id, 0)).conversations[0]?.id,
        last.id,
      )
      for (const item of remaining) await service.setConversationArchived(item.id, true)
      const independent = await service.send({
        conversationId: null,
        modelId,
        text: '分页独立会话',
      })
      await until(() =>
        events.some(
          ({ change }) =>
            change.kind === 'run' &&
            change.value.id === independent.runId &&
            change.value.status === 'completed',
        ),
      )
      await service.setConversationArchived(independent.conversationId, true)
      const archived = await service.archivedConversations(0),
        nextArchived = await service.archivedConversations(50)
      assert.equal(archived.conversations.length, 50)
      assert.equal(archived.hasMore, true)
      assert.equal(archived.conversations[0]?.id, last.id)
      assert.equal(nextArchived.conversations.length, 1)
      assert.equal(
        new Set([...archived.conversations, ...nextArchived.conversations].map((item) => item.id))
          .size,
        51,
      )
      await service.setConversationArchived(last.id, false)
      assert.equal(
        (await service.workspaceConversations(workspace.id, 0)).conversations[0]?.id,
        last.id,
      )
      assert.equal((await service.archivedConversations(0)).conversations.length, 50)
      await service.deleteWorkspace(workspace.id)
      assert.equal((await service.archivedConversations(0)).conversations.length, 1)
      await assert.rejects(
        service.setConversationArchived(remaining[0]!.id, false),
        /项目|删除|恢复/,
      )
      const projects = [...firstPage.workspaces, ...nextPage.workspaces].filter(
        (item) => item.id !== workspace.id,
      )
      const extraRoot = join(profile, 'archived-extra')
      await mkdir(extraRoot)
      projects.push(await service.createWorkspace({ name: '分页归档项目', rootPath: extraRoot }))
      const oldestProject = projects.at(-2)!
      await service.setWorkspacePinned(oldestProject.id, true)
      assert.equal((await service.listWorkspaces(0)).workspaces[0]?.id, oldestProject.id)
      for (const item of projects) await service.setWorkspaceArchived(item.id, true)
      const archivedProjects = await service.archivedWorkspaces(0),
        nextProjects = await service.archivedWorkspaces(50)
      assert.equal(archivedProjects.workspaces.length, 50)
      assert.equal(archivedProjects.hasMore, true)
      assert.equal(nextProjects.workspaces.length, 1)
      assert.equal(archivedProjects.workspaces[0]?.id, oldestProject.id)
      assert.equal(
        new Set([...archivedProjects.workspaces, ...nextProjects.workspaces].map((item) => item.id))
          .size,
        51,
      )
      await service.setWorkspaceArchived(oldestProject.id, false)
      assert.equal((await service.listWorkspaces(0)).workspaces[0]?.id, oldestProject.id)
    } finally {
      await service?.close()
      await upstream?.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)
