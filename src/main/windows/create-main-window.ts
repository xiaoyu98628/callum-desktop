import { BrowserWindow } from 'electron'
import { isTrustedRendererUrl } from '../security/renderer-policy'

export function createMainWindow(rendererUrl: string, preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    title: 'Callum',
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    show: false,
    backgroundColor: '#f8f9fb',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault()
  })
  window.on('page-title-updated', (event) => event.preventDefault())

  return window
}
