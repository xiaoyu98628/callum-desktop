import { record, string } from './validation.ts'

export interface Skill {
  name: string
  description: string
  path: string
}

/** 只接收 Go 发现的目录元数据，路径仅用于区分同名技能。 */
export function parseSkills(value: unknown): Skill[] {
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024
  )
    throw new Error('技能列表格式无效')
  const paths = new Set<string>()
  return value.map((item: unknown) => {
    const row = record(item)
    const name = string(row.name)
    const description = string(row.description)
    const path = string(row.path)
    if (!name.trim() || !description.trim() || !path || paths.has(path))
      throw new Error('技能元数据格式无效')
    paths.add(path)
    return { name, description, path }
  })
}
