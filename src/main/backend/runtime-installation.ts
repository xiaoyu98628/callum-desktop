import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { record, string } from '../../shared/validation.ts'
import { withCleanup } from '../resource-cleanup.ts'

const maximumFiles = 30_000
const maximumBytes = 2 * 1024 * 1024 * 1024
const journalName = '.runtimes-install.json'
interface FileEntry {
  path: string
  size: number
  sha256: string
  link: string
}
interface Installation {
  stage: string
  backup: string
  digest: string
}

export function installedRuntimeDirectory(dataDirectory: string): string {
  if (!isAbsolute(dataDirectory)) throw new Error('运行时安装根目录必须是绝对路径')
  return join(dataDirectory, 'runtimes')
}

function localPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

async function privateRoot(path: string): Promise<void> {
  const info = await lstat(path)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('运行时安装目标必须是私有普通目录')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function manifestBytes(directory: string): Promise<Buffer> {
  const path = join(directory, 'manifest.json')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error('运行时清单必须是有界普通文件')
  return readFile(path)
}

function inventory(bytes: Buffer): FileEntry[] {
  const manifest = record(JSON.parse(bytes.toString('utf8')))
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch
  if (manifest.platform !== platform || manifest.arch !== architecture)
    throw new Error('运行时清单与当前平台不匹配')
  if (!Array.isArray(manifest.files) || manifest.files.length > maximumFiles)
    throw new Error('运行时文件清单数量无效')
  const files = manifest.files.map((item: unknown): FileEntry => {
    const value = record(item)
    const path = string(value.path)
    const link = value.link === undefined ? '' : string(value.link)
    const size = value.size === undefined ? 0 : Number(value.size)
    const sha256 = value.sha256 === undefined ? '' : string(value.sha256)
    if (
      !localPath(path) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (!link && !/^[a-f0-9]{64}$/.test(sha256))
    )
      throw new Error('运行时文件清单无效')
    if (
      link &&
      (isAbsolute(link) ||
        link.includes('\\') ||
        link.includes(':') ||
        link.includes('\0') ||
        !localPath(
          relative('/bundle', resolve('/bundle', dirname(path), link))
            .split('\\')
            .join('/'),
        ))
    )
      throw new Error('运行时链接越出安装目录')
    return { path, link, size, sha256 }
  })
  const names = new Set(files.map((entry) => entry.path.toLowerCase()))
  if (
    manifest.format_version !== 3 ||
    files.length === 0 ||
    files.length > maximumFiles ||
    names.size !== files.length ||
    files.reduce((sum, entry) => sum + entry.size, 0) > maximumBytes
  )
    throw new Error('运行时清单超过资源边界')
  return files
}

async function durableFile(path: string, data: Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  await withCleanup(
    async () => {
      await file.writeFile(data)
      await file.sync()
    },
    () => file.close(),
  )
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const file = await open(directory, 'r')
  await withCleanup(
    () => file.sync(),
    () => file.close(),
  )
}

async function removeTree(path: string): Promise<void> {
  if (!(await exists(path))) return
  const info = await lstat(path)
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(path, 0o700)
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await removeTree(join(path, entry.name))
  }
  await rm(path, { recursive: true, force: true })
}

async function readJournal(dataDirectory: string): Promise<Installation | null> {
  const path = join(dataDirectory, journalName)
  if (!(await exists(path))) return null
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error('运行时安装恢复记录无效')
  const value = record(JSON.parse(await readFile(path, 'utf8')))
  const stage = string(value.stage),
    backup = string(value.backup),
    digest = string(value.digest)
  if (
    !/^\.runtimes-install-[A-Za-z0-9]+$/.test(stage) ||
    backup !== `${stage}-previous` ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error('运行时安装恢复目标无效')
  return { stage, backup, digest }
}

async function verifyInstalled(directory: string, files: FileEntry[]): Promise<boolean> {
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      for (;;) {
        const entry = files[next++]
        if (!entry) return
        const path = join(directory, entry.path)
        const info = await lstat(path)
        if (entry.link) {
          if (!info.isSymbolicLink() || (await readlink(path)) !== entry.link)
            throw new Error('运行时链接不完整')
        } else {
          if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size)
            throw new Error('运行时文件不完整')
          const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          await withCleanup(
            async () => {
              const hash = createHash('sha256')
              for await (const chunk of file.createReadStream({ autoClose: false }))
                hash.update(chunk)
              if (hash.digest('hex') !== entry.sha256) throw new Error('运行时文件校验失败')
            },
            () => file.close(),
          )
        }
      }
    }),
  )
  return results.every((result) => result.status === 'fulfilled')
}

/** 调用方必须持有 Go resource-lock；恢复仅处理本安装器持久化登记的固定子目录。 */
async function recover(dataDirectory: string): Promise<void> {
  const state = await readJournal(dataDirectory)
  if (!state) return
  const target = installedRuntimeDirectory(dataDirectory)
  const backup = join(dataDirectory, state.backup)
  if (!(await exists(target)) && (await exists(backup))) {
    await rename(backup, target)
    await syncDirectory(dataDirectory)
  } else if (await exists(backup)) {
    await privateRoot(target)
    const bytes = await manifestBytes(target)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== state.digest) throw new Error('运行时安装状态不一致，保留原目录供核对')
    if (await verifyInstalled(target, inventory(bytes))) await removeTree(backup)
    else {
      await removeTree(target)
      await rename(backup, target)
      await syncDirectory(dataDirectory)
    }
  }
  await removeTree(join(dataDirectory, state.stage))
  await rm(join(dataDirectory, journalName))
  await syncDirectory(dataDirectory)
}

/** 将已准备资源安装到平铺 runtimes；调用方持有跨进程实例锁，并在取消后等待本函数清理。 */
export async function installRuntimeAssets(
  source: string,
  dataDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  if (!isAbsolute(source) || !isAbsolute(dataDirectory))
    throw new Error('运行时资源路径必须是绝对路径')
  await privateRoot(dataDirectory)
  await recover(dataDirectory)
  signal.throwIfAborted()
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('运行时资源必须是普通目录')
  const bytes = await manifestBytes(source)
  const files = inventory(bytes)
  const expected = new Set(files.map((entry) => entry.path))
  const directories = ['']
  let scanned = 0
  const checkSource = async (path: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error('运行时资源目录嵌套超过限制')
    signal.throwIfAborted()
    for (const item of await readdir(join(source, path), { withFileTypes: true })) {
      if (++scanned > maximumFiles * 2) throw new Error('运行时资源条目超过限制')
      const name = path ? `${path}/${item.name}` : item.name
      if (item.isDirectory()) {
        directories.push(name)
        await checkSource(name, depth + 1)
      } else if (
        name !== 'manifest.json' &&
        (!expected.delete(name) || (!item.isFile() && !item.isSymbolicLink()))
      )
        throw new Error('运行时资源包含清单外文件')
    }
  }
  await checkSource('', 0)
  if (expected.size) throw new Error('运行时资源缺少清单文件')
  const destination = installedRuntimeDirectory(dataDirectory)
  if (await exists(destination)) {
    await privateRoot(destination)
    if (
      bytes.equals(await manifestBytes(destination)) &&
      (await verifyInstalled(destination, files))
    )
      return destination
    // 无清单或非普通目录不会被当作可替换的客户端资源。
    inventory(await manifestBytes(destination))
  }
  const stage = await mkdtemp(join(dataDirectory, '.runtimes-install-'))
  const state = {
    stage: relative(dataDirectory, stage),
    backup: `${relative(dataDirectory, stage)}-previous`,
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  try {
    await durableFile(join(dataDirectory, journalName), Buffer.from(JSON.stringify(state)))
    await syncDirectory(dataDirectory)
  } catch (error) {
    await withCleanup(
      async () => {
        throw error
      },
      () => removeTree(stage),
    )
  }
  try {
    for (const directory of directories) {
      signal.throwIfAborted()
      if (directory) await mkdir(join(stage, directory), { recursive: true, mode: 0o700 })
    }
    let next = 0
    const copyController = new AbortController()
    const copyingSignal = AbortSignal.any([signal, copyController.signal])
    const regular = files.filter((entry) => !entry.link)
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, regular.length) }, async () => {
        try {
          for (;;) {
            copyingSignal.throwIfAborted()
            const entry = regular[next++]
            if (!entry) return
            const original = join(source, entry.path),
              output = join(stage, entry.path)
            const info = await lstat(original)
            if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size)
              throw new Error('运行时资源在安装期间发生变化')
            await mkdir(dirname(output), { recursive: true, mode: 0o700 })
            await copyFile(original, output, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
            const file = await open(output, 'r')
            await withCleanup(
              async () => {
                const hash = createHash('sha256')
                let length = 0
                for await (const chunk of file.createReadStream({
                  autoClose: false,
                  signal: copyingSignal,
                })) {
                  length += chunk.length
                  if (length > entry.size) throw new Error('运行时复制超过声明大小')
                  hash.update(chunk)
                }
                if (length !== entry.size || hash.digest('hex') !== entry.sha256)
                  throw new Error('运行时复制校验失败')
                // 程序资源可从客户端重建；逐文件验证内容，目录及安装记录单独同步。
                // 后续启动仍校验全部文件，残缺副本会重新安装，不把资源当作业务数据提交。
              },
              () => file.close(),
            )
            await chmod(output, info.mode & 0o111 ? 0o500 : 0o400)
          }
        } catch (error) {
          copyController.abort(error)
          throw error
        }
      }),
    )
    const failed = workers.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    for (const entry of files.filter((item) => item.link)) {
      signal.throwIfAborted()
      const original = join(source, entry.path)
      if ((await readlink(original)) !== entry.link) throw new Error('运行时资源链接发生变化')
      const output = join(stage, entry.path)
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      await symlink(entry.link, output)
    }
    await durableFile(join(stage, 'manifest.json'), bytes)
    for (const directory of directories.toSorted((a, b) => b.length - a.length)) {
      signal.throwIfAborted()
      await syncDirectory(join(stage, directory))
    }
    signal.throwIfAborted()
    if (await exists(destination)) await rename(destination, join(dataDirectory, state.backup))
    await rename(stage, destination)
    await syncDirectory(dataDirectory)
    await removeTree(join(dataDirectory, state.backup))
    await rm(join(dataDirectory, journalName))
    await syncDirectory(dataDirectory)
    return destination
  } catch (error) {
    await withCleanup(
      async () => {
        throw error
      },
      () => recover(dataDirectory),
    )
    throw error
  }
}
