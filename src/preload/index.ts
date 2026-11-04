import { contextBridge, ipcRenderer } from 'electron'
import { parseAppInfo } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'

const desktopApi: DesktopApi = {
  async getAppInfo() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.getAppInfo)
    return parseAppInfo(result)
  },
}

contextBridge.exposeInMainWorld('callum', Object.freeze(desktopApi))
