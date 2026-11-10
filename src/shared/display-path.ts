/** 仅缩写真实用户目录及其后代，保留相邻目录和其他用户的路径。 */
export function abbreviateHomePath(path: string, homeDirectory: string): string {
  if (!homeDirectory) return path
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(homeDirectory)
  const normalizedPath = windows ? path.replaceAll('\\', '/') : path
  const normalizedHome = windows ? homeDirectory.replaceAll('\\', '/') : homeDirectory
  const home = normalizedHome.replace(/\/+$/, '') || '/'
  const comparedPath = windows ? normalizedPath.toLowerCase() : normalizedPath
  const comparedHome = windows ? home.toLowerCase() : home
  if (comparedPath === comparedHome) return '~'
  const prefix = comparedHome.endsWith('/') ? comparedHome : `${comparedHome}/`
  return comparedPath.startsWith(prefix) ? `~/${normalizedPath.slice(prefix.length)}` : path
}
