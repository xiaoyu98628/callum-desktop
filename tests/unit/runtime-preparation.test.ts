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
      }[]
    }
    const target = sources.targets.find((entry) => entry.directory === resolveResourceTarget())
    assert.ok(target)
    const archives = join(resources, 'runtimes', 'archives')
    await mkdir(archives, { recursive: true })
    for (const component of [target.python, target.node, target.git]) {
      await copyFile(
        join(resourceRoot, 'runtimes', 'archives', component.archive),
        join(archives, component.archive),
      )
      component.url = 'https://example.invalid/must-not-download'
    }
    await writeFile(join(resources, 'runtimes', 'sources.json'), JSON.stringify(sources))
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
