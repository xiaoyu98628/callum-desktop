import type { ChatResult, ChatMessage } from '../../../shared/chat.ts'
export function unwrap<T>(result: ChatResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
export function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
}
/** 界面保留有界的消息窗口；更早内容仍通过后端分页读取。 */
export function boundMessages(messages: ChatMessage[]): ChatMessage[] {
  const sorted = messages.toSorted((a, b) => a.sequence - b.sequence)
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
