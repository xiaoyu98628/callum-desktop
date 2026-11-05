import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ModelCatalog } from '../../src/main/backend/model-catalog.ts'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { parseModelInput, parseProviderInput } from '../../src/shared/models.ts'
import type { ProviderInput } from '../../src/shared/models.ts'
import { record } from '../../src/shared/chat.ts'
import { supportedBackend, resourceRoot } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'

const uuid = '019a4f39-0000-7000-8000-000000000001'
const basic = {
  id: uuid,
  providerId: uuid,
  name: '模型',
  remoteModelId: 'local-fixture',
  enabled: true,
}

test('模型配置边界拒绝非 HTTP 地址、URL 凭据、意外清空和无效输入', () => {
  const input = {
    id: uuid,
    protocol: 'chatcompletions',
    name: '供应商',
    baseUrl: 'https://example.invalid/v1',
    keyMode: 'keep',
  }
  assert.equal(parseProviderInput(input).keyMode, 'keep')
  assert.equal(parseProviderInput(input).protocol, 'chatcompletions')
  for (const baseUrl of [
    'file:///tmp/file',
    'javascript:alert(1)',
    'https://user:pass@example.invalid',
    'https://example.invalid?key=private',
    'https://example.invalid/#secret',
  ])
    assert.throws(() => parseProviderInput({ ...input, baseUrl }))
  for (const change of [
    { apiKey: 'unexpected' },
    { keyMode: 'replace', apiKey: '' },
    { keyMode: 'replace', apiKey: 'fixture\r\nInjected: value' },
    { id: null, keyMode: 'clear' },
    { name: ' ' },
    { command: 'unexpected' },
    { protocol: 'unsupported' },
    { protocol: null },
    { protocol: undefined },
  ])
    assert.throws(() => parseProviderInput({ ...input, ...change }))
  assert.throws(() => parseModelInput({ ...basic, enabled: 'true' }))
  assert.throws(() => parseModelInput({ ...basic, remoteModelId: ' ' }))
  assert.throws(() => parseModelInput({ ...basic, providerId: '../../file' }))
  for (const contextWindow of [0, -1, 1.5, 1_000_000_001, '100000'])
    assert.throws(() => parseModelInput({ ...basic, contextWindow }))
  assert.equal(parseModelInput({ ...basic, contextWindow: 128000 }).contextWindow, 128000)
})

test('编辑模型保留后端已有元数据，读取列表剔除非公开字段', async () => {
  const metadata = {
    context_window: 12345,
    max_output_tokens: 1024,
    capabilities: { reasoning: true, tools: false },
    model_type: ['text', 'image'],
    reasoning_levels: [{ display_name: '高', remote_value: 'high' }],
  }
  let saved: Record<string, unknown> | undefined
  const catalog = new ModelCatalog(async (method, params) => {
    if (method === 'model.get') return { ...metadata, id: uuid }
    if (method === 'model.update') {
      saved = record(params)
      return { id: uuid }
    }
    if (method === 'provider.list')
      return [
        {
          id: uuid,
          name: '供应商',
          protocol: 'chatcompletions',
          base_url: 'https://example.invalid/v1',
          has_api_key: true,
          api_key: 'must-not-return',
        },
      ]
    if (method === 'model.list')
      return [
        {
          id: uuid,
          provider_id: uuid,
          display_name: '模型',
          remote_model_id: 'remote',
          enabled: true,
          private_field: 'must-not-return',
        },
      ]
    throw new Error('非预期方法')
  })
  await catalog.saveModel(basic)
  assert.ok(saved)
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(saved[key], value)
  await catalog.saveModel({ ...basic, contextWindow: 256000 })
  assert.equal(saved.context_window, 256000)
  for (const [key, value] of Object.entries(metadata))
    if (key !== 'context_window') assert.deepEqual(saved[key], value)
  assert.ok(!JSON.stringify(await catalog.list()).includes('must-not-return'))
})

test('保留密钥不会传空字符串，清除与替换必须明确提交', async () => {
  const writes: Record<string, unknown>[] = []
  const catalog = new ModelCatalog(async (method, params) => {
    if (method === 'provider.get') return { id: uuid, protocol: 'chatcompletions' }
    writes.push(record(params))
    return { id: uuid }
  })
  const input = {
    id: uuid,
    protocol: 'chatcompletions',
    name: '供应商',
    baseUrl: 'https://example.invalid/v1',
  } satisfies Omit<ProviderInput, 'keyMode' | 'apiKey'>
  await catalog.saveProvider({ ...input, keyMode: 'keep' })
  await catalog.saveProvider({ ...input, keyMode: 'clear' })
  await catalog.saveProvider({ ...input, keyMode: 'replace', apiKey: 'fixture-key' })
  assert.equal('api_key' in writes[0]!, false)
  assert.equal(writes[1]?.api_key, '')
  assert.equal(writes[2]?.api_key, 'fixture-key')
  assert.ok(writes.every((write) => write.protocol === input.protocol))
})

test('已有未知服务类型不能被编辑操作静默改为默认类型', async () => {
  let writes = 0
  const catalog = new ModelCatalog(async (method) => {
    if (method === 'provider.get') return { id: uuid, protocol: 'unsupported' }
    writes++
    return { id: uuid }
  })
  await assert.rejects(
    catalog.saveProvider({
      id: uuid,
      protocol: 'chatcompletions',
      name: '供应商',
      baseUrl: 'https://example.invalid/v1',
      keyMode: 'keep',
    }),
    /服务类型/,
  )
  assert.equal(writes, 0)
})

test('并发配置写入会拒绝重复操作，失败后可正常继续', async () => {
  let release = () => undefined as void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const catalog = new ModelCatalog(async () => {
    calls++
    if (calls === 1) {
      await gate
      throw new Error('受控失败')
    }
    return { id: uuid }
  })
  const first = catalog.deleteModel(uuid)
  await assert.rejects(catalog.deleteModel(uuid), /正在进行/)
  release()
  await assert.rejects(first, /受控失败/)
  assert.equal(await catalog.deleteModel(uuid), uuid)
  assert.equal(calls, 2)
})

test(
  '真实 Go 配置：保存凭据、保留密钥、发送、启停与关联删除',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-models-'))
    const file = join(profile, 'fixture.txt')
    await writeFile(file, 'fixture')
    const endpoint = await startModelServer(file, 'fixture-catalog-key').catch(
      async (error: unknown) => {
        await rm(profile, { recursive: true, force: true })
        throw error
      },
    )
    const service = new ChatService(join(profile, 'backend'), resourceRoot)
    try {
      const providerId = await service.catalog.saveProvider({
        id: null,
        protocol: 'chatcompletions',
        name: '本机测试',
        baseUrl: endpoint.baseUrl,
        keyMode: 'replace',
        apiKey: 'fixture-catalog-key',
      })
      const modelId = await service.catalog.saveModel({
        ...basic,
        id: null,
        providerId,
        contextWindow: 1_000_000,
      })
      await service.catalog.saveProvider({
        id: providerId,
        protocol: 'chatcompletions',
        name: '已编辑',
        baseUrl: endpoint.baseUrl,
        keyMode: 'keep',
      })
      const catalog = await service.catalog.list()
      assert.equal(catalog.providers[0]?.hasApiKey, true)
      assert.equal(catalog.providers[0]?.protocol, 'chatcompletions')
      assert.ok(!JSON.stringify(catalog).includes('fixture-catalog-key'))
      await assert.rejects(service.catalog.saveModel({ ...basic, id: null, providerId }))
      await assert.rejects(service.catalog.deleteProvider(providerId))
      const accepted = await service.send({ conversationId: null, modelId, text: '你好' })
      const deadline = Date.now() + 5000
      while ((await service.detail(accepted.conversationId)).runs.at(-1)?.status !== 'completed') {
        if (Date.now() > deadline) throw new Error('模型回答超时')
        await setTimeout(20)
      }
      assert.ok(endpoint.requests.some((request) => request.expectedAuthorization))
      await service.catalog.setEnabled(modelId, false)
      assert.equal((await service.overview(0)).models.length, 0)
      await service.catalog.setEnabled(modelId, true)
      assert.equal((await service.overview(0)).models[0]?.id, modelId)
      await service.catalog.deleteModel(modelId)
      await service.catalog.deleteProvider(providerId)
      assert.deepEqual(await service.catalog.list(), { providers: [], models: [] })
      assert.equal((await service.detail(accepted.conversationId)).messages.length, 2)
    } finally {
      try {
        await service.close()
      } finally {
        await endpoint.close()
        await rm(profile, { recursive: true, force: true })
      }
    }
  },
)
