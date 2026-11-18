import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { withCleanup } from '../resource-cleanup.ts'

const maximumFiles = 4096
const maximumFileBytes = 8 * 1024 * 1024
const maximumTotalBytes = 64 * 1024 * 1024

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  })
  const info = await lstat(path)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error('技能安装目标必须是私有普通目录')
}

async function matches(directory: string, expected: Record<string, string>): Promise<boolean> {
  let count = 0,
    bytes = 0
  const seen = new Set<string>()
  const scan = async (path: string, depth: number): Promise<boolean> => {
    if (depth > 12) return false
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      if (++count > maximumFiles || entry.isSymbolicLink()) return false
      const name = path ? join(path, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (!(await scan(name, depth + 1))) return false
      } else {
        const key = name.split('\\').join('/')
        if (!entry.isFile() || !expected[key]) return false
        const info = await lstat(join(directory, name))
        bytes += info.size
        if (
          info.size > maximumFileBytes ||
          bytes > maximumTotalBytes ||
          createHash('sha256')
            .update(await readFile(join(directory, name)))
            .digest('hex') !== expected[key]
        )
          return false
        seen.add(key)
      }
    }
    return true
  }
  return (await scan('', 0)) && seen.size === Object.keys(expected).length
}

async function backup(directory: string, path: string, name: string): Promise<void> {
  await privateDirectory(directory)
  await rename(path, join(directory, `${name}-${randomUUID()}`))
}

/** 客户端安装随附技能；Go 只读取数据目录，不包含或分发技能资源。 */
export async function installSkillAssets(
  resourceRoot: string,
  dataDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isAbsolute(resourceRoot) || !isAbsolute(dataDirectory))
    throw new Error('技能资源与数据目录必须是绝对路径')
  const source = join(resourceRoot, 'skills', '.system')
  const skillRoot = join(dataDirectory, 'skills')
  await privateDirectory(skillRoot)
  const destination = join(skillRoot, '.system')
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('随附技能资源必须是普通目录')
  await mkdir(destination, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  })
  const destinationInfo = await lstat(destination)
  if (
    !destinationInfo.isDirectory() ||
    destinationInfo.isSymbolicLink() ||
    (process.platform !== 'win32' && (destinationInfo.mode & 0o077) !== 0)
  )
    throw new Error('技能安装目标必须是私有普通目录')

  let count = 0
  let total = 0
  const inventory = async (directory: string, depth: number): Promise<string[]> => {
    if (depth > 12) throw new Error('随附技能目录嵌套超过限制')
    const files: string[] = []
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      if (++count > maximumFiles) throw new Error('随附技能文件数量超过限制')
      const relative = join(directory, entry.name)
      const info = await lstat(join(source, relative))
      if (info.isSymbolicLink()) throw new Error('随附技能不接受符号链接')
      if (info.isDirectory()) files.push(...(await inventory(relative, depth + 1)))
      else if (info.isFile() && info.size <= maximumFileBytes) {
        total += info.size
        if (total > maximumTotalBytes) throw new Error('随附技能资源总量超过限制')
        files.push(relative)
      } else throw new Error('随附技能包含特殊文件或超限文件')
    }
    return files
  }

  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted()
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.'))
      throw new Error('随附技能根目录只允许独立的技能目录')
    const files = await inventory(entry.name, 1)
    if (!files.includes(join(entry.name, 'SKILL.md'))) throw new Error('随附技能缺少 SKILL.md')
    const target = join(destination, entry.name)
    const expected: Record<string, string> = {}
    for (const name of files)
      expected[
        name
          .slice(entry.name.length + 1)
          .split('\\')
          .join('/')
      ] = createHash('sha256')
        .update(await readFile(join(source, name)))
        .digest('hex')
    let existing = false
    try {
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('已有同名技能不是普通目录')
      if (await matches(target, expected)) continue
      existing = true
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const staging = await mkdtemp(join(destination, '.install-'))
    await withCleanup(
      async () => {
        for (const file of files) {
          signal?.throwIfAborted()
          const relative = file.slice(entry.name.length + 1)
          const parts = relative.split(/[\\/]/)
          parts.pop()
          if (parts.length) await mkdir(join(staging, ...parts), { recursive: true, mode: 0o700 })
          const input = await open(join(source, file), 'r')
          await withCleanup(
            async () => {
              const info = await input.stat()
              if (!info.isFile() || info.size > maximumFileBytes)
                throw new Error('技能源文件在复制期间发生变化')
              const data = Buffer.alloc(info.size)
              let offset = 0
              while (offset < data.length) {
                const { bytesRead } = await input.read(data, offset, data.length - offset)
                if (bytesRead === 0) throw new Error('技能源文件读取不完整')
                offset += bytesRead
              }
              const output = await open(join(staging, relative), 'wx', 0o600)
              await withCleanup(
                async () => {
                  await output.writeFile(data)
                  await output.sync()
                },
                () => output.close(),
              )
            },
            () => input.close(),
          )
        }
        const current = await lstat(destination)
        if (current.ino !== destinationInfo.ino || current.dev !== destinationInfo.dev)
          throw new Error('技能安装根目录身份已变化')
        if (existing) await backup(join(skillRoot, '.system-backups'), target, entry.name)
        await rename(staging, target)
      },
      () => rm(staging, { recursive: true, force: true }),
    )
  }
  // 旧安装器未记录所有权，仅完整匹配已知旧随附内容时迁移；修改过的用户目录原位保留。
  const legacyPath = join(resourceRoot, 'skills', 'legacy-manifest.json')
  const legacyInfo = await lstat(legacyPath)
  if (!legacyInfo.isFile() || legacyInfo.isSymbolicLink() || legacyInfo.size > 1024 * 1024)
    throw new Error('旧技能迁移清单无效')
  const legacy: unknown = JSON.parse(await readFile(legacyPath, 'utf8'))
  if (typeof legacy !== 'object' || !legacy) throw new Error('旧技能迁移清单无效')
  for (const [name, expected] of Object.entries(legacy)) {
    signal?.throwIfAborted()
    if (
      !name ||
      name.startsWith('.') ||
      /[/\\:]/.test(name) ||
      typeof expected !== 'object' ||
      !expected ||
      Array.isArray(expected) ||
      !Object.values(expected).every(
        (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
      )
    )
      throw new Error('旧技能迁移目标无效')
    const path = join(skillRoot, name)
    try {
      const info = await lstat(path)
      if (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        (await matches(path, expected as Record<string, string>))
      )
        await backup(join(skillRoot, '.legacy-backups'), path, name)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
}
