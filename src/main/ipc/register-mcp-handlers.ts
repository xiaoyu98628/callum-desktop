import { ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { parseMcpRequest } from '../../shared/mcp'
import { isTrustedRendererUrl } from '../security/renderer-policy'
import type { McpService } from '../backend/mcp-service'
import { RpcError } from '../backend/rpc-client'

export function registerMcpHandlers(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  service: McpService,
): () => void {
  ipcMain.handle(IPC_CHANNELS.mcp, async (event, ...args: unknown[]) => {
    const window = getWindow()
    const frame = event.senderFrame
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      frame !== window.webContents.mainFrame ||
      !isTrustedRendererUrl(frame.url, rendererUrl) ||
      args.length !== 1
    )
      throw new Error('拒绝无效的 MCP 请求')
    try {
      const input = parseMcpRequest(args[0])
      const value = await service.run(input, (url) => shell.openExternal(url))
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RpcError && error.code === 3010
            ? 'MCP 设置已在其他位置修改，请刷新后重试。'
            : error instanceof RpcError && error.code === -32601
              ? '当前 Go 服务程序版本未提供 MCP 接口。'
              : error instanceof RpcError
                ? error.message
                : '无法完成 MCP 操作，请检查配置或重试。',
      }
    }
  })
  return () => ipcMain.removeHandler(IPC_CHANNELS.mcp)
}
