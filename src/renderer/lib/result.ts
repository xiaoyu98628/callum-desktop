import type { ChatResult } from '../../shared/chat.ts'

/** 将桌面业务结果转换为调用方的异常边界，不依赖具体功能模块。 */
export function unwrap<T>(result: ChatResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
