import { app, clipboard, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { parseAppInfo } from '../../shared/desktop-api'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { MAX_CODE_LENGTH, parseCodeText, parseWebLink } from '../../shared/message-actions'
import { isTrustedRendererUrl } from '../security/renderer-policy'

export function registerAppHandlers(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
): () => void {
  const validSource = (event: IpcMainInvokeEvent, args: unknown[], count: number): boolean => {
    const window = getWindow()
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      !!event.senderFrame &&
      event.senderFrame === window.webContents.mainFrame &&
      isTrustedRendererUrl(event.senderFrame.url, rendererUrl) &&
      args.length === count
    )
  }
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event, ...args: unknown[]) => {
    if (!validSource(event, args, 0)) throw new Error('拒绝无效的应用信息请求')
    return parseAppInfo({ name: app.name, version: app.getVersion(), platform: process.platform })
  })
  ipcMain.handle(IPC_CHANNELS.copyCode, async (event, ...args: unknown[]) => {
    if (!validSource(event, args, 1)) throw new Error('拒绝无效的代码复制请求')
    try {
      const text = parseCodeText(args[0])
      if (Buffer.byteLength(text) > MAX_CODE_LENGTH)
        return { ok: false, error: '代码过长，无法复制。' }
      await clipboard.writeText(text)
      return { ok: true, value: true }
    } catch {
      return { ok: false, error: '代码复制失败，请重试。' }
    }
  })
  ipcMain.handle(IPC_CHANNELS.openWebLink, async (event, ...args: unknown[]) => {
    if (!validSource(event, args, 1)) throw new Error('拒绝无效的网页链接请求')
    try {
      const url = parseWebLink(args[0])
      if (process.platform === 'win32' && url.length > 2081)
        return { ok: false, error: '网页地址过长，无法打开。' }
      await shell.openExternal(url)
      return { ok: true, value: true }
    } catch {
      return { ok: false, error: '无法打开链接，仅支持有效的 HTTP 或 HTTPS 网页地址。' }
    }
  })
  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.getAppInfo)
    ipcMain.removeHandler(IPC_CHANNELS.copyCode)
    ipcMain.removeHandler(IPC_CHANNELS.openWebLink)
  }
}
