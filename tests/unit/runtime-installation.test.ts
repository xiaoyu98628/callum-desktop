import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installRuntimeAssets } from '../../src/main/backend/runtime-installation.ts'

async function source(directory: string, content: string): Promise<void> {
  await mkdir(join(directory, 'python/bin'), { recursive: true })
  await writeFile(join(directory, 'python/bin/python3'), content, { mode: 0o755 })
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      format_version: 3,
      platform: process.platform === 'win32' ? 'windows' : process.platform,
      arch: process.arch === 'x64' ? 'amd64' : process.arch,
      files: [
        {
          path: 'python/bin/python3',
          size: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    }),
  )
}

test('运行时安装到固定目录，重复使用不替换，更新与失败保留完整环境', async () => {
  const root = await mkdtemp(join(tmpdir(), 'callum-flat-install-'))
  try {
    const resources = join(root, 'resources'),
      data = join(root, 'data')
    await mkdir(data, { mode: 0o700 })
    await source(resources, 'old')
    const runtime = await installRuntimeAssets(resources, data, new AbortController().signal)
    assert.equal(runtime, join(data, 'runtimes'))
    const before = await stat(runtime)
    await installRuntimeAssets(resources, data, new AbortController().signal)
    assert.equal((await stat(runtime)).ino, before.ino)
    await source(resources, 'new')
    await installRuntimeAssets(resources, data, new AbortController().signal)
    assert.equal(await readFile(join(runtime, 'python/bin/python3'), 'utf8'), 'new')
    await chmod(join(runtime, 'python/bin/python3'), 0o600)
    await writeFile(join(runtime, 'python/bin/python3'), 'damaged')
    await installRuntimeAssets(resources, data, new AbortController().signal)
    assert.equal(await readFile(join(runtime, 'python/bin/python3'), 'utf8'), 'new')
    await source(resources, 'correct')
    await writeFile(join(resources, 'python/bin/python3'), 'corrupt')
    await assert.rejects(
      installRuntimeAssets(resources, data, new AbortController().signal),
      /校验失败/,
    )
    assert.equal(await readFile(join(runtime, 'python/bin/python3'), 'utf8'), 'new')
    assert.deepEqual(await readdir(data), ['runtimes'])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(installRuntimeAssets(resources, data, controller.signal), {
      name: 'AbortError',
    })
    assert.deepEqual(await readdir(data), ['runtimes'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装中断后恢复已登记的旧目录，拒绝清单外文件和越界恢复路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'callum-flat-recovery-'))
  try {
    const resources = join(root, 'resources'),
      data = join(root, 'data')
    await mkdir(data, { mode: 0o700 })
    await source(resources, 'old')
    const runtime = await installRuntimeAssets(resources, data, new AbortController().signal)
    const stage = '.runtimes-install-ABC123'
    await mkdir(join(data, stage))
    await rename(runtime, join(data, `${stage}-previous`))
    await writeFile(
      join(data, '.runtimes-install.json'),
      JSON.stringify({ stage, backup: `${stage}-previous`, digest: '0'.repeat(64) }),
    )
    await installRuntimeAssets(resources, data, new AbortController().signal)
    assert.equal(await readFile(join(runtime, 'python/bin/python3'), 'utf8'), 'old')
    assert.deepEqual(await readdir(data), ['runtimes'])
    await rename(runtime, join(data, `${stage}-previous`))
    await source(runtime, 'incomplete-new-runtime')
    await chmod(runtime, 0o700)
    const digest = createHash('sha256')
      .update(await readFile(join(runtime, 'manifest.json')))
      .digest('hex')
    await rm(join(runtime, 'python/bin/python3'))
    await writeFile(
      join(data, '.runtimes-install.json'),
      JSON.stringify({ stage, backup: `${stage}-previous`, digest }),
    )
    await installRuntimeAssets(resources, data, new AbortController().signal)
    assert.equal(await readFile(join(runtime, 'python/bin/python3'), 'utf8'), 'old')
    assert.deepEqual(await readdir(data), ['runtimes'])
    await writeFile(join(resources, 'extra'), 'unlisted')
    await assert.rejects(
      installRuntimeAssets(resources, data, new AbortController().signal),
      /清单外/,
    )
    await writeFile(
      join(data, '.runtimes-install.json'),
      JSON.stringify({ stage: '../outside', backup: 'other', digest: '0'.repeat(64) }),
    )
    await assert.rejects(
      installRuntimeAssets(resources, data, new AbortController().signal),
      /恢复目标/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
