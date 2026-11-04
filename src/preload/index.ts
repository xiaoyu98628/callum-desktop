import { contextBridge, ipcRenderer } from 'electron'
import { parseAppInfo } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import {
  array,
  id,
  parseChatEvent,
  parseDetail,
  parseMessage,
  parseOverview,
  parseResult,
  parseSendResult,
} from '../shared/chat'
import { parseCatalog } from '../shared/models'

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('无效的操作结果')
  return value
}

let subscribed = false
const desktopApi: DesktopApi = {
  async getAppInfo() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.getAppInfo)
    return parseAppInfo(result)
  },
  async copyCode(text) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.copyCode, text), boolean)
  },
  async openWebLink(url) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.openWebLink, url), boolean)
  },
  async getModelCatalog() {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.getModelCatalog), parseCatalog)
  },
  async saveModelProvider(input) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.saveModelProvider, input), id)
  },
  async deleteModelProvider(providerId) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.deleteModelProvider, providerId), id)
  },
  async saveModel(input) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.saveModel, input), id)
  },
  async setModelEnabled(modelId, enabled) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.setModelEnabled, modelId, enabled), id)
  },
  async deleteModel(modelId) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.deleteModel, modelId), id)
  },
  async getChatOverview(offset) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getChatOverview, offset),
      parseOverview,
    )
  },
  async getConversation(conversationId) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getConversation, conversationId),
      parseDetail,
    )
  },
  async getEarlierMessages(conversationId, beforeSequence) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getEarlierMessages, conversationId, beforeSequence),
      (value) => array(value, parseMessage),
    )
  },
  async sendMessage(input) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.sendMessage, input), parseSendResult)
  },
  async cancelRun(runId) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.cancelRun, runId), boolean)
  },
  async decideApproval(approvalId, decision) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.decideApproval, approvalId, decision),
      boolean,
    )
  },
  onChatEvent(listener) {
    if (subscribed) throw new Error('当前窗口已订阅对话通知')
    if (typeof listener !== 'function') throw new Error('无效的对话通知订阅')
    subscribed = true
    let listening = true
    const callback = (_event: Electron.IpcRendererEvent, token: number, value: unknown): void => {
      try {
        listener(parseChatEvent(value))
      } finally {
        ipcRenderer.send(IPC_CHANNELS.chatAcknowledge, token)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.chatEvent, callback)
    ipcRenderer.send(IPC_CHANNELS.chatListen, true)
    return () => {
      if (!listening) return
      listening = false
      subscribed = false
      ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, callback)
      ipcRenderer.send(IPC_CHANNELS.chatListen, false)
    }
  },
}

contextBridge.exposeInMainWorld('callum', Object.freeze(desktopApi))
