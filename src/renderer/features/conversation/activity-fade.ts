import type { ObjectDirective } from 'vue'
import { acceptsStreamMotion, streamFadeDuration, streamFadeEasing } from './markdown/stream-fade'

export type ActivityFade = { id: string; at?: number | undefined; part: 'row' | 'label' }

/** 同一个实时事件只在对应元素首次可见时播放，展开详情时不重播。 */
export function activityFade(): ObjectDirective<HTMLElement, ActivityFade> {
  const seen = new Map<string, number>()
  const release = (event: AnimationEvent): void => {
    const element = event.currentTarget
    if (
      event.target === element &&
      element instanceof HTMLElement &&
      event.animationName === 'activity-stream-reveal'
    )
      element.removeAttribute('data-activity-fade')
  }
  function play(element: HTMLElement, { id, at, part }: ActivityFade): void {
    if (at === undefined || (seen.get(id) ?? -1) >= at) return
    seen.delete(id)
    seen.set(id, at)
    if (seen.size > 512) seen.delete(seen.keys().next().value!)
    if (!acceptsStreamMotion() || performance.now() - at >= streamFadeDuration) return
    element.style.setProperty('--activity-stream-duration', `${streamFadeDuration}ms`)
    element.style.setProperty('--activity-stream-easing', streamFadeEasing)
    element.dataset.activityFade = part
    // 下一状态可在上一过渡结束前出现，重新开始同一动画无需替换可聚焦节点。
    const current = element
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSAnimation && animation.animationName === 'activity-stream-reveal',
      )
    if (current) {
      current.currentTime = 0
      current.play()
    }
  }
  return {
    mounted(element, { value }) {
      element.addEventListener('animationend', release)
      element.addEventListener('animationcancel', release)
      play(element, value)
    },
    updated(element, { value }) {
      play(element, value)
    },
    unmounted(element) {
      element.removeEventListener('animationend', release)
      element.removeEventListener('animationcancel', release)
    },
  }
}
