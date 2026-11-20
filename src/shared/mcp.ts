import { array, id, integer, record, string } from './validation.ts'

export interface McpServer {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'streamable_http'
  auth: 'none' | 'token' | 'oauth'
  command?: string
  args?: string[]
  directory?: string
  env?: Record<string, string>
  url?: string
  client_id?: string
  redirect_uri?: string
  scope?: string
  allowed_tools: string[]
}

export interface McpTool {
  name: string
  description: string
}

export interface McpServerView extends McpServer {
  connected: boolean
  authorized: boolean
  expires_at?: number
  secret_env_keys: string[]
  tools: McpTool[]
}

export interface McpCatalog {
  revision: number
  servers: McpServerView[]
  scope_update?: boolean
}

export interface McpOAuthState {
  status: 'idle' | 'pending' | 'authorized' | 'cancelled' | 'failed'
  message?: string
}

export type McpRequest =
  | { action: 'list' }
  | {
      action: 'save'
      revision: number
      server: McpServer
      secrets: McpSecrets
      confirmed: boolean
      clear_scope?: boolean
    }
  | { action: 'delete'; id: string; revision: number }
  | { action: 'test'; id: string; confirmed: boolean; revision: number }
  | { action: 'start' | 'status' | 'cancel' | 'disconnect'; id: string }

export interface McpSecrets {
  token?: string
  env?: Record<string, string>
}

export type McpResponse = McpCatalog | McpTool[] | McpOAuthState | string | true

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('MCP 开关格式无效')
  return value
}

export function mcpEnvironment(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, val]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error('环境变量名称无效')
      return [key, string(val)]
    }),
  )
}

/** 校验 OAuth 权限名并按 Go 服务的规则规范化。 */
export function normalizeMcpOAuthScope(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[^\x20-\x21\x23-\x5b\x5d-\x7e]/.test(value)
  ) {
    throw new Error('scope 需要填写由空格分隔的 OAuth 权限名称，最多 1024 个字符。')
  }
  const scopes = value.split(' ').filter(Boolean)
  if (!scopes.length) throw new Error('scope 至少需要填写一个 OAuth 权限名称。')
  return [...new Set(scopes)].sort().join(' ')
}

export function parseMcpServer(value: unknown): McpServer {
  const v = record(value)
  if (v.transport !== 'stdio' && v.transport !== 'streamable_http')
    throw new Error('MCP 连接方式无效')
  if (v.auth !== 'none' && v.auth !== 'token' && v.auth !== 'oauth')
    throw new Error('MCP 认证方式无效')
  if (v.scope !== undefined && (v.transport !== 'streamable_http' || v.auth !== 'oauth'))
    throw new Error('scope 需要使用远程 OAuth 认证。')
  return {
    id: v.id === '' ? '' : id(v.id),
    name: string(v.name),
    transport: v.transport,
    auth: v.auth,
    enabled: flag(v.enabled),
    allowed_tools: array(v.allowed_tools, string),
    ...(v.command !== undefined ? { command: string(v.command) } : {}),
    ...(v.directory !== undefined ? { directory: string(v.directory) } : {}),
    ...(v.args !== undefined ? { args: array(v.args, string) } : {}),
    ...(v.env !== undefined ? { env: mcpEnvironment(v.env) } : {}),
    ...(v.url !== undefined ? { url: string(v.url) } : {}),
    ...(v.client_id !== undefined ? { client_id: string(v.client_id) } : {}),
    ...(v.redirect_uri !== undefined ? { redirect_uri: string(v.redirect_uri) } : {}),
    ...(v.scope !== undefined ? { scope: normalizeMcpOAuthScope(v.scope) } : {}),
  }
}

function parseSecrets(value: unknown): McpSecrets {
  const v = record(value)
  return {
    ...(v.token !== undefined ? { token: string(v.token) } : {}),
    ...(v.env !== undefined ? { env: mcpEnvironment(v.env) } : {}),
  }
}

export function parseMcpRequest(value: unknown): McpRequest {
  const v = record(value)
  switch (v.action) {
    case 'list':
      return { action: v.action }
    case 'save':
      return {
        action: v.action,
        revision: integer(v.revision, 1),
        server: parseMcpServer(v.server),
        secrets: parseSecrets(v.secrets),
        confirmed: flag(v.confirmed),
        ...(v.clear_scope !== undefined ? { clear_scope: flag(v.clear_scope) } : {}),
      }
    case 'delete':
      return { action: v.action, id: id(v.id), revision: integer(v.revision, 1) }
    case 'test':
      return {
        action: v.action,
        id: id(v.id),
        confirmed: flag(v.confirmed),
        revision: integer(v.revision, 1),
      }
    case 'start':
    case 'status':
    case 'cancel':
    case 'disconnect':
      return { action: v.action, id: id(v.id) }
    default:
      throw new Error('MCP 请求无效')
  }
}

export function parseMcpTools(value: unknown): McpTool[] {
  return array(value, (item) => {
    const v = record(item)
    return { name: string(v.name), description: string(v.description) }
  })
}

export function parseMcpCatalog(value: unknown): McpCatalog {
  const v = record(value)
  return {
    revision: integer(v.revision, 1),
    ...(v.scope_update !== undefined ? { scope_update: flag(v.scope_update) } : {}),
    servers: array(v.servers, (item) => {
      const server = record(item)
      return {
        ...parseMcpServer(server),
        connected: flag(server.connected),
        authorized: flag(server.authorized),
        ...(server.expires_at === undefined ? {} : { expires_at: integer(server.expires_at) }),
        secret_env_keys: array(server.secret_env_keys, string),
        tools: parseMcpTools(server.tools),
      }
    }),
  }
}

export function parseMcpOAuth(value: unknown): McpOAuthState {
  const v = record(value)
  if (
    v.status !== 'idle' &&
    v.status !== 'pending' &&
    v.status !== 'authorized' &&
    v.status !== 'cancelled' &&
    v.status !== 'failed'
  )
    throw new Error('MCP 授权状态无效')
  return { status: v.status, ...(v.message === undefined ? {} : { message: string(v.message) }) }
}

export function parseMcpResponse(action: McpRequest['action'], value: unknown): McpResponse {
  switch (action) {
    case 'list':
      return parseMcpCatalog(value)
    case 'save':
      return id(value)
    case 'test':
      return parseMcpTools(value)
    case 'start':
    case 'status':
    case 'cancel':
      return parseMcpOAuth(value)
    case 'delete':
    case 'disconnect':
      if (value !== true) throw new Error('MCP 响应无效')
      return true
  }
}
