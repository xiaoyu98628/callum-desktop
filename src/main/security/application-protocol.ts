import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { PRODUCTION_CSP } from './content-security-policy'
import { APPLICATION_SCHEME, resolveRendererAsset } from './renderer-policy'

export function registerApplicationScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APPLICATION_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

/** 生命周期由应用持有，应用退出时撤销协议处理器。 */
export function registerApplicationProtocol(rendererRoot: string): () => void {
  protocol.handle(APPLICATION_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    const path = resolveRendererAsset(rendererRoot, request.url)
    if (!path) return new Response(null, { status: 403 })

    try {
      const response = await net.fetch(pathToFileURL(path).href, { method: request.method })
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', PRODUCTION_CSP)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  return () => protocol.unhandle(APPLICATION_SCHEME)
}
