<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AppInfo } from '@shared/desktop-api'
import AppShell from '@/components/layout/AppShell.vue'
import { provideAppearance } from '@/features/appearance/useAppearance'
import NewConversationPage from '@/features/conversation/NewConversationPage.vue'
import { provideConversations } from '@/features/conversation/useConversations'
import SettingsPage from '@/features/settings/SettingsPage.vue'
import { getDesktopApi } from '@/lib/desktop'
import type { AppPage, SettingsSection } from './navigation'

provideAppearance()
const conversations = provideConversations()

const activePage = ref<AppPage>('conversation')
const settingsSection = ref<SettingsSection>('appearance')
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const desktopError = ref<string | null>(null)
function configureModels(): void {
  settingsSection.value = 'models'
  activePage.value = 'settings'
}
function navigate(page: AppPage): void {
  const returning = activePage.value === 'settings' && page === 'conversation'
  activePage.value = page
  if (returning) void conversations.refreshModels()
}

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
    @navigate="navigate"
    @retry="loadAppInfo"
  >
    <NewConversationPage v-if="activePage === 'conversation'" @configure-models="configureModels" />
    <SettingsPage
      v-else
      v-model:section="settingsSection"
      @models-updated="conversations.setModels"
      @models-invalidated="conversations.refreshModels"
    />
  </AppShell>
</template>
