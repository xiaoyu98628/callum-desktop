import { chatEventBufferKey, compareMessages, PAGE_SIZE } from '../../../shared/chat.ts'
import type { ChatEvent, ChatResult, ChatMessage } from '../../../shared/chat.ts'

/** 列表有增删或重排时，旧偏移不能继续使用。 */
export class ListPagination {
  private offset = 0
  private generation = 0
  private mayRequireRefill = false

  invalidate(): boolean {
    this.offset = 0
    this.generation++
    return this.mayRequireRefill
  }

  /** 一次加载更多可以重读首屏并继续追加，返回最后一次读取是否成功提交。 */
  async load<T>(
    more: boolean,
    isCurrent: () => boolean,
    read: (offset: number) => Promise<ChatResult<T>>,
    commit: (value: T, append: boolean) => boolean,
  ): Promise<boolean> {
    let remainingRecoveries = 2
    while (isCurrent()) {
      const offset = more ? this.offset : 0
      const generation = this.generation
      const result = await read(offset)
      if (!isCurrent()) return false
      if (more && generation !== this.generation) {
        // 变更可能发生在追加页或补读首屏期间，两种情况都从新偏移开始。
        if (remainingRecoveries === 0) return false
        remainingRecoveries--
        continue
      }
      const hasMore = commit(unwrap(result), offset > 0)
      this.mayRequireRefill = offset > 0 || hasMore
      if (generation === this.generation) this.offset = offset + PAGE_SIZE
      if (!more || offset > 0 || !hasMore) return true
    }
    return false
  }
}

interface ListQuery {
  generation: number
  events: Map<string, ChatEvent>
}

export function createListQuery(): ListQuery {
  return { generation: 0, events: new Map() }
}

/** 只允许最新查询提交结果并清理本次缓冲。 */
export function startListQuery(query: ListQuery) {
  const generation = ++query.generation
  query.events.clear()
  const isCurrent = () => query.generation === generation
  return {
    isCurrent,
    finish(): boolean {
      if (!isCurrent()) return false
      query.events.clear()
      return true
    },
  }
}

export function cancelListQuery(query: ListQuery): void {
  query.generation++
  query.events.clear()
}

/** 返回 false 表示缓冲超限，查询已失效。 */
export function bufferListEvent(query: ListQuery, event: ChatEvent): boolean {
  const key = chatEventBufferKey(event)
  const previous = query.events.get(key)
  if (!previous || previous.revision < event.revision) query.events.set(key, event)
  if (query.events.size <= 500) return true
  cancelListQuery(query)
  return false
}

export function replayListEvents(
  query: ListQuery,
  revision: number,
  apply: (event: ChatEvent) => void,
): void {
  const events = [...query.events.values()].sort((a, b) => a.revision - b.revision)
  for (const event of events) if (event.revision > revision) apply(event)
}

/** 首屏以新快照为准，追加时同一 ID 使用新页数据。 */
export function mergeListPage<T extends { id: string }>(
  current: T[],
  incoming: T[],
  append: boolean,
): T[] {
  if (!append) return incoming
  return [...new Map([...current, ...incoming].map((item) => [item.id, item])).values()]
}

export function unwrap<T>(result: ChatResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
/** 界面保留有界的消息窗口；更早内容仍通过后端分页读取。 */
export function boundMessages(messages: ChatMessage[]): ChatMessage[] {
  const sorted = messages.toSorted(compareMessages)
  const sizes = new Map<string, { chars: number; count: number }>()
  for (const message of sorted) {
    const value = sizes.get(message.runId) ?? { chars: 0, count: 0 }
    value.chars += message.content.reduce(
      (sum, block) => sum + block.text.length + block.path.length,
      0,
    )
    value.count++
    sizes.set(message.runId, value)
  }
  const retained = new Set<string>()
  let chars = 0,
    count = 0
  for (const message of sorted.toReversed()) {
    if (retained.has(message.runId)) continue
    const size = sizes.get(message.runId)!
    if (retained.size && (chars + size.chars > 4 * 1024 * 1024 || count + size.count > 200)) break
    retained.add(message.runId)
    chars += size.chars
    count += size.count
  }
  return sorted.filter((message) => retained.has(message.runId))
}
