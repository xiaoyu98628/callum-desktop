import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, session } from 'electron'
import type { BrowserWindow } from 'electron'
import { registerAppHandlers } from './ipc/register-app-handlers'
import { registerChatHandlers } from './ipc/register-chat-handlers'
import { ChatService } from './backend/chat-service'
import { resolveBackendDataDirectory } from './backend/data-directory'
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

  const isolatedUserDataDirectory = process.env.CALLUM_USER_DATA_DIR || undefined
  const dataDirectory =
    isolatedUserDataDirectory ||
    (!app.isPackaged ? join(app.getPath('appData'), 'Callum Development') : undefined)
  if (dataDirectory) {
    if (!isAbsolute(dataDirectory)) throw new Error('CALLUM_USER_DATA_DIR 必须是绝对路径')
    // 会话目录必须在 ready 前配置，不能在这里异步等待文件系统后再设置。
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    const canonicalDirectory = realpathSync(dataDirectory)
    app.setPath('userData', canonicalDirectory)
    app.setPath('sessionData', canonicalDirectory)
  }

  // 后台模式只用于显式隔离数据目录的开发测试，不改变发布应用行为。
  const backgroundTest =
    !app.isPackaged && !!isolatedUserDataDirectory && process.env.CALLUM_TEST_BACKGROUND === '1'
  if (backgroundTest) {
    app.commandLine.appendSwitch('disable-renderer-backgrounding')
    app.commandLine.appendSwitch('disable-background-timer-throttling')
  }

  await app.whenReady()
  if (backgroundTest && process.platform === 'darwin') app.dock?.hide()
  const rendererUrl = resolveRendererUrl(
    app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
  )
  const rendererRoot = fileURLToPath(new URL('../renderer/', import.meta.url))
  const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
  let mainWindow: BrowserWindow | null = null
  const service = new ChatService(
    resolveBackendDataDirectory(
      app.getPath('home'),
      isolatedUserDataDirectory ? app.getPath('userData') : undefined,
    ),
    app.isPackaged
      ? process.resourcesPath
      : fileURLToPath(new URL('../../resources/', import.meta.url)),
  )
  const disposeProtocol = registerApplicationProtocol(rendererRoot)
  const disposeHandlers = registerAppHandlers(() => mainWindow, rendererUrl, service)
  const disposeChatHandlers = registerChatHandlers(() => mainWindow, rendererUrl, service)
  let shutdownComplete = false
  let shutdownTask: Promise<void> | null = null
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    shutdownTask ??= service
      .close()
      .catch(() => {
        console.error(
          JSON.stringify({ level: 'error', module: 'backend', message: '对话服务关闭失败' }),
        )
      })
      .finally(() => {
        shutdownComplete = true
        app.quit()
      })
  })

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  const openWindow = async (): Promise<void> => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!backgroundTest) {
        mainWindow.show()
        mainWindow.focus()
      }
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
      if (!window.isDestroyed() && !backgroundTest) window.show()
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
    disposeChatHandlers()
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
