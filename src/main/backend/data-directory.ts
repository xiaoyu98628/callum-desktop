import { isAbsolute, join } from 'node:path'

/** 默认使用家目录；显式隔离配置将 Go 数据限定到该配置目录，测试不接触日常数据。 */
export function resolveBackendDataDirectory(
  homeDirectory: string,
  isolatedUserDataDirectory?: string,
): string {
  if (isolatedUserDataDirectory !== undefined) {
    if (!isAbsolute(isolatedUserDataDirectory)) throw new Error('隔离用户数据目录必须是绝对路径')
    return join(isolatedUserDataDirectory, 'backend')
  }
  if (!isAbsolute(homeDirectory)) throw new Error('用户家目录必须是绝对路径')
  return join(homeDirectory, '.callum')
}
