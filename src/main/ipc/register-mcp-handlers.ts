import type { BrowserWindow } from 'electron'
import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { parseMcpRequest } from '../../shared/mcp'
import type { McpService } from '../backend/mcp-service'
import { RpcError } from '../backend/rpc-client'
import { isTrustedIpcSource } from '../security/ipc-source'

export function registerMcpHandlers(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  service: McpService,
): () => void {
  ipcMain.handle(IPC_CHANNELS.mcp, async (event, ...args: unknown[]) => {
    if (!isTrustedIpcSource(event, getWindow(), rendererUrl) || args.length !== 1)
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
