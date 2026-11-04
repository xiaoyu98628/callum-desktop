import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { id, integer, parseSendInput } from '../../shared/chat'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { publicChatError } from '../backend/chat-service'
import type { ChatService } from '../backend/chat-service'
import { isTrustedRendererUrl } from '../security/renderer-policy'
import { ChatEventDelivery } from './chat-event-delivery'
import { parseModelInput, parseProviderInput } from '../../shared/models'

export function registerChatHandlers(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  service: ChatService,
): () => void {
  const channels: string[] = []
  let active = false
  let target: WebContents | null = null
  const reset = (): void => {
    active = false
    delivery.reset()
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
  handle(IPC_CHANNELS.getModelCatalog, 0, () => service.catalog.list())
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
  handle(IPC_CHANNELS.sendMessage, 1, (input) => service.send(parseSendInput(input)))
  handle(IPC_CHANNELS.cancelRun, 1, (runId) => service.cancel(id(runId)))
  handle(IPC_CHANNELS.decideApproval, 2, (approvalId, decision) => {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('审批决定无效')
    return service.decide(id(approvalId), decision)
  })
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
