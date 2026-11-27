import { ChatService } from '../../src/main/backend/chat-service.ts'
import { resourceRoot, supportedBackend, cleanupTestCredentials } from '../helpers/backend.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackendLifecycle } from '../../src/main/backend/backend-lifecycle.ts'

test('启动失败释放资源，坏状态订阅隔离，重试合并且退出只清理一次', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'callum-lifecycle-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let releases = 0,
    waits = 0,
    badCalls = 0
  const lifecycle = new BackendLifecycle(
    join(root, 'data'),
    root,
    join(root, 'missing-executable'),
    {
      notify: () => assert.fail('未启动不应接收业务通知'),
      disconnected: () => assert.fail('启动失败不是运行断连'),
      resetAttachments: async () => assert.fail('未就绪不得重置附件'),
      waitTransfers: async () => {
        waits++
      },
      releaseState: () => {
        releases++
      },
    },
  )
  lifecycle.subscribeState(() => {
    badCalls++
    throw new Error('must-not-escape')
  })
  const statuses: string[] = []
  lifecycle.subscribeState((state) => statuses.push(state.status))
  await assert.rejects(lifecycle.ensureReady(), /未找到对话服务程序/)
  assert.equal(lifecycle.getState().status, 'startup-failed')
  const retry = lifecycle.retryStart()
  assert.equal(lifecycle.retryStart(), retry)
  assert.equal((await retry).status, 'startup-failed')
  assert.equal(badCalls, 1)
  assert.deepEqual(statuses, ['startup-failed', 'starting', 'startup-failed'])
  const closing = lifecycle.close()
  assert.equal(lifecycle.close(), closing)
  await closing
  assert.equal(releases, 1)
  assert.equal(waits, 1)
  await assert.rejects(lifecycle.retryStart(), /退出/)
})

test(
  '三组独立目录并发安装和启动完整随附资源，校验不挤占数据库初始化预算',
  { skip: !supportedBackend },
  async (t) => {
    const profiles: string[] = []
    const services: ChatService[] = []
    t.after(async () => {
      const closed = await Promise.allSettled(services.map((service) => service.close()))
      const failures = closed.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length) throw new AggregateError(failures, '并发启动回归关闭失败')
      for (const profile of profiles) {
        await cleanupTestCredentials(profile)
        await rm(profile, { recursive: true, force: true })
      }
    })
    for (let n = 0; n < 3; n++)
      profiles.push(await mkdtemp(join(tmpdir(), 'callum-startup-parallel-')))
    for (const profile of profiles)
      services.push(new ChatService(join(profile, 'backend'), resourceRoot))
    const overviews = await Promise.all(services.map((service) => service.overview(0)))
    assert.ok(services.every((service) => service.getState().status === 'ready'))
    assert.ok(
      overviews.every(
        (overview) => overview.models.length === 0 && overview.conversations.length === 0,
      ),
    )
  },
)
