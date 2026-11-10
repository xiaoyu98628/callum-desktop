import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  array,
  comparePinnedItems,
  id,
  isVisible,
  PAGE_SIZE,
  parseWorkspaceInput,
  parseWorkspaceChange,
} from '../../shared/chat.ts'
import type {
  ChatChange,
  ChatEvent,
  ConversationPage,
  Workspace,
  WorkspaceInput,
  WorkspaceChange,
  WorkspacePage,
  WorkspaceUpdate,
} from '../../shared/chat.ts'
import { conversationFromRpc, workspaceFromRpc } from './protocol-mapper.ts'
import type { MutationGate } from './mutation-gate.ts'
function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
}

/** 项目管理适配：目录复核及列表快照协调，不持有连接和执行缓存。 */
export class WorkspaceCatalog {
  private readonly request: (method: string, params: unknown) => Promise<unknown>
  private readonly gate: MutationGate
  private readonly events: {
    revision: () => number
    since: (revision: number) => ChatEvent[]
    publish: (change: ChatChange) => void
  }
  constructor(
    request: (method: string, params: unknown) => Promise<unknown>,
    gate: MutationGate,
    events: WorkspaceCatalog['events'],
  ) {
    this.request = request
    this.gate = gate
    this.events = events
  }
  async workspaceConversations(workspaceId: string, offset: number): Promise<ConversationPage> {
    const start = this.events.revision()
    const [workspace, rows] = await Promise.all([
      this.request('workspace.get', { id: workspaceId }),
      this.request('conversation.list', { workspace_id: workspaceId, limit: PAGE_SIZE, offset }),
    ])
    if (!isVisible(workspaceFromRpc(workspace))) throw new Error('项目已被删除或归档。')
    let conversations = array(rows ?? [], conversationFromRpc)
    const hasMore = conversations.length === PAGE_SIZE
    for (const { change } of this.events.since(start)) {
      if (change.kind === 'service') throw new Error(change.error)
      if (
        change.kind === 'workspace' &&
        change.value.id === workspaceId &&
        !isVisible(change.value)
      )
        throw new Error('项目已被删除或归档。')
      if (
        change.kind === 'conversation' &&
        (offset === 0 || conversations.some((item) => item.id === change.value.id))
      )
        conversations = upsert(conversations, change.value)
    }
    return {
      conversations: conversations
        .filter((item) => item.workspaceId === workspaceId && isVisible(item))
        .sort(comparePinnedItems),
      hasMore,
      revision: this.events.revision(),
    }
  }
  async listWorkspaces(offset: number): Promise<WorkspacePage> {
    const start = this.events.revision()
    let workspaces = array(
      (await this.request('workspace.list', { limit: PAGE_SIZE, offset })) ?? [],
      workspaceFromRpc,
    )
    const hasMore = workspaces.length === PAGE_SIZE
    for (const { change } of this.events.since(start)) {
      if (change.kind === 'service') throw new Error(change.error)
      if (
        change.kind === 'workspace' &&
        (offset === 0 || workspaces.some((item) => item.id === change.value.id))
      )
        workspaces = upsert(workspaces, change.value)
    }
    return {
      workspaces: workspaces.filter(isVisible).sort(comparePinnedItems),
      hasMore,
      revision: this.events.revision(),
    }
  }
  async createWorkspace(
    input: WorkspaceInput,
    selected?: ReadonlyMap<string, string>,
  ): Promise<Workspace> {
    const parsed = parseWorkspaceInput(input)
    const paths: string[] = []
    const seen = new Set<string>()
    for (const path of [parsed.rootPath, ...(parsed.otherPaths ?? [])]) {
      if (!path) continue
      if (selected && !selected.has(path)) throw new Error('请重新选择项目文件夹。')
      const directory = await resolveWorkspaceDirectory(path)
      if (selected && (path !== directory.path || selected.get(path) !== directory.identity))
        throw new Error('项目文件夹已变化，请重新选择。')
      if (seen.has(directory.identity)) throw new Error('项目文件夹不能重复。')
      seen.add(directory.identity)
      paths.push(directory.path)
    }
    const [rootPath = '', ...otherPaths] = paths
    return this.gate.run(rootPath ? `path:${rootPath}` : 'workspace:create-empty', async () => {
      const value = workspaceFromRpc(
        await this.request('workspace.create', {
          name: parsed.name,
          root_path: rootPath,
          other_paths: parsed.otherPaths === undefined ? undefined : otherPaths,
        }),
      )
      this.events.publish({ kind: 'workspace', value })
      return value
    })
  }
  async updateWorkspace(
    workspaceId: string,
    input: WorkspaceChange,
    selected?: ReadonlyMap<string, string>,
  ): Promise<WorkspaceUpdate> {
    const identifier = id(workspaceId)
    const parsed = parseWorkspaceChange(input)
    return this.gate.run(`workspace:${identifier}`, async () => {
      if (parsed.otherPaths !== undefined) {
        const current = workspaceFromRpc(await this.request('workspace.get', { id: identifier }))
        const folders = [current.rootPath, ...current.otherPaths].filter(Boolean)
        const known = new Set(folders)
        const expected = parsed.expectedFolders ?? []
        if (
          expected.length !== folders.length ||
          expected[0] !== folders[0] ||
          expected.some((path) => !known.has(path))
        )
          throw new Error('项目文件夹已更新，请重新打开项目编辑。')
        for (const path of [parsed.rootPath ?? '', ...parsed.otherPaths]) {
          if (!path) continue
          const directory = await resolveWorkspaceDirectory(path)
          if (
            directory.path !== path ||
            (selected && !known.has(path) && selected.get(path) !== directory.identity)
          )
            throw new Error('新增的项目文件夹必须重新通过选择器选择。')
        }
      } else if (parsed.rootPath !== undefined) {
        const directory = await resolveWorkspaceDirectory(parsed.rootPath)
        if (directory.path !== parsed.rootPath)
          throw new Error('项目文件夹已变化，请重新打开项目编辑。')
      }
      const workspace = workspaceFromRpc(
        await this.request('workspace.update', {
          id: identifier,
          name: parsed.name,
          root_path: parsed.rootPath,
          other_paths: parsed.otherPaths,
          expected_folders: parsed.expectedFolders,
        }),
      )
      this.events.publish({ kind: 'workspace', value: workspace })
      return { workspace, revision: this.events.revision() }
    })
  }
  async deleteWorkspace(workspaceId: string): Promise<Workspace> {
    return this.gate.run(`workspace:${workspaceId}`, async () => {
      const value = workspaceFromRpc(
        await this.request('workspace.delete', { id: id(workspaceId) }),
      )
      this.events.publish({ kind: 'workspace', value })
      return value
    })
  }
  async setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<WorkspaceUpdate> {
    if (typeof pinned !== 'boolean') throw new Error('项目置顶状态无效')
    return this.updateWorkspaceFlag(workspaceId, { pinned })
  }
  async setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<WorkspaceUpdate> {
    if (typeof archived !== 'boolean') throw new Error('项目归档状态无效')
    return this.updateWorkspaceFlag(workspaceId, { archived })
  }
  private async updateWorkspaceFlag(
    workspaceId: string,
    change: { pinned: boolean } | { archived: boolean },
  ): Promise<WorkspaceUpdate> {
    const identifier = id(workspaceId)
    return this.gate.run(`workspace:${identifier}`, async () => {
      const workspace = workspaceFromRpc(
        await this.request('workspace.update', { id: identifier, ...change }),
      )
      this.events.publish({ kind: 'workspace', value: workspace })
      return { workspace, revision: this.events.revision() }
    })
  }
  async archivedWorkspaces(offset: number): Promise<WorkspacePage> {
    const start = this.events.revision()
    let workspaces = array(
      (await this.request('workspace.list', { archived: true, limit: PAGE_SIZE, offset })) ?? [],
      workspaceFromRpc,
    )
    const hasMore = workspaces.length === PAGE_SIZE
    for (const { change } of this.events.since(start)) {
      if (change.kind === 'service') throw new Error(change.error)
      if (
        change.kind === 'workspace' &&
        (offset === 0 || workspaces.some((item) => item.id === change.value.id))
      )
        workspaces = upsert(workspaces, change.value)
    }
    return {
      workspaces: workspaces
        .filter((item) => item.archivedAt !== null && item.deletedAt === null)
        .sort(comparePinnedItems),
      hasMore,
      revision: this.events.revision(),
    }
  }
}
/** 选择和提交均校验实际目录，身份用于拒绝重复和选择后替换的目录。 */
export async function resolveWorkspaceDirectory(
  path: string,
): Promise<{ path: string; identity: string }> {
  if (!isAbsolute(path)) throw new Error('请选择项目的绝对路径。')
  let actual: string
  let info
  try {
    actual = await realpath(path)
    info = await stat(actual, { bigint: true })
  } catch {
    throw new Error('项目文件夹不可用，请重新选择。')
  }
  if (!info.isDirectory()) throw new Error('项目必须是文件夹。')
  return { path: actual, identity: `${info.dev}:${info.ino}` }
}
