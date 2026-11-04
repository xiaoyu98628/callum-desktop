import type { ChatEvent } from '../../shared/chat.ts'

/** 每次只允许一条未确认通知；慢窗口只保留每个实体的最新快照。 */
export class ChatEventDelivery {
  private serial = 0
  private inFlight: number | null = null
  private readonly pending = new Map<string, { event: ChatEvent; bytes: number }>()
  private bytes = 0
  overloaded = false
  constructor(privateSend: (token: number, event: ChatEvent) => void) {
    this.send = privateSend
  }
  private readonly send: (token: number, event: ChatEvent) => void

  offer(event: ChatEvent): void {
    if (this.overloaded) return
    const key =
      event.change.kind === 'service' ? 'service' : `${event.change.kind}:${event.change.value.id}`
    const previous = this.pending.get(key)
    if (previous) this.bytes -= previous.bytes
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.pending.set(key, { event, bytes })
    this.bytes += bytes
    if (this.pending.size > 128 || this.bytes > 16 * 1024 * 1024) {
      this.pending.clear()
      this.bytes = 0
      this.overloaded = true
      this.pending.set('service', {
        event: {
          revision: event.revision,
          change: {
            kind: 'service',
            error: '界面更新积压，请重试加载对话；未完成的执行仍由服务管理。',
          },
        },
        bytes: 0,
      })
    }
    this.drain()
  }
  acknowledge(token: number): void {
    if (token !== this.inFlight) return
    this.inFlight = null
    this.drain()
  }
  reset(): void {
    this.pending.clear()
    this.bytes = 0
    this.inFlight = null
    this.overloaded = false
  }
  private drain(): void {
    if (this.inFlight !== null || !this.pending.size) return
    const first = [...this.pending.entries()].sort(
      (a, b) => a[1].event.revision - b[1].event.revision,
    )[0]
    if (!first) return
    const [key, entry] = first
    this.pending.delete(key)
    this.bytes -= entry.bytes
    this.inFlight = ++this.serial
    this.send(this.inFlight, entry.event)
  }
}
