import { execFileSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveResourceTarget } from '../src/main/backend/runtime-assets.ts'

/** 使用随附服务离线校验、解压仓库归档，不依赖 Go 源码或本机 Go 环境。 */
export function prepareRuntimes(resources: string, all = false): void {
  if (!isAbsolute(resources)) throw new Error('资源根目录必须是绝对路径')
  const target = resolveResourceTarget()
  const executable = join(
    resources,
    'backend',
    target,
    process.platform === 'win32' ? 'callum.exe' : 'callum',
  )
  const args = [
    'prepare-runtimes',
    '--sources',
    join(resources, 'runtimes', 'sources.json'),
    '--output',
    join(resources, 'runtimes', 'unpacked'),
    '--cache',
    join(resources, 'runtimes', 'archives'),
  ]
  if (!all) args.push('--target', target)
  // 子进程只执行有界的本地文件操作，超时发送 SIGTERM，由 Go 清理本次暂存资源和锁。
  execFileSync(executable, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 120_000,
    windowsHide: true,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--all'))
      throw new Error('仅支持可选参数 --all')
    prepareRuntimes(fileURLToPath(new URL('../resources/', import.meta.url)), args[0] === '--all')
  } catch (error) {
    console.error('离线运行时准备失败：', error instanceof Error ? error.message : '未知错误')
    process.exitCode = 1
  }
}
