import type { InjectionKey } from 'vue'
import type { AttachmentPreview } from '../../../shared/attachments.ts'
import type { AttachmentItem } from './attachment-files.ts'

type Kind = 'full' | 'thumbnail'
type Value = AttachmentPreview | string
interface Waiter {
  kind: Kind
  resolve: (value: Value) => void
  reject: (error: Error) => void
  stop: () => void
}
interface Job {
  key: string
  item: AttachmentItem
  generation: number
  started: boolean
  waiters: Set<Waiter>
}

// 两种缓存独立计数，缩略图不会被大图挤出；字符串按每字符两字节预留。
class Cache<T> {
  private entries = new Map<string, { value: T; bytes: number }>()
  private bytes = 0
  private readonly maxBytes: number
  private readonly maxEntries: number
  constructor(maxBytes: number, maxEntries: number) {
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }
  set(key: string, value: T, bytes: number): void {
    const old = this.entries.get(key)
    if (old) {
      this.bytes -= old.bytes
      this.entries.delete(key)
    }
    if (bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const first = this.entries.entries().next().value
      if (!first) break
      this.entries.delete(first[0])
      this.bytes -= first[1].bytes
    }
  }
  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }
}

/** 由对话页面持有。切换会话清理，页面卸载关闭；共享读取不因单个消费者退出而中止。 */
export class AttachmentPreviews {
  private readonly fullCache = new Cache<AttachmentPreview>(16 * 1024 * 1024, 32)
  private readonly thumbnails = new Cache<string>(4 * 1024 * 1024, 128)
  private readonly files = new WeakMap<File, string>()
  private readonly jobs = new Map<string, Job>()
  private queue: Job[] = []
  private serial = 0
  private active = 0
  private activeDrafts = 0
  private generation = 0
  private closed = false
  private readonly read: (item: AttachmentItem) => Promise<AttachmentPreview>
  private readonly render: (preview: AttachmentPreview) => Promise<string>

  constructor(
    read: (item: AttachmentItem) => Promise<AttachmentPreview>,
    render: (preview: AttachmentPreview) => Promise<string> = renderThumbnail,
  ) {
    this.read = read
    this.render = render
  }

  key(item: AttachmentItem): string {
    if (item.source instanceof File) {
      let key = this.files.get(item.source)
      if (!key) {
        key = `draft:${++this.serial}`
        this.files.set(item.source, key)
      }
      return key
    }
    return item.key ?? `${item.source.conversationId}/${item.source.messageId}/${item.source.index}`
  }
  full(item: AttachmentItem, signal: AbortSignal): Promise<AttachmentPreview> {
    return this.get(item, 'full', signal).then((value) => {
      if (typeof value === 'string') throw new Error('图片预览格式无效')
      return value
    })
  }
  thumbnail(item: AttachmentItem, signal: AbortSignal): Promise<string> {
    return this.get(item, 'thumbnail', signal).then((value) => {
      if (typeof value !== 'string') throw new Error('缩略图格式无效')
      return value
    })
  }
  private get(item: AttachmentItem, kind: Kind, signal: AbortSignal): Promise<Value> {
    if (this.closed || signal.aborted) return Promise.reject(cancelled())
    const key = this.key(item)
    const cached = kind === 'full' ? this.fullCache.get(key) : this.thumbnails.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    let job = this.jobs.get(key)
    if (!job) {
      if (this.queue.length >= 32) return Promise.reject(new Error('图片加载繁忙，请稍后重试。'))
      job = { key, item, generation: this.generation, started: false, waiters: new Set() }
      this.jobs.set(key, job)
      this.queue.push(job)
    }
    const fixed = job
    return new Promise<Value>((resolve, reject) => {
      const abort = (): void => {
        fixed.waiters.delete(waiter)
        waiter.stop()
        reject(cancelled())
        if (!fixed.started && !fixed.waiters.size) {
          this.queue = this.queue.filter((job) => job !== fixed)
          if (this.jobs.get(key) === fixed) this.jobs.delete(key)
        }
      }
      const waiter: Waiter = {
        kind,
        resolve,
        reject,
        stop: () => signal.removeEventListener('abort', abort),
      }
      fixed.waiters.add(waiter)
      signal.addEventListener('abort', abort, { once: true })
      this.pump()
    })
  }
  private pump(): void {
    while (!this.closed && this.active < 2 && this.queue.length) {
      // 草稿预览需要主进程暂存文件，同时只占一个传输名额，为用户发送保留名额。
      const index = this.queue.findIndex(
        (job) => !(job.item.source instanceof File) || this.activeDrafts === 0,
      )
      if (index < 0) break
      const job = this.queue.splice(index, 1)[0]!
      if (!job.waiters.size) continue
      job.started = true
      this.active++
      const draft = job.item.source instanceof File
      if (draft) this.activeDrafts++
      void this.run(job).finally(() => {
        this.active--
        if (draft) this.activeDrafts--
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
        this.pump()
      })
    }
  }
  private valid(job: Job): boolean {
    return !this.closed && job.generation === this.generation && job.waiters.size > 0
  }
  private async run(job: Job): Promise<void> {
    try {
      const preview = this.fullCache.get(job.key) ?? (await this.read(job.item))
      if (!this.valid(job)) return
      this.fullCache.set(job.key, preview, (preview.mime.length + preview.data.length) * 2)
      let thumbnail: string | undefined
      let renderError: Error | undefined
      try {
        thumbnail = this.thumbnails.get(job.key) ?? (await this.render(preview))
      } catch (cause) {
        renderError = cause instanceof Error ? cause : new Error('无法生成缩略图。')
      }
      if (!this.valid(job)) return
      if (thumbnail !== undefined) this.thumbnails.set(job.key, thumbnail, thumbnail.length * 2)
      for (const waiter of job.waiters) {
        waiter.stop()
        if (waiter.kind === 'full') waiter.resolve(preview)
        else if (thumbnail !== undefined) waiter.resolve(thumbnail)
        else waiter.reject(renderError ?? new Error('无法生成缩略图。'))
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('无法读取图片。')
      for (const waiter of job.waiters) {
        waiter.stop()
        waiter.reject(error)
      }
    } finally {
      job.waiters.clear()
    }
  }
  clear(): void {
    this.generation++
    for (const job of this.jobs.values()) {
      for (const waiter of job.waiters) {
        waiter.stop()
        waiter.reject(cancelled())
      }
      job.waiters.clear()
    }
    this.jobs.clear()
    this.queue = []
    this.fullCache.clear()
    this.thumbnails.clear()
  }
  close(): void {
    this.closed = true
    this.clear()
  }
}

function cancelled(): Error {
  return new DOMException('图片读取已取消', 'AbortError')
}

async function renderThumbnail(preview: AttachmentPreview): Promise<string> {
  const bytes = Uint8Array.from(atob(preview.data), (character) => character.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: preview.mime }))
  try {
    const ratio = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height))
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * ratio)),
      Math.max(1, Math.round(bitmap.height * ratio)),
    )
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法生成缩略图。')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
    if (blob.size > 256 * 1024) throw new Error('缩略图超过处理上限。')
    // 使用现有 CSP 允许的 data URL；关闭位图后不保留原图解码资源。
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('缩略图格式无效'))
      reader.onerror = () => reject(new Error('无法生成缩略图。'))
      reader.readAsDataURL(blob)
    })
  } finally {
    bitmap.close()
  }
}

export const attachmentPreviewsKey: InjectionKey<AttachmentPreviews> = Symbol('attachment-previews')
