/** 只描述界面需要的数据，不依赖 Electron、Node.js 或 Vue。 */
export interface AppInfo {
  name: string
  version: string
  platform: 'darwin' | 'win32' | 'linux'
}

/** preload 暴露的能力清单，每个方法对应固定的用途。 */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>
}

/** 通信边界使用运行时校验，不能仅信任静态类型。 */
export function parseAppInfo(value: unknown): AppInfo {
  if (typeof value !== 'object' || value === null) {
    throw new Error('无效的应用信息')
  }

  if (
    !('name' in value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    !('platform' in value) ||
    (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux')
  ) {
    throw new Error('无效的应用信息')
  }

  return { name: value.name, version: value.version, platform: value.platform }
}
