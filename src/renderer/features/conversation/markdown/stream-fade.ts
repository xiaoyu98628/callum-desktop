export const streamFadeDuration = 500
export const streamFadeEasing = 'cubic-bezier(0.3, 0.08, 0.52, 1)'
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const motion = window.matchMedia('(prefers-reduced-motion: reduce)')

export type StreamFragment = { start: number; end: number; delay: number }
export const acceptsStreamMotion = (): boolean => !motion.matches

/** 只处理短尾部，跨分片的字素保持在同一个文本片段里。 */
export function streamFragments(text: string, from: number): StreamFragment[] {
  const offset = Math.max(0, text.length - 96)
  const boundaries = Array.from(
    graphemes.segment(text.slice(offset)),
    ({ index }) => offset + index,
  ).filter((index) => index >= from && (offset === 0 || index > offset))
  const fragments: StreamFragment[] = []
  // 所有字符同时显示，靠前的片段以较高的不透明度起步。
  const size = Math.max(1, Math.ceil(boundaries.length / 3))
  for (let index = 0; index < boundaries.length; index += size) {
    fragments.push({
      start: boundaries[index]!,
      end: boundaries[index + size] ?? text.length,
      delay: -Math.min(88, Math.floor((boundaries.length - index - 1) / size) * 44),
    })
  }
  return fragments
}
