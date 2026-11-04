<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppInfo } from '@shared/desktop-api'
import AppShell from '@/components/layout/AppShell.vue'
import { provideAppearance } from '@/features/appearance/useAppearance'
import NewConversationPage from '@/features/conversation/NewConversationPage.vue'
import SettingsPage from '@/features/settings/SettingsPage.vue'
import { getDesktopApi } from '@/lib/desktop'
import type { AppPage } from './navigation'

provideAppearance()

const activePage = ref<AppPage>('conversation')
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const desktopError = ref<string | null>(null)

async function loadAppInfo(): Promise<void> {
  loading.value = true
  desktopError.value = null
  try {
    appInfo.value = await getDesktopApi().getAppInfo()
  } catch {
    desktopError.value = '无法读取应用信息，请重试。'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadAppInfo()
})
</script>

<template>
  <AppShell
    :active-page="activePage"
    :app-info="appInfo"
    :loading="loading"
    :desktop-error="desktopError"
    @navigate="activePage = $event"
    @retry="loadAppInfo"
  >
    <NewConversationPage v-if="activePage === 'conversation'" />
    <SettingsPage v-else />
  </AppShell>
</template>
