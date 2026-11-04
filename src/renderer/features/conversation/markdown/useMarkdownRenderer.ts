import { inject, onScopeDispose, provide } from 'vue'
import type { InjectionKey } from 'vue'
import { validateDocument, validateTexts } from './contract'
import type { MarkdownDocument, MarkdownRequest } from './contract'

type RenderResult = { document: MarkdownDocument } | { error: string }
interface Client {
  revision: number
  receive: (result: RenderResult) => void
}
interface Active {
  request: MarkdownRequest
  timer: ReturnType<typeof setTimeout>
}

/** 一个窗口共用一个解析 Worker；队列只保留每条消息的最新快照。 */
class MarkdownRenderer {
  private worker: Worker | null = null
  private readonly clients = new Map<number, Client>()
  private readonly queue = new Map<number, MarkdownRequest>()
  private serial = 0
  private active: Active | null = null
  private queuedLength = 0
  private failed = false
  private closed = false

  register(receive: (result: RenderResult) => void) {
    if (this.closed || this.clients.size >= 200) throw new Error('消息较多，已按文本显示。')
    const id = ++this.serial
    this.clients.set(id, { revision: 0, receive })
    return {
      invalidate: (): void => {
        const client = this.clients.get(id)
        if (client) client.revision++
        this.removeQueued(id)
      },
      render: (texts: string[]): void => {
        const client = this.clients.get(id)
        if (!client || this.closed) return
        client.revision++
        this.removeQueued(id)
        if (this.failed) {
          receive({ error: '消息排版暂不可用，已按文本显示。' })
          return
        }
        try {
          const validated = validateTexts(texts)
          const length = validated.reduce((sum, text) => sum + text.length, 0)
          if (this.queuedLength + length > 4 * 1024 * 1024)
            throw new Error('排版内容较多，已按文本显示。')
          this.queue.set(id, { id, revision: client.revision, texts: validated })
          this.queuedLength += length
          this.drain()
        } catch (error) {
          receive({
            error: error instanceof Error ? error.message : '消息排版失败，已按文本显示。',
          })
        }
      },
      dispose: (): void => {
        this.clients.delete(id)
        this.removeQueued(id)
      },
    }
  }
  private removeQueued(id: number): void {
    const previous = this.queue.get(id)
    if (previous) {
      this.queuedLength -= previous.texts.reduce((sum, text) => sum + text.length, 0)
      this.queue.delete(id)
    }
  }
  private drain(): void {
    if (this.active || !this.queue.size || this.closed || this.failed) return
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), {
          type: 'module',
        })
        this.worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data)
        this.worker.onerror = (event) => {
          event.preventDefault()
          this.fail()
        }
        this.worker.onmessageerror = () => this.fail()
      }
      const request = this.queue.values().next().value
      if (!request) return
      this.removeQueued(request.id)
      this.active = { request, timer: setTimeout(() => this.fail(), 3000) }
      this.worker.postMessage(request)
    } catch {
      this.fail()
    }
  }
  private receive(value: unknown): void {
    if (this.closed || !this.active) return
    const active = this.active
    try {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        !('revision' in value) ||
        value.id !== active.request.id ||
        value.revision !== active.request.revision
      )
        throw new Error('排版响应不匹配')
      const result: RenderResult =
        'document' in value
          ? { document: validateDocument(value.document) }
          : { error: '消息排版失败，已按文本显示。' }
      const client = this.clients.get(active.request.id)
      clearTimeout(active.timer)
      this.active = null
      if (client?.revision === active.request.revision) client.receive(result)
      this.drain()
    } catch {
      this.fail()
    }
  }
  private fail(): void {
    if (this.closed || this.failed) return
    this.failed = true
    if (this.active) clearTimeout(this.active.timer)
    this.active = null
    this.worker?.terminate()
    this.worker = null
    this.queue.clear()
    this.queuedLength = 0
    for (const client of this.clients.values())
      client.receive({ error: '消息排版暂不可用，已按文本显示。' })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.active) clearTimeout(this.active.timer)
    this.active = null
    this.worker?.terminate()
    this.worker = null
    this.clients.clear()
    this.queue.clear()
    this.queuedLength = 0
  }
}
const key: InjectionKey<MarkdownRenderer> = Symbol('markdown-renderer')
export function provideMarkdownRenderer(): void {
  const renderer = new MarkdownRenderer()
  provide(key, renderer)
  onScopeDispose(() => renderer.close())
}
export function useMarkdownRenderer(): MarkdownRenderer {
  const renderer = inject(key)
  if (!renderer) throw new Error('消息排版上下文未初始化')
  return renderer
}
