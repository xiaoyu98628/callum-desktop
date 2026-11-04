import { array, id, record, string } from './chat.ts'
import type { ChatModel } from './chat.ts'

/** 可配置的服务类型；增加选项时须同时核对 Go 服务的协议支持。 */
export const PROVIDER_SERVICES = [{ value: 'chatcompletions', label: 'Chat Completions' }] as const
export type ProviderProtocol = (typeof PROVIDER_SERVICES)[number]['value']

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  protocol: string
  hasApiKey: boolean
}
export interface ConfiguredModel {
  id: string
  providerId: string
  name: string
  remoteModelId: string
  enabled: boolean
}
export interface ModelCatalog {
  providers: ModelProvider[]
  models: ConfiguredModel[]
}
export interface ProviderInput {
  id: string | null
  protocol: ProviderProtocol
  name: string
  baseUrl: string
  keyMode: 'keep' | 'replace' | 'clear'
  apiKey?: string
}
export interface ModelInput {
  id: string | null
  providerId: string
  name: string
  remoteModelId: string
  enabled: boolean
}

function text(value: unknown, label: string, limit: number): string {
  const result = string(value).trim()
  const hasControl = Array.from(result).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (!result || result.length > limit || hasControl)
    throw new Error(`${label}不能为空，且长度不能超过 ${limit} 个字符`)
  return result
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('配置包含不支持的字段')
}
export function parseProviderProtocol(value: unknown): ProviderProtocol {
  const service = PROVIDER_SERVICES.find((service) => service.value === value)
  if (!service) throw new Error('暂不支持所选服务类型')
  return service.value
}
export function parseProviderInput(value: unknown): ProviderInput {
  const v = record(value)
  keys(v, ['id', 'protocol', 'name', 'baseUrl', 'keyMode', 'apiKey'])
  const baseUrl = text(v.baseUrl, 'API 地址', 2048)
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('请输入有效的 HTTP 或 HTTPS API 根地址')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('API 地址必须使用 HTTP 或 HTTPS，且不能包含账号、密码、查询参数或片段')
  if (v.keyMode !== 'keep' && v.keyMode !== 'replace' && v.keyMode !== 'clear')
    throw new Error('密钥操作无效')
  const result: ProviderInput = {
    id: v.id === null ? null : id(v.id),
    protocol: parseProviderProtocol(v.protocol),
    name: text(v.name, '供应商名称', 120),
    baseUrl,
    keyMode: v.keyMode,
  }
  if (v.keyMode === 'replace') result.apiKey = text(v.apiKey, 'API Key', 8192)
  else if ('apiKey' in v) throw new Error('只有替换密钥时才能传入 API Key')
  if (result.id === null && result.keyMode === 'clear') throw new Error('新供应商没有可清除的密钥')
  return result
}
export function parseModelInput(value: unknown): ModelInput {
  const v = record(value)
  keys(v, ['id', 'providerId', 'name', 'remoteModelId', 'enabled'])
  if (typeof v.enabled !== 'boolean') throw new Error('模型启用状态无效')
  return {
    id: v.id === null ? null : id(v.id),
    providerId: id(v.providerId),
    name: text(v.name, '模型名称', 120),
    remoteModelId: text(v.remoteModelId, '模型 ID', 256),
    enabled: v.enabled,
  }
}
export function parseProvider(value: unknown): ModelProvider {
  const v = record(value)
  if (typeof v.hasApiKey !== 'boolean') throw new Error('供应商密钥状态无效')
  return {
    id: id(v.id),
    name: string(v.name),
    baseUrl: string(v.baseUrl),
    protocol: string(v.protocol),
    hasApiKey: v.hasApiKey,
  }
}
export function parseConfiguredModel(value: unknown): ConfiguredModel {
  const v = record(value)
  if (typeof v.enabled !== 'boolean') throw new Error('模型启用状态无效')
  return {
    id: id(v.id),
    providerId: id(v.providerId),
    name: string(v.name),
    remoteModelId: string(v.remoteModelId),
    enabled: v.enabled,
  }
}
export function parseCatalog(value: unknown): ModelCatalog {
  const v = record(value)
  return {
    providers: array(v.providers, parseProvider),
    models: array(v.models, parseConfiguredModel),
  }
}
export function availableModels(catalog: ModelCatalog): ChatModel[] {
  return catalog.models
    .filter((model) => model.enabled)
    .map((model) => ({ id: model.id, name: model.name }))
}
