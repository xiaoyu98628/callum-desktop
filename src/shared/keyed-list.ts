/** 移除同 ID 的旧项，把新项追加到末尾，其余项保持原顺序。 */
export function upsert<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
}
