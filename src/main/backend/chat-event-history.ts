import type { ChatChange, ChatEvent } from '../../shared/chat.ts'

const MAX_EVENTS = 512
const MAX_BYTES = 16 * 1024 * 1024

export type SnapshotChange = Exclude<ChatChange, { kind: 'service' }>

/** 为同一个对话服务分配事件版本，并保留查询期间可回放的有界记录。 */
export class ChatEventHistory {
  private latestRevision = 0
  private droppedRevision = 0
  private bytes = 0
  private closed = false
  private readonly history: { event: ChatEvent; bytes: number }[] = []
  private readonly listeners = new Set<(event: ChatEvent) => void>()

  get revision(): number {
    return this.latestRevision
  }

  /** 注册实时通知，返回可重复调用的取消订阅函数。 */
  subscribe(listener: (event: ChatEvent) => void): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(change: ChatChange): void {
    if (this.closed) return
    const event = { revision: this.latestRevision + 1, change }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.latestRevision = event.revision
    this.history.push({ event, bytes })
    this.bytes += bytes
    while (this.history.length > MAX_EVENTS || this.bytes > MAX_BYTES) {
      const oldest = this.history.shift()!
      this.bytes -= oldest.bytes
      this.droppedRevision = oldest.event.revision
    }
    for (const listener of this.listeners) listener(event)
  }

  /** 按发布顺序回放查询期间的变更。记录缺失或连接中断时拒绝返回局部快照。 */
  *changesSince(revision: number): IterableIterator<SnapshotChange> {
    if (this.closed) throw new Error('对话服务正在关闭。')
    if (revision < this.droppedRevision) throw new Error('对话内容变化较快，请重新加载。')
    const replay = this.history.filter(({ event }) => event.revision > revision)
    for (const { event } of replay) {
      if (event.change.kind === 'service') throw new Error(event.change.error)
      yield event.change
    }
  }

  /** 应用关闭时释放历史与订阅，并忽略仍在收尾的任务发出的通知。 */
  close(): void {
    this.closed = true
    this.history.length = 0
    this.bytes = 0
    this.listeners.clear()
  }
}
