import { compareMessages } from '../../../shared/chat.ts'
import type { ChatResult, ChatMessage } from '../../../shared/chat.ts'

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

  read(more: boolean): { offset: number; generation: number } {
    return { offset: more ? this.offset : 0, generation: this.generation }
  }

  changed(page: { generation: number }): boolean {
    return page.generation !== this.generation
  }

  /** 返回本次从首屏重读后是否可以继续原来的加载更多请求。 */
  finish(page: { offset: number; generation: number }, hasMore: boolean, more: boolean): boolean {
    this.mayRequireRefill = page.offset > 0 || hasMore
    if (this.changed(page)) return false
    this.offset = page.offset + 50
    return more && page.offset === 0 && hasMore
  }
}

export function unwrap<T>(result: ChatResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
export function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
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
