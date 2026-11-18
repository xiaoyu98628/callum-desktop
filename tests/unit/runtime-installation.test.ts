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
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { installRuntimeAssets } from '../../src/main/backend/runtime-installation.ts'

import { RpcClient } from '../../src/main/backend/rpc-client.ts'
import { record } from '../../src/shared/validation.ts'
import { backendExecutable, supportedBackend } from '../helpers/backend.ts'

const windows = process.platform === 'win32'
const pythonPath = windows ? 'python/python.exe' : 'python/bin/python3'

async function source(directory: string, content: string): Promise<void> {
  const python = { version: '3.12.14', path: pythonPath }
  const node = { version: '26.13.0', path: windows ? 'node/node.exe' : 'node/bin/node' }
  const git = {
    version: '2.56.1',
    path: windows ? 'git/cmd/git.exe' : 'git/bin/git',
    exec_path: 'git/libexec',
    template_path: 'git/share/templates',
    config_path: 'git/etc/gitconfig',
  }
  const files = []
  for (const path of [
    python.path,
    node.path,
    git.path,
    git.config_path,
    `${git.exec_path}/helper`,
    `${git.template_path}/sample`,
  ].sort()) {
    const file = join(directory, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content, { mode: 0o755 })
    files.push({
      path,
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      format_version: 3,
      platform: windows ? 'windows' : process.platform,
      arch: process.arch === 'x64' ? 'amd64' : process.arch,
      python,
      node,
      git,
      files,
    }),
  )
}

async function withInstaller(
  run: (
    resources: string,
    data: string,
    install: (signal?: AbortSignal) => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'callum-flat-install-'))
  const resources = join(root, 'resources')
  const data = join(root, 'data')
  await mkdir(data, { mode: 0o700 })
  const guard = new RpcClient(
    backendExecutable,
    ['resource-lock', '--data-dir', data],
    () => {},
    () => {},
  )
  const install = (signal = new AbortController().signal) =>
    installRuntimeAssets(resources, data, signal, async (directory) => {
      const check = record(await guard.request('runtime.validate', { name: basename(directory) }))
      assert.equal(typeof check.valid, 'boolean')
      return check.valid === true
    })
  try {
    await guard.ready
    await run(resources, data, install)
  } finally {
    try {
      await guard.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

test(
  '运行时安装到固定目录，重复使用不替换，更新与失败保留完整环境',
  { skip: !supportedBackend },
  async () => {
    await withInstaller(async (resources, data, install) => {
      await source(resources, 'old')
      const runtime = await install()
      assert.equal(runtime, join(data, 'runtimes'))
      const before = await stat(runtime)
      await install()
      assert.equal((await stat(runtime)).ino, before.ino)
      await writeFile(join(runtime, 'unlisted.txt'), 'extra')
      await install()
      await assert.rejects(stat(join(runtime, 'unlisted.txt')), { code: 'ENOENT' })
      if (!windows) {
        await chmod(join(runtime, pythonPath), 0o400)
        await install()
        assert.notEqual((await stat(join(runtime, pythonPath))).mode & 0o111, 0)
      }
      await source(resources, 'new')
      await install()
      assert.equal(await readFile(join(runtime, pythonPath), 'utf8'), 'new')
      await chmod(join(runtime, pythonPath), 0o600)
      await writeFile(join(runtime, pythonPath), 'damaged')
      await install()
      assert.equal(await readFile(join(runtime, pythonPath), 'utf8'), 'new')
      await source(resources, 'correct')
      await writeFile(join(resources, pythonPath), 'corrupt')
      await assert.rejects(install(), /校验失败/)
      assert.equal(await readFile(join(runtime, pythonPath), 'utf8'), 'new')
      assert.deepEqual(await readdir(data), ['callum.db.lock', 'runtimes'])
      if (!windows) {
        await source(resources, 'valid-bytes-but-not-executable')
        await chmod(join(resources, pythonPath), 0o600)
        await assert.rejects(install(), /完整校验失败/)
        assert.equal(await readFile(join(runtime, pythonPath), 'utf8'), 'new')
        assert.deepEqual(await readdir(data), ['callum.db.lock', 'runtimes'])
      }
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(install(controller.signal), {
        name: 'AbortError',
      })
      assert.deepEqual(await readdir(data), ['callum.db.lock', 'runtimes'])
    })
  },
)

test(
  '安装中断后恢复已登记的旧目录，拒绝清单外文件和越界恢复路径',
  { skip: !supportedBackend },
  async () => {
    await withInstaller(async (resources, data, install) => {
      await source(resources, 'old')
      const runtime = await install()
      const stage = '.runtimes-install-ABC123'
      await mkdir(join(data, stage))
      await rename(runtime, join(data, `${stage}-previous`))
      await writeFile(
        join(data, '.runtimes-install.json'),
        JSON.stringify({ stage, backup: `${stage}-previous`, digest: '0'.repeat(64) }),
      )
      await install()
      assert.equal(await readFile(join(runtime, pythonPath), 'utf8'), 'old')
      assert.deepEqual(await readdir(data), ['callum.db.lock', 'runtimes'])
      const truncated = '{"stage":'
      await writeFile(join(data, '.runtimes-install.json'), truncated)
      await install()
      const quarantine = (await readdir(data)).find((item) =>
        item.startsWith('.runtimes-install-invalid-'),
      )
      assert.ok(quarantine)
      assert.equal(await readFile(join(data, quarantine), 'utf8'), truncated)
      await install()
      assert.equal(await readFile(join(data, quarantine), 'utf8'), truncated)
      await rm(join(data, quarantine))
      await rename(runtime, join(data, `${stage}-previous`))
      await source(runtime, 'incomplete-new-runtime')
      await chmod(runtime, 0o700)
      const digest = createHash('sha256')
        .update(await readFile(join(runtime, 'manifest.json')))
        .digest('hex')
      await rm(join(runtime, pythonPath))
      await writeFile(
        join(data, '.runtimes-install.json'),
        JSON.stringify({ stage, backup: `${stage}-previous`, digest }),
      )
      await install()
      assert.equal(await readFile(join(runtime, pythonPath), 'utf8'), 'old')
      assert.deepEqual(await readdir(data), ['callum.db.lock', 'runtimes'])
      await writeFile(join(resources, 'extra'), 'unlisted')
      await assert.rejects(install(), /清单外/)
      await writeFile(
        join(data, '.runtimes-install.json'),
        JSON.stringify({ stage: '../outside', backup: 'other', digest: '0'.repeat(64) }),
      )
      await assert.rejects(install(), /恢复目标/)
    })
  },
)
