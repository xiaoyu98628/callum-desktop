/** 跨进程契约共用的基本类型校验，不依赖具体业务模块。 */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('数据格式无效')
  return value as Record<string, unknown>
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('文本格式无效')
  return value
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('数字格式无效')
  return value
}
export function id(value: unknown): string {
  const result = string(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))
    throw new Error('标识无效')
  return result
}
export function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('列表格式无效')
  return value.map(parse)
}
