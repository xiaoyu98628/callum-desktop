export const MAX_CODE_LENGTH = 1024 * 1024

/** 只允许完整网页地址，不接受文件、相对路径或可调用系统应用的其他协议。 */
export function parseWebLink(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value))
    throw new Error('只支持 HTTP 或 HTTPS 网页链接')
  if (
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('网页链接包含无效字符')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('网页链接无效')
  return url.href
}

export function parseCodeText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_CODE_LENGTH || value.includes('\0'))
    throw new Error('代码内容无效或过长')
  return value
}
