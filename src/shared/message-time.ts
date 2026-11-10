import type { ChatMessage } from './chat.ts'

/** 历史缺失的完成时间保持未知，失败及中断消息只展示有依据的创建时间。 */
export function messageTime(
  message: Pick<ChatMessage, 'role' | 'status' | 'createdAt' | 'completedAt'>,
): { value: number; label: string } | null {
  if (message.status === 'completed' && message.completedAt !== null && message.completedAt > 0)
    return { value: message.completedAt, label: message.role === 'user' ? '发送时间' : '完成时间' }
  return message.createdAt !== null && message.createdAt > 0
    ? { value: message.createdAt, label: '创建时间' }
    : null
}

/** 按本地日历格式展示消息时间，跨午夜及夏令时使用日历日比较。 */
export function formatMessageTime(timestamp: number, now: number): string {
  const date = new Date(timestamp),
    today = new Date(now)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
  const days =
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
    86_400_000
  if (days === 0) return time
  if (days > 0 && days < 7) return `星期${'日一二三四五六'[date.getDay()]} ${time}`
  const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export function fullMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestamp))
}
