import { computed, inject, onScopeDispose, provide, readonly, ref } from 'vue'
import type { InjectionKey, Ref } from 'vue'
import type { ChatResult } from '@shared/chat'
import type { DesktopApi } from '@shared/desktop-api'
import type { FollowUpMode } from '@shared/follow-up'
import type { GeneralSettings } from '@shared/general-settings'
import { getDesktopApi } from '@/lib/desktop'

interface FollowUpPreference {
  mode: Readonly<Ref<FollowUpMode>>
  loaded: Readonly<Ref<boolean>>
  busy: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  refresh(): Promise<void>
  setMode(mode: FollowUpMode): Promise<void>
}

const key: InjectionKey<FollowUpPreference> = Symbol('follow-up preference')
const legacyKey = 'callum:follow-up-mode'

function unwrap<T>(result: ChatResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

async function migrateLegacyPreference(
  api: DesktopApi,
  settings: GeneralSettings,
): Promise<GeneralSettings> {
  let legacy: string | null
  try {
    legacy = localStorage.getItem(legacyKey)
  } catch {
    return settings
  }
  if (legacy === null) return settings
  if (settings.revision === 1 && settings.followUpMode === 'queue' && legacy === 'steer') {
    const imported = await api.updateGeneralSettings({ ...settings, followUpMode: 'steer' })
    if (imported.ok) {
      settings = imported.value
    } else {
      // 另一个窗口可能先保存了数据库设置。读回当前版本，避免覆盖。
      settings = unwrap(await api.getGeneralSettings())
      if (settings.revision === 1 && settings.followUpMode === 'queue')
        throw new Error('旧偏好尚未迁移，请重试。')
    }
  }
  try {
    localStorage.removeItem(legacyKey)
  } catch {
    // 数据库已确认；若清理失败，下次启动仍以已保存的版本为准。
  }
  return settings
}

export function provideFollowUpPreference(): FollowUpPreference {
  const settings = ref<GeneralSettings | null>(null)
  const busy = ref(false)
  const error = ref('')
  let disposed = false
  let refreshTask: Promise<void> | undefined
  onScopeDispose(() => {
    disposed = true
  })

  const read = async (): Promise<void> => {
    try {
      const api = getDesktopApi()
      const value = unwrap(await api.getGeneralSettings())
      if (disposed) return
      settings.value = value
      const migrated = await migrateLegacyPreference(api, value)
      if (!disposed) settings.value = migrated
    } catch (reason) {
      if (!disposed) error.value = reason instanceof Error ? reason.message : '读取常规设置失败。'
    }
  }

  const context: FollowUpPreference = {
    mode: computed(() => settings.value?.followUpMode ?? 'queue'),
    loaded: computed(() => settings.value !== null),
    busy: readonly(busy),
    error: readonly(error),
    refresh() {
      if (refreshTask) return refreshTask
      if (disposed || busy.value) return Promise.resolve()
      busy.value = true
      error.value = ''
      refreshTask = read().finally(() => {
        refreshTask = undefined
        busy.value = false
      })
      return refreshTask
    },
    async setMode(mode) {
      const current = settings.value
      if (disposed || busy.value || !current || current.followUpMode === mode) return
      busy.value = true
      error.value = ''
      try {
        const api = getDesktopApi()
        const result = await api.updateGeneralSettings({ ...current, followUpMode: mode })
        if (disposed) return
        if (result.ok) {
          settings.value = result.value
        } else {
          error.value = result.error
          const latest = await api.getGeneralSettings()
          if (!disposed && latest.ok) settings.value = latest.value
        }
      } catch {
        if (!disposed) error.value = '保存常规设置失败，请重试。'
      } finally {
        busy.value = false
      }
    },
  }
  provide(key, context)
  return context
}

export function useFollowUpPreference(): FollowUpPreference {
  const preference = inject(key)
  if (!preference) throw new Error('后续消息设置需要在应用上下文内使用')
  return preference
}
