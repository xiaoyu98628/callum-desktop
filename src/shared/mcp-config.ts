import { mcpEnvironment, normalizeMcpOAuthScope } from './mcp.ts'
import type { McpSecrets, McpServer, McpServerView } from './mcp.ts'

export const MCP_JSON_EXAMPLE = JSON.stringify(
  { mcpServers: { 示例服务: { type: 'http', url: 'https://example.com/mcp' } } },
  null,
  2,
)

const transports = {
  stdio: 'stdio',
  http: 'streamable_http',
  'streamable-http': 'streamable_http',
  streamableHttp: 'streamable_http',
  streamable_http: 'streamable_http',
} as const

export interface McpConfigEntry {
  name: string
  value: unknown
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${field} 需要是 JSON 对象。`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${field} 需要是非空字符串。`)
  return value.trim()
}

function checkFields(value: Record<string, unknown>, allowed: string[]): void {
  const field = Object.keys(value).find((key) => !allowed.includes(key))
  if (field !== undefined) throw new Error(`不支持字段 ${JSON.stringify(field)}。`)
}

/** 读取候选项。各服务的字段在选中后单独校验，便于从多服务配置中导入有效项。 */
export function parseMcpConfig(text: string): McpConfigEntry[] {
  if (text.length > 512 * 1024 || new TextEncoder().encode(text).length > 512 * 1024)
    throw new Error('MCP JSON 超过 512 KiB。')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('MCP JSON 格式无效，请检查引号、逗号和括号。')
  }
  const root = object(parsed, 'MCP 配置')
  checkFields(root, ['mcpServers'])
  const entries = Object.entries(object(root.mcpServers, 'mcpServers'))
  if (!entries.length) throw new Error('mcpServers 中至少需要一个服务。')
  return entries.map(([name, value]) => ({ name, value }))
}

function absolutePath(value: unknown, field: string): string {
  const path = text(value, field)
  if (!/^(?:\/|[a-z]:[\\/]|\\\\[^\\])/i.test(path) || path.includes('\0'))
    throw new Error(`${field} 需要填写绝对路径。`)
  return path
}

function args(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error('args 需要是最多包含 64 项的字符串数组。')
  return value.map((arg: unknown) => {
    if (typeof arg !== 'string' || arg.includes('\0'))
      throw new Error('args 每一项都必须是有效字符串。')
    return arg
  })
}

function connectionURL(value: unknown): string {
  const raw = text(value, 'url')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('url 需要填写有效的 HTTPS 地址。')
  }
  if (
    !raw.startsWith('https://') ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    /[?#]/.test(raw) ||
    raw.includes('\\') ||
    new TextEncoder().encode(raw).length > 2048
  )
    throw new Error('url 需要填写 HTTPS 地址，地址中不可包含凭据、查询参数或片段。')
  return raw
}

function oauthRedirect(value: unknown): string {
  const raw = text(value, 'redirectUri')
  const match = /^http:\/\/127\.0\.0\.1:(\d+)(\/[^?#]*)$/.exec(raw)
  if (!match?.[1] || Number(match[1]) < 1 || Number(match[1]) > 65535)
    throw new Error('redirectUri 需要包含 127.0.0.1、固定端口和回调路径。')
  return raw
}

function bearerToken(input: unknown): string | undefined {
  const headers = Object.entries(object(input, 'headers'))
  if (!headers.length) return undefined
  const [key, value] = headers[0]!
  if (headers.length !== 1 || key.toLowerCase() !== 'authorization')
    throw new Error('headers 支持一个 Authorization Bearer 令牌。')
  const match = /^Bearer[ \t]+([^\s\0]+)$/i.exec(text(value, 'headers.Authorization'))
  if (!match?.[1] || new TextEncoder().encode(match[1]).length > 8192)
    throw new Error('headers.Authorization 需要使用 Bearer <访问令牌> 格式。')
  return match[1]
}

function saveEnvironment(
  source: Record<string, unknown>,
  server: McpServer,
  secrets: McpSecrets,
  current?: McpServerView | null,
): void {
  if (source.env === undefined) return
  const rawEnv = object(source.env, 'env')
  let environment: Record<string, string>
  try {
    environment = mcpEnvironment(rawEnv)
  } catch {
    throw new Error('env 需要使用有效的变量名，每个值都必须是字符串。')
  }
  const pairs = Object.entries(environment)
  if (
    pairs.length > 64 ||
    pairs.some(([, value]) => value.includes('\0') || new TextEncoder().encode(value).length > 4096)
  )
    throw new Error('env 最多支持 64 个变量，每个值最多 4096 字节。')
  const retained = pairs.filter(([key, value]) => current?.env?.[key] === value)
  const encrypted = pairs.filter(([key, value]) => current?.env?.[key] !== value)
  if (retained.length) server.env = Object.fromEntries(retained)
  if (encrypted.length || !pairs.length) secrets.env = Object.fromEntries(encrypted)
}

/** 把 JSON 配置投影到现有保存接口，明文凭据仅通过 secrets 交给 Go。 */
export function mcpConfigForSave(
  entry: McpConfigEntry,
  current?: McpServerView | null,
): { server: McpServer; secrets: McpSecrets; clear_scope?: true } {
  const name = text(entry.name, '服务名称')
  if (new TextEncoder().encode(name).length > 240) throw new Error('服务名称超过 240 字节。')
  const source = object(entry.value, '服务配置')
  const kind =
    source.type === undefined ? (source.url === undefined ? 'stdio' : 'http') : source.type
  if (typeof kind !== 'string' || !Object.hasOwn(transports, kind))
    throw new Error('type 需要使用 stdio 或 http（Streamable HTTP）。')
  const transport = transports[kind as keyof typeof transports]
  const server: McpServer = {
    id: current?.id ?? '',
    name,
    enabled: false,
    allowed_tools: current?.transport === transport ? [...current.allowed_tools] : [],
    transport,
    auth: 'none',
  }
  const secrets: McpSecrets = {}
  if (transport === 'stdio') {
    checkFields(source, ['type', 'command', 'args', 'cwd', 'env'])
    server.command = absolutePath(source.command, 'command')
    if (source.args !== undefined) server.args = args(source.args)
    if (source.cwd !== undefined) server.directory = absolutePath(source.cwd, 'cwd')
    saveEnvironment(source, server, secrets, current)
    return { server, secrets }
  }

  checkFields(source, ['type', 'url', 'headers', 'auth', 'clientId', 'redirectUri', 'scope'])
  server.url = connectionURL(source.url)
  const token = source.headers === undefined ? undefined : bearerToken(source.headers)
  const auth = source.auth === undefined ? (token === undefined ? 'none' : 'token') : source.auth
  if (auth !== 'none' && auth !== 'token' && auth !== 'oauth')
    throw new Error('auth 需要使用 none、token 或 oauth。')
  if (token !== undefined && auth !== 'token')
    throw new Error('Authorization Bearer 令牌需要使用 token 认证。')
  server.auth = auth
  if (token !== undefined) secrets.token = token
  if (auth === 'oauth') {
    if (source.clientId !== undefined) server.client_id = text(source.clientId, 'clientId')
    if (source.redirectUri !== undefined) server.redirect_uri = oauthRedirect(source.redirectUri)
    if (source.scope !== undefined) server.scope = normalizeMcpOAuthScope(source.scope)
  } else if (
    source.clientId !== undefined ||
    source.redirectUri !== undefined ||
    source.scope !== undefined
  ) {
    throw new Error('clientId、redirectUri 和 scope 需要使用 OAuth 认证。')
  }
  return auth === 'oauth' && current?.scope && server.scope === undefined
    ? { server, secrets, clear_scope: true }
    : { server, secrets }
}

/** 将保存过的非敏感配置以 mcpServers 格式回填，令牌及加密变量只显示状态。 */
export function editableMcpConfig(server: McpServerView): string {
  const config =
    server.transport === 'stdio'
      ? {
          type: 'stdio',
          command: server.command,
          args: server.args ?? [],
          cwd: server.directory || undefined,
          env: server.env,
        }
      : {
          type: 'http',
          url: server.url,
          auth: server.auth,
          clientId: server.client_id || undefined,
          redirectUri: server.redirect_uri || undefined,
          scope: server.scope || undefined,
        }
  return JSON.stringify({ mcpServers: { [server.name]: config } }, null, 2)
}
