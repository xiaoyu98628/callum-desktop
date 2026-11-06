import { isAbsolute, relative, resolve, sep } from 'node:path'

export const APPLICATION_SCHEME = 'callum'
export const APPLICATION_URL = 'callum://app/'

export function resolveRendererUrl(developmentUrl?: string): string {
  if (!developmentUrl) return APPLICATION_URL

  const url = new URL(developmentUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('开发界面只允许来自本机开发服务器')
  }
  return url.href
}

export function isTrustedRendererUrl(value: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(value)
    const expected = new URL(rendererUrl)
    // Node.js 将非标准网络协议的 origin 表示为 null，不能用 origin 判断自定义协议。
    return (
      candidate.protocol === expected.protocol &&
      candidate.hostname === expected.hostname &&
      candidate.port === expected.port &&
      candidate.pathname === expected.pathname &&
      candidate.search === expected.search &&
      !candidate.username &&
      !candidate.password
    )
  } catch {
    return false
  }
}

/** 只允许读取构建后的界面目录，拒绝编码后的跨目录与 Windows 路径。 */
export function resolveRendererAsset(rendererRoot: string, requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl)
    if (
      url.protocol !== 'callum:' ||
      url.hostname !== 'app' ||
      url.port ||
      url.username ||
      url.password
    )
      return null
    const pathname = decodeURIComponent(url.pathname)
    if (pathname.includes('\\') || pathname.includes('\0')) return null
    const file = resolve(rendererRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
    const relation = relative(rendererRoot, file)
    if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation))
      return null
    return file
  } catch {
    return null
  }
}
