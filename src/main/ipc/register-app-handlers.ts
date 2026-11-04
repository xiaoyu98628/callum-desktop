import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { parseAppInfo } from '../../shared/desktop-api'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { isTrustedRendererUrl } from '../security/renderer-policy'

export function registerAppHandlers(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
): () => void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event, ...args: unknown[]) => {
    const window = getWindow()
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame.url, rendererUrl) ||
      args.length !== 0
    ) {
      throw new Error('拒绝无效的应用信息请求')
    }
    return parseAppInfo({ name: app.name, version: app.getVersion(), platform: process.platform })
  })
  return () => ipcMain.removeHandler(IPC_CHANNELS.getAppInfo)
}
