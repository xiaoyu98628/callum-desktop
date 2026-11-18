import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { ChatService, resolveBackendExecutable } from '../../src/main/backend/chat-service.ts'
import { isActiveRun } from '../../src/shared/chat.ts'
import type { ChatApproval, ChatEvent } from '../../src/shared/chat.ts'
import type { ServiceState } from '../../src/shared/desktop-api.ts'
import {
  backendExecutable,
  createRuntimeFixture,
  resourceRoot,
  seedModel,
  supportedBackend,
} from '../helpers/backend.ts'
import { RpcClient, RpcError } from '../../src/main/backend/rpc-client.ts'
import { startModelServer } from '../helpers/model-server.ts'

test('服务资源使用四个平台的匹配架构并拒绝不支持的目标', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    for (const arch of ['x64', 'arm64']) {
      assert.equal(
        resolveBackendExecutable(resourceRoot, platform, arch),
        join(
          resourceRoot,
          'backend',
          `${platform}-${arch}`,
          platform === 'win32' ? 'callum.exe' : 'callum',
        ),
      )
    }
  }
  assert.throws(() => resolveBackendExecutable(resourceRoot, 'linux', 'x64'), /没有适用于/)
  assert.throws(() => resolveBackendExecutable(resourceRoot, 'win32', 'ia32'), /没有适用于/)
  assert.throws(() => resolveBackendExecutable('relative'), /绝对路径/)
})

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('未收到预期事件')
    await setTimeout(20)
  }
}

test('随附 Go 程序拒绝已移除的旧消息分页接口', { skip: !supportedBackend }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'callum-backend-contract-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const client = new RpcClient(
    backendExecutable,
    ['--data-dir', join(profile, 'backend')],
    () => undefined,
    () => undefined,
  )
  try {
    await assert.rejects(
      client.request('conversation.messages', {
        conversation_id: '019a4f39-0000-7000-8000-000000000001',
      }),
      (error: unknown) => error instanceof RpcError && error.code === -32601,
    )
  } finally {
    await client.close()
  }
})

test('服务就绪、重复关闭及订阅清理保持明确的生命周期', { skip: !supportedBackend }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'callum-service-state-'))
  const service = new ChatService(join(profile, 'backend'), resourceRoot)
  const states: ServiceState[] = []
  const unsubscribe = service.subscribeState((state) => states.push(state))
  try {
    assert.deepEqual(service.getState(), { status: 'starting' })
    await service.overview(0)
    assert.deepEqual(service.getState(), { status: 'ready' })
    // 快照不能让调用方改写服务内部状态。
    service.getState().status = 'starting'
    assert.deepEqual(service.getState(), { status: 'ready' })
    const closing = service.close()
    assert.deepEqual(service.getState(), { status: 'closing' })
    assert.equal(service.close(), closing)
    await closing
    await assert.rejects(service.overview(0), /正在关闭/)
    assert.deepEqual(states, [{ status: 'ready' }, { status: 'closing' }])
    unsubscribe()
    unsubscribe()
  } finally {
    await service.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test('初始化失败结束加载，关闭时不再退回失败状态', { skip: !supportedBackend }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'callum-service-failure-'))
  const service = new ChatService(join(profile, 'backend'), profile)
  const states: ServiceState[] = []
  service.subscribeState((state) => states.push(state))
  try {
    await assert.rejects(service.overview(0), /未找到对话服务程序/)
    const failed = service.getState()
    assert.equal(failed.status, 'startup-failed')
    assert.ok('error' in failed && failed.error.includes('未找到对话服务程序'))
    await service.close()
    assert.deepEqual(states, [failed, { status: 'closing' }])
  } finally {
    await service.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test(
  '失败可连续重试，修复服务资源后使用同一服务和订阅成功启动',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-service-retry-'))
    const resources = join(profile, 'resources')
    const service = new ChatService(join(profile, 'backend'), resources)
    const states: ServiceState[] = []
    service.subscribeState((state) => states.push(state))
    try {
      await assert.rejects(service.overview(0), /未找到/)
      const first = service.retryStart()
      assert.equal(service.getState().status, 'starting')
      assert.equal(service.retryStart(), first, '重复请求必须共享同一次启动')
      assert.equal((await first).status, 'startup-failed')
      const executable = resolveBackendExecutable(resources)
      await mkdir(dirname(executable), { recursive: true, mode: 0o700 })
      await copyFile(backendExecutable, executable)
      await chmod(executable, 0o700)
      await createRuntimeFixture(resources)
      assert.deepEqual(await service.retryStart(), { status: 'ready' })
      assert.deepEqual(await service.catalog.list(), { providers: [], models: [] })
      assert.deepEqual((await service.overview(0)).conversations, [])
      assert.deepEqual(
        states.map((state) => state.status),
        ['startup-failed', 'starting', 'startup-failed', 'starting', 'ready'],
      )
      await assert.rejects(service.retryStart(), /仅支持重试启动失败/)
    } finally {
      await service.close()
      await assert.rejects(service.retryStart(), /正在退出/)
      await rm(profile, { recursive: true, force: true })
    }
  },
)

test(
  '数据目录问题提供固定安全原因，不包含底层路径或错误原文',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-service-data-error-'))
    const data = join(profile, 'private-data')
    await writeFile(data, 'occupied')
    const service = new ChatService(data, resourceRoot)
    try {
      await assert.rejects(service.overview(0), /路径被文件占用/)
      const state = service.getState()
      assert.equal(state.status, 'startup-failed')
      assert.ok('error' in state && !state.error.includes(profile))
    } finally {
      await service.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)

test('重试等待旧启动清理，期间退出不会再创建进程', { skip: !supportedBackend }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'callum-service-retry-close-'))
  const owner = new ChatService(join(profile, 'backend'), resourceRoot)
  let service: ChatService | undefined
  let release!: () => void
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await owner.overview(0)
    service = new ChatService(join(profile, 'backend'), resourceRoot)
    const states: string[] = []
    service.subscribeState((state) => {
      states.push(state.status)
      if (state.status !== 'startup-failed') return
      const client: unknown = Reflect.get(service!, 'client')
      assert.ok(client instanceof RpcClient)
      const close = client.close.bind(client)
      t.mock.method(client, 'close', async () => {
        await cleanup
        await close()
      })
    })
    await until(() => service?.getState().status === 'startup-failed')
    const retry = service.retryStart()
    assert.equal(service.retryStart(), retry)
    assert.equal(service.getState().status, 'starting')
    const closed = service.close()
    release()
    await closed
    assert.deepEqual(await retry, { status: 'closing' })
    assert.deepEqual(states, ['startup-failed', 'starting', 'closing'])
    assert.deepEqual((await owner.overview(0)).conversations, [])
  } finally {
    release()
    await service?.close()
    await owner.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test('初始化中关闭不会发布迟到的就绪或失败状态', { skip: !supportedBackend }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'callum-service-start-close-'))
  const service = new ChatService(join(profile, 'backend'), resourceRoot)
  const states: ServiceState[] = []
  service.subscribeState((state) => states.push(state))
  try {
    await service.close()
    assert.deepEqual(service.getState(), { status: 'closing' })
    assert.deepEqual(states, [{ status: 'closing' }])
  } finally {
    await service.close()
    await rm(profile, { recursive: true, force: true })
  }
})

test(
  '旧进程清理失败时重试不创建新连接，服务恢复前继续阻止业务操作',
  { skip: !supportedBackend },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-service-cleanup-failure-'))
    const owner = new ChatService(join(profile, 'backend'), resourceRoot)
    let service: ChatService | undefined
    try {
      await owner.overview(0)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      await assert.rejects(service.overview(0), /已有运行中的 Callum 服务/)
      const client: unknown = Reflect.get(service, 'client')
      assert.ok(client instanceof RpcClient)
      const close = t.mock.method(client, 'close', async () => {
        throw new Error('受控清理失败')
      })
      try {
        assert.equal((await service.retryStart()).status, 'startup-failed')
        assert.equal(Reflect.get(service, 'client'), client)
        await assert.rejects(service.overview(0), /已有运行中的 Callum 服务/)
      } finally {
        close.mock.restore()
      }
    } finally {
      await service?.close()
      await owner.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)

test(
  '真实 Go 服务：流式、隔离、取消、失败、always 审批与重启恢复',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-chat-integration-'))
    const file = join(profile, 'fixture.txt')
    await writeFile(file, 'controlled-file', { mode: 0o600 })
    const upstream = await startModelServer(file).catch(async (error: unknown) => {
      await rm(profile, { recursive: true, force: true })
      throw error
    })
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(profile, upstream.baseUrl, 'always')
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      assert.equal((await service.overview(0)).models[0]?.id, modelId)
      const first = await service.send({ conversationId: null, modelId, text: '你好' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === first.runId &&
            event.change.value.status === 'completed',
        ),
      )
      const detail = await service.detail(first.conversationId)
      assert.equal(detail.messages.length, 2)
      assert.equal(detail.messages[1]?.content[0]?.text, '你好，这是受控回答。')
      const completed = detail.runs.find((run) => run.id === first.runId)
      assert.ok(completed && completed.finishedAt !== null)
      assert.ok(completed.finishedAt >= completed.createdAt)
      assert.ok(
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === first.runId &&
            event.change.value.finishedAt === completed.finishedAt,
        ),
      )
      assert.ok(
        events.some(
          (event) =>
            event.change.kind === 'message' && event.change.value.content[0]?.text === '你好，',
        ),
      )

      const slow = await service.send({
        conversationId: first.conversationId,
        modelId,
        text: '等待甲',
      })
      const other = await service.send({ conversationId: null, modelId, text: '另一段对话' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === other.runId &&
            event.change.value.status === 'completed',
        ),
      )
      assert.ok(
        (await service.detail(slow.conversationId)).messages.some(
          (message) => message.content[0]?.text === '仅属于等待甲的内容',
        ),
      )
      assert.ok(
        !(await service.detail(other.conversationId)).messages.some((message) =>
          message.content[0]?.text.includes('等待甲'),
        ),
      )
      await service.cancel(slow.runId)
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === slow.runId &&
            event.change.value.status === 'cancelled',
        ),
      )
      assert.ok(!(await service.detail(slow.conversationId)).runs.some(isActiveRun))
      await until(() => upstream.cancelled > 0)

      for (const text of ['失败', '中断']) {
        const failed = await service.send({ conversationId: null, modelId, text })
        await until(() =>
          events.some(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === failed.runId &&
              event.change.value.status === 'failed',
          ),
        )
      }
      const approvalRun = await service.send({ conversationId: null, modelId, text: '需要审批' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'approval' &&
            event.change.value.runId === approvalRun.runId &&
            event.change.value.status === 'pending',
        ),
      )
      const approval = (await service.detail(approvalRun.conversationId)).approvals.find(
        (item) => item.status === 'pending',
      )
      assert.ok(approval)
      assert.ok(approval.snapshot.includes(file))
      assert.equal(approval.toolName, 'read_file')
      await service.decide(approval.id, 'approved')
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'run' &&
            event.change.value.id === approvalRun.runId &&
            event.change.value.status === 'completed',
        ),
      )
      const final = (await service.detail(approvalRun.conversationId)).messages.at(-1)?.content[0]
        ?.text
      assert.equal(final, '已读取测试文件。', '完整消息应替换工具调用前的文本')
      const steps = await service.listSteps(approvalRun.conversationId, approvalRun.runId, 0)
      assert.equal(steps.hasMore, false)
      const readStep = steps.steps.find((step) => step.name === 'read_file')
      assert.ok(readStep)
      assert.equal(readStep.status, 'completed')
      const modelStep = steps.steps.find((step) => step.id === readStep.parentStepId)
      assert.ok(modelStep?.commentary)
      assert.equal(modelStep.text, '准备检查文件。', '消息清空后过程说明仍按步骤保存')
      const readDetails = await service.stepDetails(
        approvalRun.conversationId,
        approvalRun.runId,
        readStep.id,
      )
      assert.ok(readDetails.output.includes('controlled-file'))
      await assert.rejects(service.listSteps(other.conversationId, approvalRun.runId, 0))
      await assert.rejects(
        service.stepDetails(other.conversationId, approvalRun.runId, readStep.id),
      )
      assert.ok(
        events.some(
          ({ change }) =>
            change.kind === 'step' &&
            change.value.runId === approvalRun.runId &&
            change.value.name === 'read_file',
        ),
      )
      assert.ok(
        upstream.requests.some(
          (request) => request.lastRole === 'tool' && request.text.includes('controlled-file'),
        ),
      )
      for (const decision of ['rejected', 'cancel'] as const) {
        const run = await service.send({ conversationId: null, modelId, text: `审批-${decision}` })
        await until(() =>
          events.some(
            (event) =>
              event.change.kind === 'approval' &&
              event.change.value.runId === run.runId &&
              event.change.value.status === 'pending',
          ),
        )
        const pending: ChatApproval | undefined = (
          await service.detail(run.conversationId)
        ).approvals.find((item) => item.status === 'pending')
        assert.ok(pending)
        if (decision === 'cancel') await service.cancel(run.runId)
        else await service.decide(pending.id, decision)
        await until(() =>
          events.some(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === run.runId &&
              event.change.value.status === (decision === 'cancel' ? 'cancelled' : 'completed'),
          ),
        )
        if (decision === 'rejected')
          assert.equal(
            (await service.detail(run.conversationId)).messages.at(-1)?.content[0]?.text,
            '操作已拒绝。',
          )
        else
          assert.ok(
            events.some(
              (event) =>
                event.change.kind === 'approval' &&
                event.change.value.id === pending.id &&
                event.change.value.status === 'cancelled',
            ),
          )
      }
      const exiting = await service.send({ conversationId: null, modelId, text: '等待退出' })
      await until(() =>
        events.some(
          (event) =>
            event.change.kind === 'message' &&
            event.change.value.runId === exiting.runId &&
            event.change.value.content[0]?.text.includes('等待退出') === true,
        ),
      )
      await service.close()
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const restored = await service.detail(first.conversationId)
      assert.equal(
        restored.runs.find((run) => run.id === first.runId)?.finishedAt,
        completed.finishedAt,
      )
      const restoredSteps = await service.listSteps(
        approvalRun.conversationId,
        approvalRun.runId,
        0,
      )
      const restoredModel = restoredSteps.steps.find(
        (step) => step.commentary && step.purpose === 'answer',
      )
      assert.ok(restoredModel)
      const restoredText = await service.stepDetails(
        approvalRun.conversationId,
        approvalRun.runId,
        restoredModel.id,
      )
      assert.equal(restoredText.text, '准备检查文件。', '重启后从统一模型步骤恢复过程文字')
      assert.equal(restored.messages.length, 4)
      assert.equal(restored.messages.at(-1)?.status, 'cancelled')
      assert.equal((await service.overview(0)).conversations.length, 8)
      assert.equal((await service.detail(exiting.conversationId)).runs.at(-1)?.status, 'cancelled')
    } finally {
      try {
        await service?.close()
      } finally {
        await upstream.close()
        await rm(profile, { recursive: true, force: true })
      }
    }
  },
)
