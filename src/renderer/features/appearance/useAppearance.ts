import { inject, onScopeDispose, provide, readonly, ref, watchEffect } from 'vue'
import type { InjectionKey, Ref } from 'vue'

export type ThemePreference = 'system' | 'light' | 'dark'

interface AppearanceContext {
  preference: Readonly<Ref<ThemePreference>>
  storageError: Readonly<Ref<boolean>>
  setPreference(value: ThemePreference): void
}

const APPEARANCE_KEY: InjectionKey<AppearanceContext> = Symbol('appearance')
const STORAGE_KEY = 'callum:appearance'

/** 由应用根组件持有，响应系统主题变化，并随根组件一起释放监听。 */
export function provideAppearance(): void {
  const preference = ref<ThemePreference>('system')
  const storageError = ref(false)
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  const prefersDark = ref(systemTheme.matches)

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') preference.value = stored
  } catch {
    storageError.value = true
  }

  const onSystemChange = (event: MediaQueryListEvent): void => {
    prefersDark.value = event.matches
  }
  systemTheme.addEventListener('change', onSystemChange)
  onScopeDispose(() => systemTheme.removeEventListener('change', onSystemChange))

  watchEffect(() => {
    const dark = preference.value === 'dark' || (preference.value === 'system' && prefersDark.value)
    document.documentElement.classList.toggle('dark', dark)
  })

  provide(APPEARANCE_KEY, {
    preference: readonly(preference),
    storageError: readonly(storageError),
    setPreference(value) {
      preference.value = value
      try {
        localStorage.setItem(STORAGE_KEY, value)
        storageError.value = false
      } catch {
        storageError.value = true
      }
    },
  })
}

export function useAppearance(): AppearanceContext {
  const context = inject(APPEARANCE_KEY)
  if (!context) throw new Error('外观设置需要在应用上下文内使用')
  return context
}
