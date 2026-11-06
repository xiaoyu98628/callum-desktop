import type { DesktopApi } from '@shared/desktop-api'

/** 唯一的桌面桥接入口；浏览器运行时不伪造桌面能力。 */
export function getDesktopApi(): DesktopApi {
  if (!window.callum) throw new Error('桌面连接不可用，请在 Callum 客户端中打开。')
  return window.callum
}
