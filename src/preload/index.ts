import { contextBridge, ipcRenderer } from 'electron'
import { parseAppInfo } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import {
  array,
  id,
  parseChatEvent,
  parseStepPage,
  parseStepDetails,
  parseDetail,
  parseMessage,
  parseOverview,
  parseResult,
  parseSendResult,
  parseResendResult,
  parseConversation,
  parseConversationPage,
  parseSelectedDirectory,
  parseWorkspace,
  parseWorkspacePage,
  parseUserInput,
  parseDirectoryGrant,
} from '../shared/chat'
import { parseCatalog } from '../shared/models'
import { parseExecutionSettings } from '../shared/execution'

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
  async copyMessage(text) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.copyMessage, text), boolean)
  },
  async openWebLink(url) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.openWebLink, url), boolean)
  },
  async getModelCatalog() {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.getModelCatalog), parseCatalog)
  },
  async getExecutionSettings() {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getExecutionSettings),
      parseExecutionSettings,
    )
  },
  async updateExecutionSettings(input) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.updateExecutionSettings, input),
      parseExecutionSettings,
    )
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
  async chooseWorkspaceDirectory() {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspaceDirectory),
      parseSelectedDirectory,
    )
  },
  async listWorkspaces(offset) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.listWorkspaces, offset),
      parseWorkspacePage,
    )
  },
  async getWorkspaceConversations(workspaceId, offset) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getWorkspaceConversations, workspaceId, offset),
      parseConversationPage,
    )
  },
  async createWorkspace(input) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.createWorkspace, input),
      parseWorkspace,
    )
  },
  async renameWorkspace(workspaceId, name) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.renameWorkspace, workspaceId, name),
      parseWorkspace,
    )
  },
  async deleteWorkspace(workspaceId) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.deleteWorkspace, workspaceId),
      parseWorkspace,
    )
  },
  async renameConversation(conversationId, title) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.renameConversation, conversationId, title),
      parseConversation,
    )
  },
  async deleteConversation(conversationId) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.deleteConversation, conversationId),
      parseConversation,
    )
  },
  async getEarlierMessages(conversationId, beforeSequence) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getEarlierMessages, conversationId, beforeSequence),
      (value) => array(value, parseMessage),
    )
  },
  async listRunSteps(conversationId, runId, afterSequence) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.listRunSteps, conversationId, runId, afterSequence),
      parseStepPage,
    )
  },
  async getStepDetails(conversationId, runId, stepId) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.getStepDetails, conversationId, runId, stepId),
      parseStepDetails,
    )
  },
  async sendMessage(input) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.sendMessage, input), parseSendResult)
  },
  async resendMessage(input) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.resendMessage, input),
      parseResendResult,
    )
  },
  async cancelRun(runId) {
    return parseResult(await ipcRenderer.invoke(IPC_CHANNELS.cancelRun, runId), boolean)
  },
  async submitUserInput(inputId, runId, answer) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.submitUserInput, inputId, runId, answer),
      parseUserInput,
    )
  },
  async decideApproval(approvalId, decision, scope = 'once') {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.decideApproval, approvalId, decision, scope),
      boolean,
    )
  },
  async listDirectoryGrants(conversationId, offset) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.listDirectoryGrants, conversationId, offset),
      (value) => array(value, parseDirectoryGrant),
    )
  },
  async revokeDirectoryGrant(conversationId, grantId) {
    return parseResult(
      await ipcRenderer.invoke(IPC_CHANNELS.revokeDirectoryGrant, conversationId, grantId),
      parseDirectoryGrant,
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
