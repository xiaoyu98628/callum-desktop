import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { RpcClient } from '../../src/main/backend/rpc-client.ts'
import { id, record } from '../../src/shared/chat.ts'

export const resourceRoot = fileURLToPath(new URL('../../resources/', import.meta.url))
export const backendExecutable = join(resourceRoot, `${'backend'}/darwin-arm64/callum`)
export const supportedBackend = process.platform === 'darwin' && process.arch === 'arm64'

/** 仅对调用方提供的测试目录写入本机受控端点；不提供生产环境通用 RPC 入口。 */
export async function seedModel(
  profile: string,
  baseUrl: string,
  approvalPolicy: 'on-request' | 'always' = 'on-request',
): Promise<string> {
  const client = new RpcClient(
    backendExecutable,
    ['--data-dir', join(profile, 'backend')],
    () => undefined,
    () => undefined,
  )
  try {
    if (approvalPolicy !== 'on-request') {
      const settings = record(await client.request('settings.get', { key: 'execution' }))
      await client.request('settings.update', {
        key: 'execution',
        revision: settings.revision,
        value: { approval_policy: approvalPolicy, approvals_reviewer: 'user' },
      })
    }
    const provider = record(
      await client.request('provider.create', {
        name: `受控本机端点-${randomUUID()}`,
        protocol: 'chatcompletions',
        base_url: baseUrl,
      }),
    )
    const model = record(
      await client.request('model.create', {
        provider_id: id(provider.id),
        display_name: '受控文本模型',
        remote_model_id: 'local-fixture',
        enabled: true,
        context_window: 1_000_000,
        model_type: [],
      }),
    )
    return id(model.id)
  } finally {
    await client.close()
  }
}
