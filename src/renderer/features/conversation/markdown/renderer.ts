import { validateDocument, validateTexts } from './contract.ts'
import type { MarkdownDocument, MarkdownRequest } from './contract.ts'

export type RenderResult = { document: MarkdownDocument; texts: string[] } | { error: string }
export interface RenderWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  postMessage(request: MarkdownRequest): void
  terminate(): void
}
interface Client {
  generation: number
  revision: number
  receive: (result: RenderResult) => void
}
interface Scheduled {
  generation: number
  request: MarkdownRequest
}
interface Active extends Scheduled {
  timer: ReturnType<typeof setTimeout>
}

/** 一个窗口共用一个解析 Worker；队列只保留每条消息的最新快照。 */
export class MarkdownRenderer {
  private worker: RenderWorker | null = null
  private readonly clients = new Map<number, Client>()
  private readonly queue = new Map<number, Scheduled>()
  private serial = 0
  private active: Active | null = null
  private queuedLength = 0
  private failed = false
  private closed = false
  private readonly createWorker: () => RenderWorker

  constructor(
    createWorker: () => RenderWorker = () =>
      new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.createWorker = createWorker
  }

  register(receive: (result: RenderResult) => void) {
    if (this.closed || this.clients.size >= 200) throw new Error('消息较多，已按文本显示。')
    const id = ++this.serial
    this.clients.set(id, { generation: 0, revision: 0, receive })
    return {
      invalidate: (): void => {
        const client = this.clients.get(id)
        if (client) client.generation++
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
          this.queue.set(id, {
            generation: client.generation,
            request: { id, revision: client.revision, texts: validated },
          })
          this.queuedLength += length
          this.drain()
        } catch (error) {
          client.generation++
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
      this.queuedLength -= previous.request.texts.reduce((sum, text) => sum + text.length, 0)
      this.queue.delete(id)
    }
  }
  private drain(): void {
    if (this.active || !this.queue.size || this.closed || this.failed) return
    try {
      if (!this.worker) {
        this.worker = this.createWorker()
        this.worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data)
        this.worker.onerror = (event) => {
          event.preventDefault()
          this.fail()
        }
        this.worker.onmessageerror = () => this.fail()
      }
      const next = this.queue.values().next().value
      if (!next) return
      this.removeQueued(next.request.id)
      this.active = { ...next, timer: setTimeout(() => this.fail(), 3000) }
      this.worker.postMessage(next.request)
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
          ? { document: validateDocument(value.document), texts: active.request.texts }
          : { error: '消息排版失败，已按文本显示。' }
      const client = this.clients.get(active.request.id)
      clearTimeout(active.timer)
      this.active = null
      // 连续追加时允许已经完成的前缀先显示，不能因新快照排队而饿死当前结果。
      // 只有正文替换、回滚或卸载才使旧一代结果失效。
      if (client?.generation === active.generation) client.receive(result)
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
