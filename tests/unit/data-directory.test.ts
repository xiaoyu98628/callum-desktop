import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBackendDataDirectory } from '../../src/main/backend/data-directory.ts'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { resourceRoot, supportedBackend } from '../helpers/backend.ts'

// 使用人工传入的绝对路径验证家目录分支，不读取本机真实家目录或其数据。
const fakeHome = join(tmpdir(), 'callum-path-fixture', 'home with spaces')
const fakeProfile = join(tmpdir(), 'callum-path-fixture', 'isolated profile')

test('默认服务数据直接位于家目录的 .callum，独立于 Electron 配置目录', () => {
  assert.equal(resolveBackendDataDirectory(fakeHome), join(fakeHome, '.callum'))
})

test('显式隔离目录优先，沿用 profile/backend，避免测试读取家目录', () => {
  assert.equal(resolveBackendDataDirectory(fakeHome, fakeProfile), join(fakeProfile, 'backend'))
  assert.equal(
    resolveBackendDataDirectory('不应使用的家目录', fakeProfile),
    join(fakeProfile, 'backend'),
  )
})

test('目录必须是绝对路径，不依赖工作目录或 Shell 展开波浪号', () => {
  for (const path of ['', '.callum', '~/.callum', '../profile']) {
    assert.throws(() => resolveBackendDataDirectory(path), /绝对路径/)
    assert.throws(() => resolveBackendDataDirectory(fakeHome, path), /绝对路径/)
  }
})

test(
  '实际 Go 服务使用选定的 .callum，重启保留配置并保持旧目录原样',
  { skip: !supportedBackend },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'callum-data-directory-'))
    const home = join(root, 'fake home')
    const previous = join(root, 'Callum Development', 'backend')
    const marker = join(previous, 'preserved.txt')
    await mkdir(previous, { recursive: true, mode: 0o700 })
    await writeFile(marker, 'existing-data-must-remain', { mode: 0o600 })
    const dataDirectory = resolveBackendDataDirectory(home)
    let service = new ChatService(dataDirectory, resourceRoot)
    try {
      assert.deepEqual(await service.catalog.list(), { providers: [], models: [] })
      const providerId = await service.catalog.saveProvider({
        id: null,
        protocol: 'chatcompletions',
        name: '目录验证',
        baseUrl: 'http://127.0.0.1:1/v1',
        keyMode: 'keep',
      })
      if (process.platform !== 'win32')
        assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700)
      assert.ok((await readdir(dataDirectory)).length > 0)
      assert.equal((await readdir(home)).includes('backend'), false)
      assert.deepEqual(await readdir(previous), ['preserved.txt'])
      assert.equal(await readFile(marker, 'utf8'), 'existing-data-must-remain')
      await service.close()
      service = new ChatService(dataDirectory, resourceRoot)
      assert.equal((await service.catalog.list()).providers[0]?.id, providerId)
      assert.deepEqual(await readdir(previous), ['preserved.txt'])
    } finally {
      try {
        await service.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
)
