import { isAbsolute, join } from 'node:path'

/** Callum 与运行时均选择客户端匹配的原生架构，不使用跨架构兼容层。 */
export function resolveResourceTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if ((platform === 'darwin' || platform === 'win32') && ['arm64', 'x64'].includes(architecture))
    return `${platform}-${architecture}`
  throw new Error(`当前没有适用于 ${platform}-${architecture} 的资源。`)
}

/** 返回离线准备后的完整目录；归档不在应用启动时解压。 */
export function resolveRuntimeDirectory(
  resourceRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (!isAbsolute(resourceRoot)) throw new Error('运行时资源根目录必须是绝对路径')
  return join(resourceRoot, 'runtimes', 'unpacked', resolveResourceTarget(platform, architecture))
}
