import { Subscriptions } from './subscriptions.ts'
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
  private readonly listeners: Subscriptions<ChatEvent>
  constructor(reportSubscriberFailure?: () => void) {
    this.listeners = new Subscriptions(reportSubscriberFailure)
  }

  get revision(): number {
    return this.latestRevision
  }

  /** 注册实时通知，返回可重复调用的取消订阅函数。 */
  subscribe(listener: (event: ChatEvent) => void): () => void {
    if (this.closed) return () => {}
    return this.listeners.add(listener)
  }

  publish(change: ChatChange): void {
    if (this.closed) return
    // 通知与写操作返回可携带同一快照，只抑制同一会话最近一次完全相同的内容。
    // 不按时间戳推测新旧，也不合并消息移除或流式事件。
    if (change.kind === 'conversation') {
      const previous = this.history.findLast(
        ({ event }) =>
          event.change.kind === 'conversation' && event.change.value.id === change.value.id,
      )
      if (previous && JSON.stringify(previous.event.change) === JSON.stringify(change)) return
    }
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
    this.listeners.emit(event)
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
    this.listeners.close()
  }
}
