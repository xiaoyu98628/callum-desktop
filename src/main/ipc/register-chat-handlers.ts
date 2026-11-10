import { dialog, ipcMain } from 'electron'
import { basename } from 'node:path'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  id,
  integer,
  MAX_WORKSPACE_FOLDERS,
  parseName,
  parseSendInput,
  parseResendInput,
  parseCompactInput,
  parseWorkspaceInput,
  parseWorkspaceChange,
  parseUserInputAnswer,
} from '../../shared/chat'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { publicChatError, resolveWorkspaceDirectory } from '../backend/chat-service'
import type { ChatService } from '../backend/chat-service'
import { isTrustedRendererUrl } from '../security/renderer-policy'
import { ChatEventDelivery } from './chat-event-delivery'
import { parseModelInput, parseProviderInput } from '../../shared/models'
import { parseExecutionSettings } from '../../shared/execution'
import { parseContextUsageInput } from '../../shared/context-usage'

export function registerChatHandlers(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  service: ChatService,
): () => void {
  const channels: string[] = []
  let active = false
  let target: WebContents | null = null
  let selection: { id: string; paths: Map<string, string> } | null = null
  let choosingDirectory = false
  let creatingWorkspace = false
  const reset = (): void => {
    active = false
    delivery.reset()
    selection = null
  }
  const delivery = new ChatEventDelivery((token, event) => {
    if (target && !target.isDestroyed() && active) target.send(IPC_CHANNELS.chatEvent, token, event)
    else reset()
  })
  const validSource = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const window = getWindow()
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      !!event.senderFrame &&
      event.senderFrame === window.webContents.mainFrame &&
      isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
    )
  }
  const unbind = (): void => {
    target?.removeListener('did-start-loading', reset)
    target?.removeListener('destroyed', unbind)
    target = null
    reset()
  }
  const listen = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (!validSource(event) || args.length !== 1 || typeof args[0] !== 'boolean') return
    if (target !== event.sender) {
      unbind()
      target = event.sender
      target.on('did-start-loading', reset)
      target.once('destroyed', unbind)
    }
    delivery.reset()
    active = args[0]
  }
  const acknowledge = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (
      validSource(event) &&
      args.length === 1 &&
      typeof args[0] === 'number' &&
      Number.isSafeInteger(args[0]) &&
      args[0] > 0
    )
      delivery.acknowledge(args[0])
  }
  ipcMain.on(IPC_CHANNELS.chatListen, listen)
  ipcMain.on(IPC_CHANNELS.chatAcknowledge, acknowledge)
  const handle = (
    channel: string,
    count: number,
    action: (...args: unknown[]) => Promise<unknown>,
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!validSource(event) || args.length !== count) throw new Error('拒绝无效的对话请求')
      try {
        return { ok: true, value: await action(...args) }
      } catch (error) {
        return { ok: false, error: publicChatError(error) }
      }
    })
  }
  handle(IPC_CHANNELS.getChatOverview, 1, (offset) => {
    const page = integer(offset)
    if (page > 100_000) throw new Error('分页参数无效')
    if (delivery.overloaded) delivery.reset()
    return service.overview(page)
  })
  const pageOffset = (value: unknown): number => {
    const offset = integer(value)
    if (offset > 100_000) throw new Error('分页参数无效')
    return offset
  }
  handle(IPC_CHANNELS.chooseWorkspaceDirectories, 1, async (selectionId) => {
    const window = getWindow()
    if (
      !window ||
      window.isDestroyed() ||
      target !== window.webContents ||
      choosingDirectory ||
      creatingWorkspace ||
      typeof selectionId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(selectionId)
    )
      throw new Error('文件夹选择器当前不可用。')
    if (selection?.id !== selectionId) selection = { id: selectionId, paths: new Map() }
    const current = selection
    choosingDirectory = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '添加项目文件夹',
        buttonLabel: '添加',
        properties: ['openDirectory', 'multiSelections'],
      })
      if (result.canceled || window.isDestroyed() || selection !== current) return []
      if (result.filePaths.length > MAX_WORKSPACE_FOLDERS)
        throw new Error(`项目最多可添加 ${MAX_WORKSPACE_FOLDERS} 个文件夹。`)
      const paths = new Map(current.paths)
      const seen = new Set(paths.values())
      const added = []
      for (const selected of result.filePaths) {
        const { path, identity } = await resolveWorkspaceDirectory(selected)
        if (paths.has(path) || seen.has(identity)) continue
        paths.set(path, identity)
        seen.add(identity)
        added.push({ path, name: basename(path) || path })
      }
      if (paths.size > MAX_WORKSPACE_FOLDERS)
        throw new Error(`项目最多可添加 ${MAX_WORKSPACE_FOLDERS} 个文件夹。`)
      if (window.isDestroyed() || selection !== current) return []
      current.paths = paths
      return added
    } finally {
      choosingDirectory = false
    }
  })
  handle(IPC_CHANNELS.discardWorkspaceDirectories, 2, async (selectionId, path) => {
    if (selection && selection.id === selectionId) {
      if (path === undefined) selection = null
      else if (typeof path === 'string' && !choosingDirectory && !creatingWorkspace)
        selection.paths.delete(path)
    }
    return null
  })
  handle(IPC_CHANNELS.listWorkspaces, 1, (offset) => service.listWorkspaces(pageOffset(offset)))
  handle(IPC_CHANNELS.getWorkspaceConversations, 2, (workspaceId, offset) =>
    service.workspaceConversations(id(workspaceId), pageOffset(offset)),
  )
  handle(IPC_CHANNELS.createWorkspace, 2, async (input, selectionId) => {
    const parsed = parseWorkspaceInput(input)
    const current = selection?.id === selectionId ? selection : null
    if (
      (parsed.rootPath && (!current || current.id !== selectionId)) ||
      choosingDirectory ||
      creatingWorkspace
    )
      throw new Error('请重新选择项目文件夹。')
    creatingWorkspace = true
    try {
      const workspace = await service.createWorkspace(parsed, current?.paths ?? new Map())
      if (selection === current) selection = null
      return workspace
    } finally {
      creatingWorkspace = false
    }
  })
  handle(IPC_CHANNELS.updateWorkspace, 3, async (workspaceId, input, selectionId) => {
    const parsed = parseWorkspaceChange(input)
    if (choosingDirectory || creatingWorkspace) throw new Error('正在处理文件夹，请稍候。')
    const current = selection?.id === selectionId ? selection : null
    creatingWorkspace = true
    try {
      const result = await service.updateWorkspace(
        id(workspaceId),
        parsed,
        current?.paths ?? new Map(),
      )
      if (current && selection === current) selection = null
      return result
    } finally {
      creatingWorkspace = false
    }
  })
  handle(IPC_CHANNELS.deleteWorkspace, 1, (workspaceId) => service.deleteWorkspace(id(workspaceId)))
  handle(IPC_CHANNELS.setWorkspacePinned, 2, (workspaceId, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('项目置顶状态无效')
    return service.setWorkspacePinned(id(workspaceId), pinned)
  })
  handle(IPC_CHANNELS.setWorkspaceArchived, 2, (workspaceId, archived) => {
    if (typeof archived !== 'boolean') throw new Error('项目归档状态无效')
    return service.setWorkspaceArchived(id(workspaceId), archived)
  })
  handle(IPC_CHANNELS.listArchivedWorkspaces, 1, (offset) =>
    service.archivedWorkspaces(pageOffset(offset)),
  )
  handle(IPC_CHANNELS.renameConversation, 2, (conversationId, title) =>
    service.renameConversation(id(conversationId), parseName(title)),
  )
  handle(IPC_CHANNELS.deleteConversation, 1, (conversationId) =>
    service.deleteConversation(id(conversationId)),
  )
  handle(IPC_CHANNELS.setConversationPinned, 2, (conversationId, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('置顶状态无效')
    return service.setConversationPinned(id(conversationId), pinned)
  })
  handle(IPC_CHANNELS.setConversationArchived, 2, (conversationId, archived) => {
    if (typeof archived !== 'boolean') throw new Error('归档状态无效')
    return service.setConversationArchived(id(conversationId), archived)
  })
  handle(IPC_CHANNELS.listArchivedConversations, 1, (offset) =>
    service.archivedConversations(pageOffset(offset)),
  )
  handle(IPC_CHANNELS.getModelCatalog, 0, () => service.catalog.list())
  handle(IPC_CHANNELS.getExecutionSettings, 0, () => service.executionSettings())
  handle(IPC_CHANNELS.updateExecutionSettings, 1, (input) =>
    service.updateExecutionSettings(parseExecutionSettings(input)),
  )
  handle(IPC_CHANNELS.saveModelProvider, 1, (input) =>
    service.catalog.saveProvider(parseProviderInput(input)),
  )
  handle(IPC_CHANNELS.deleteModelProvider, 1, (providerId) =>
    service.catalog.deleteProvider(id(providerId)),
  )
  handle(IPC_CHANNELS.saveModel, 1, (input) => service.catalog.saveModel(parseModelInput(input)))
  handle(IPC_CHANNELS.setModelEnabled, 2, (modelId, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('模型启用状态无效')
    return service.catalog.setEnabled(id(modelId), enabled)
  })
  handle(IPC_CHANNELS.deleteModel, 1, (modelId) => service.catalog.deleteModel(id(modelId)))
  handle(IPC_CHANNELS.getConversation, 1, (conversationId) => service.detail(id(conversationId)))
  handle(IPC_CHANNELS.getEarlierMessages, 2, (conversationId, beforeSequence) =>
    service.earlier(id(conversationId), integer(beforeSequence, 1)),
  )
  handle(IPC_CHANNELS.getConversationHistory, 2, (conversationId, beforeRunId) =>
    service.historyPage(id(conversationId), id(beforeRunId)),
  )
  handle(IPC_CHANNELS.listRunSteps, 3, (conversationId, runId, afterSequence) =>
    service.listSteps(id(conversationId), id(runId), integer(afterSequence)),
  )
  handle(IPC_CHANNELS.getStepDetails, 3, (conversationId, runId, stepId) =>
    service.stepDetails(id(conversationId), id(runId), id(stepId)),
  )
  handle(IPC_CHANNELS.sendMessage, 1, (input) => service.send(parseSendInput(input)))
  handle(IPC_CHANNELS.getContextUsage, 1, (input) =>
    service.contextUsage(parseContextUsageInput(input)),
  )
  handle(IPC_CHANNELS.resendMessage, 1, (input) => service.resend(parseResendInput(input)))
  handle(IPC_CHANNELS.compactConversation, 1, (input) => service.compact(parseCompactInput(input)))
  handle(IPC_CHANNELS.cancelRun, 1, (runId) => service.cancel(id(runId)))
  handle(IPC_CHANNELS.submitUserInput, 3, (inputId, runId, answer) =>
    service.submitUserInput(id(inputId), id(runId), parseUserInputAnswer(answer)),
  )
  handle(IPC_CHANNELS.decideApproval, 3, (approvalId, decision, scope) => {
    if (scope !== 'once' && scope !== 'conversation_directory') throw new Error('审批范围无效')
    if (decision !== 'approved' && scope !== 'once') throw new Error('拒绝不能授予目录权限')
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('审批决定无效')
    return service.decide(id(approvalId), decision, scope)
  })
  handle(IPC_CHANNELS.listDirectoryGrants, 2, (conversationId, offset) =>
    service.directories(id(conversationId), integer(offset)),
  )
  handle(IPC_CHANNELS.revokeDirectoryGrant, 2, (conversationId, grantId) =>
    service.revokeDirectory(id(conversationId), id(grantId)),
  )
  const unsubscribe = service.subscribe((event) => {
    const window = getWindow()
    if (
      window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      isTrustedRendererUrl(window.webContents.getURL(), rendererUrl) &&
      active &&
      target === window.webContents
    )
      delivery.offer(event)
  })
  return () => {
    unsubscribe()
    unbind()
    ipcMain.removeListener(IPC_CHANNELS.chatListen, listen)
    ipcMain.removeListener(IPC_CHANNELS.chatAcknowledge, acknowledge)
    channels.forEach((channel) => ipcMain.removeHandler(channel))
  }
}
