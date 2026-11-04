import { array, id, record } from '../../shared/chat.ts'
import { parseConfiguredModel, parseProvider, parseProviderProtocol } from '../../shared/models.ts'
import type {
  ConfiguredModel,
  ModelCatalog as Catalog,
  ModelInput,
  ModelProvider,
  ProviderInput,
} from '../../shared/models.ts'

type CatalogMethod =
  | 'provider.list'
  | 'provider.get'
  | 'provider.create'
  | 'provider.update'
  | 'provider.delete'
  | 'model.list'
  | 'model.get'
  | 'model.create'
  | 'model.update'
  | 'model.set_enabled'
  | 'model.delete'
type Request = (method: CatalogMethod, params: unknown) => Promise<unknown>

function providerFromRpc(value: unknown): ModelProvider {
  const v = record(value)
  return parseProvider({
    id: v.id,
    name: v.name,
    baseUrl: v.base_url,
    protocol: v.protocol,
    hasApiKey: v.has_api_key,
  })
}
function modelFromRpc(value: unknown): ConfiguredModel {
  const v = record(value)
  return parseConfiguredModel({
    id: v.id,
    providerId: v.provider_id,
    name: v.display_name,
    remoteModelId: v.remote_model_id,
    enabled: v.enabled,
  })
}

/** 复用应用的唯一连接；凭据只传给后端，列表永远不携带密钥。 */
export class ModelCatalog {
  private readonly request: Request
  private writing = false
  constructor(request: Request) {
    this.request = request
  }
  async list(): Promise<Catalog> {
    const [providers, models] = await Promise.all([
      this.request('provider.list', {}),
      this.request('model.list', { selectable_only: false }),
    ])
    return {
      providers: array(providers ?? [], providerFromRpc),
      models: array(models ?? [], modelFromRpc),
    }
  }
  saveProvider(input: ProviderInput): Promise<string> {
    return this.mutate(async () => {
      const protocol = parseProviderProtocol(input.protocol)
      if (input.id) {
        const current = record(await this.request('provider.get', { id: input.id }))
        // 未识别的已有类型不能在基础编辑时被静默覆盖为默认类型。
        parseProviderProtocol(current.protocol)
      }
      const result = await this.request(input.id ? 'provider.update' : 'provider.create', {
        ...(input.id ? { id: input.id } : {}),
        name: input.name,
        protocol,
        base_url: input.baseUrl,
        ...(input.keyMode === 'replace'
          ? { api_key: input.apiKey }
          : input.keyMode === 'clear'
            ? { api_key: '' }
            : {}),
      })
      return this.resultId(result, input.id)
    })
  }
  saveModel(input: ModelInput): Promise<string> {
    return this.mutate(async () => {
      const current = input.id ? record(await this.request('model.get', { id: input.id })) : null
      // model.update 是完整替换；基础编辑不能清空 UI 尚未提供编辑入口的后端元数据。
      const result = await this.request(input.id ? 'model.update' : 'model.create', {
        ...(input.id ? { id: input.id } : {}),
        provider_id: input.providerId,
        display_name: input.name,
        remote_model_id: input.remoteModelId,
        enabled: input.enabled,
        context_window: current?.context_window ?? null,
        max_output_tokens: current?.max_output_tokens ?? null,
        capabilities: current?.capabilities ?? null,
        model_type: current?.model_type ?? [],
        reasoning_levels: current?.reasoning_levels ?? null,
      })
      return this.resultId(result, input.id)
    })
  }
  deleteProvider(providerId: string): Promise<string> {
    return this.mutate(async () =>
      this.resultId(await this.request('provider.delete', { id: providerId }), providerId),
    )
  }
  deleteModel(modelId: string): Promise<string> {
    return this.mutate(async () =>
      this.resultId(await this.request('model.delete', { id: modelId }), modelId),
    )
  }
  setEnabled(modelId: string, enabled: boolean): Promise<string> {
    return this.mutate(async () =>
      this.resultId(await this.request('model.set_enabled', { id: modelId, enabled }), modelId),
    )
  }
  private resultId(value: unknown, expected: string | null): string {
    const result = id(record(value).id)
    if (expected && result !== expected) throw new Error('配置响应标识不匹配，请重新加载核对结果')
    return result
  }
  private async mutate(action: () => Promise<string>): Promise<string> {
    if (this.writing) throw new Error('另一个配置操作正在进行，请稍后重试')
    this.writing = true
    try {
      return await action()
    } finally {
      this.writing = false
    }
  }
}
