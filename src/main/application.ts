import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, session } from 'electron'
import type { BrowserWindow } from 'electron'
import { registerAppHandlers } from './ipc/register-app-handlers'
import {
  registerApplicationProtocol,
  registerApplicationScheme,
} from './security/application-protocol'
import { resolveRendererUrl } from './security/renderer-policy'
import { createMainWindow } from './windows/create-main-window'

/** 装配应用级资源；窗口关闭与应用退出分别管理。 */
export async function startApplication(): Promise<void> {
  app.setName('Callum')
  registerApplicationScheme()

  const dataDirectory =
    process.env.CALLUM_USER_DATA_DIR ||
    (!app.isPackaged ? join(app.getPath('appData'), 'Callum Development') : undefined)
  if (dataDirectory) {
    if (!isAbsolute(dataDirectory)) throw new Error('CALLUM_USER_DATA_DIR 必须是绝对路径')
    // 会话目录必须在 ready 前配置，不能在这里异步等待文件系统后再设置。
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    const canonicalDirectory = realpathSync(dataDirectory)
    app.setPath('userData', canonicalDirectory)
    app.setPath('sessionData', canonicalDirectory)
  }

  await app.whenReady()
  const rendererUrl = resolveRendererUrl(
    app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
  )
  const rendererRoot = fileURLToPath(new URL('../renderer/', import.meta.url))
  const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
  let mainWindow: BrowserWindow | null = null
  const disposeProtocol = registerApplicationProtocol(rendererRoot)
  const disposeHandlers = registerAppHandlers(() => mainWindow, rendererUrl)

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  const openWindow = async (): Promise<void> => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      return
    }
    // 在 loadURL 发起前即可通过 IPC 校验来源，避免界面启动时的竞态。
    const window = createMainWindow(rendererUrl, preloadPath)
    mainWindow = window
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null
    })
    try {
      await window.loadURL(rendererUrl)
      if (!window.isDestroyed()) window.show()
    } catch (error) {
      // 用户在页面载入时关闭窗口会中断导航，不应因此退出整个 macOS 应用。
      if (window.isDestroyed()) return
      window.destroy()
      throw error
    }
  }

  app.on('activate', () => {
    void openWindow().catch(reportWindowError)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.once('will-quit', () => {
    disposeHandlers()
    disposeProtocol()
  })

  await openWindow()
}

function reportWindowError(error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'application',
      message: '窗口启动失败',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  app.quit()
}
