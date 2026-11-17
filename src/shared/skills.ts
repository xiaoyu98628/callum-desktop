import { record, string } from './validation.ts'

export interface Skill {
  name: string
  description: string
  path: string
}

export interface SkillReference {
  name: string
  path?: string
}

interface SkillMessage extends SkillReference {
  body: string
}

export function formatSkillPrefix(skill: SkillReference): string {
  const location = skill.path ? `（入口 ${JSON.stringify(skill.path)}）` : ''
  return `请使用技能 ${JSON.stringify(skill.name)}${location} 完成以下任务：\n`
}

const skillPrefix =
  /^请使用技能 ("(?:[^"\\\r\n]|\\.)*")(?:（入口 ("(?:[^"\\\r\n]|\\.)*")）)? 完成以下任务：(?:\n|$)/u

/** 识别已保存文本开头的技能引用。历史消息的正文和空白保持原样。 */
export function parseSkillMessage(text: string): SkillMessage | null {
  const match = skillPrefix.exec(text)
  if (!match?.[1]) return null
  try {
    const name: unknown = JSON.parse(match[1])
    const path: unknown = match[2] === undefined ? undefined : JSON.parse(match[2])
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      (path !== undefined && typeof path !== 'string')
    )
      return null
    const reference = { name, ...(path === undefined ? {} : { path }) }
    const prefix = formatSkillPrefix(reference)
    // 只有附件时，消息受理会去掉引用末尾的换行。
    if (match[0] !== prefix && match[0] !== prefix.trimEnd()) return null
    return { ...reference, body: text.slice(match[0].length) }
  } catch {
    return null
  }
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
