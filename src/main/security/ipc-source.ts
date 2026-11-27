import { isTrustedRendererUrl } from './renderer-policy.ts'

interface RendererFrame {
  readonly url: string
}
interface RendererContents {
  isDestroyed(): boolean
  readonly mainFrame: RendererFrame
}
interface RendererWindow {
  isDestroyed(): boolean
  readonly webContents: RendererContents
}
interface IpcSource {
  readonly sender: unknown
  readonly senderFrame: RendererFrame | null
}

/** 三组 IPC 共用主窗口、主 frame 与可信 URL 校验；参数和具体操作仍由各处理器验证。 */
export function isTrustedIpcSource(
  event: IpcSource,
  window: RendererWindow | null,
  rendererUrl: string,
): boolean {
  return (
    !!window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    event.sender === window.webContents &&
    !!event.senderFrame &&
    event.senderFrame === window.webContents.mainFrame &&
    isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
  )
}
