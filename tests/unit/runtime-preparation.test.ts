import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import assert from 'node:assert/strict'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { prepareRuntimes } from '../../scripts/prepare-runtimes.ts'
import { resolveBackendExecutable } from '../../src/main/backend/chat-service.ts'
import {
  resolveResourceTarget,
  resolveRuntimeDirectory,
} from '../../src/main/backend/runtime-assets.ts'
import { backendExecutable, resourceRoot, supportedBackend } from '../helpers/backend.ts'

async function writableDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await writableDirectories(join(directory, entry.name))
}

test(
  '仅凭仓库归档和随附服务离线准备资源，重复准备不替换，归档缺失明确失败',
  { skip: !supportedBackend },
  async (t) => {
    const resources = await mkdtemp(join(tmpdir(), 'callum-offline-resources-'))
    t.after(async () => {
      await writableDirectories(resources)
      await rm(resources, { recursive: true, force: true })
    })
    const executable = resolveBackendExecutable(resources)
    await mkdir(dirname(executable), { recursive: true })
    await copyFile(backendExecutable, executable)
    await chmod(executable, 0o755)
    const sources = JSON.parse(
      await readFile(join(resourceRoot, 'runtimes', 'sources.json'), 'utf8'),
    ) as {
      targets: {
        directory: string
        python: { archive: string; url: string }
        node: { archive: string; url: string }
        git: { archive: string; url: string }
        python_packages?: { archive: string; url: string }[]
        workspace?: { archives: { archive: string }[] }
      }[]
    }
    const target = sources.targets.find((entry) => entry.directory === resolveResourceTarget())
    assert.ok(target)
    const archives = join(resources, 'runtimes', 'archives')
    await mkdir(archives, { recursive: true })
    for (const component of [
      target.python,
      target.node,
      target.git,
      ...(target.python_packages ?? []),
    ]) {
      await copyFile(
        join(resourceRoot, 'runtimes', 'archives', component.archive),
        join(archives, component.archive),
      )
      // 保持 wheel 的固定来源域名约束；即使允许访问该地址也无法提供资源。
      component.url = target.python_packages?.includes(component)
        ? 'https://files.pythonhosted.org/must-not-download'
        : 'https://example.invalid/must-not-download'
    }
    for (const archive of target.workspace?.archives ?? []) {
      await copyFile(
        join(resourceRoot, 'runtimes', 'archives', archive.archive),
        join(archives, archive.archive),
      )
    }
    await writeFile(join(resources, 'runtimes', 'sources.json'), JSON.stringify(sources))
    // 真实准备程序持锁期间被强制终止，固定锁文件保留但不阻塞下一次准备。
    const output = join(resources, 'runtimes', 'unpacked')
    const child = spawn(
      executable,
      [
        'prepare-runtimes',
        '--sources',
        join(resources, 'runtimes', 'sources.json'),
        '--output',
        output,
        '--cache',
        archives,
        '--target',
        target.directory,
      ],
      { stdio: 'ignore' },
    )
    const exited = once(child, 'exit')
    try {
      const lock = join(output, `.prepare-${target.directory}.lock`)
      const deadline = Date.now() + 7000
      while (
        !(await stat(lock).then(
          () => true,
          () => false,
        ))
      ) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error('未观察到准备程序持锁')
        await setTimeout(5)
      }
      assert.equal((await stat(lock)).isFile(), true)
      assert.equal(child.kill('SIGKILL'), true)
      await exited
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
    prepareRuntimes(resources)
    const manifest = join(resolveRuntimeDirectory(resources), 'manifest.json')
    const before = await stat(manifest)
    prepareRuntimes(resources)
    assert.equal((await stat(manifest)).mtimeMs, before.mtimeMs)
    assert.deepEqual((await readdir(resources)).sort(), ['backend', 'runtimes'])
    await unlink(join(archives, target.python.archive))
    assert.throws(() => prepareRuntimes(resources))
    assert.equal((await stat(manifest)).mtimeMs, before.mtimeMs)
  },
)
