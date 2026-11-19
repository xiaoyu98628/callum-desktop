import type { McpRequest, McpResponse } from '../../shared/mcp.ts'
import { parseMcpResponse } from '../../shared/mcp.ts'
import { record, string } from '../../shared/validation.ts'

type Request = (method: string, params: unknown) => Promise<unknown>

/** 将桌面操作映射为固定的 Go 接口，并把授权 URL 留在主进程。 */
export class McpService {
  private readonly request: Request
  constructor(request: Request) {
    this.request = request
  }

  async run(input: McpRequest, open: (url: string) => Promise<void>): Promise<McpResponse> {
    const { action, ...params } = input
    const method =
      action === 'start' || action === 'status' || action === 'cancel'
        ? `mcp.oauth.${action}`
        : `mcp.${action}`
    const value = await this.request(method, params)
    if (input.action === 'start') {
      try {
        const url = new URL(string(record(value).url))
        if (url.protocol !== 'https:' || url.username || url.password || url.hash)
          throw new Error('授权地址无效')
        await open(url.href)
      } catch {
        await this.request('mcp.oauth.cancel', { id: input.id }).catch(() => undefined)
        throw new Error('无法打开 MCP 授权页面，请重试。')
      }
    }
    return parseMcpResponse(action, action === 'save' ? record(value).id : value)
  }
}
