<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import type { AppInfo, ServiceState } from '@shared/desktop-api'
import AppLoading from './AppLoading.vue'
import AppStartupFailure from './AppStartupFailure.vue'
import AppShell from '@/components/layout/AppShell.vue'
import { provideAppearance } from '@/features/appearance/useAppearance'
import NewConversationPage from '@/features/conversation/NewConversationPage.vue'
import { provideConversations } from '@/features/conversation/useConversations'
import { provideMarkdownRenderer } from '@/features/conversation/markdown/useMarkdownRenderer'
import SettingsPage from '@/features/settings/SettingsPage.vue'
import { getDesktopApi } from '@/lib/desktop'
import type { AppPage, SettingsSection } from './navigation'

provideAppearance()
provideMarkdownRenderer()
const conversations = provideConversations()

const activePage = ref<AppPage>('conversation')
const settingsSection = ref<SettingsSection>('appearance')
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const initialized = ref(false)
const serviceState = ref<ServiceState | null>(null)
const desktopError = ref<string | null>(null)
const restarting = ref(false)
const retryError = ref('')
let initializationTask: Promise<void> | null = null
let stateVersion = 0
let unsubscribeState: (() => void) | undefined
let disposed = false
const showingLoading = computed(
  () =>
    restarting.value ||
    loading.value ||
    !initialized.value ||
    serviceState.value?.status === 'starting' ||
    serviceState.value?.status === 'closing',
)
const startupFailure = computed(() =>
  serviceState.value?.status === 'startup-failed'
    ? serviceState.value.error
    : !serviceState.value
      ? (desktopError.value ?? '')
      : '',
)
watch(
  () => serviceState.value?.status,
  (status) => {
    if ((status !== 'ready' && status !== 'failed') || initialized.value || initializationTask)
      return
    initializationTask = conversations.initialize().finally(() => {
      if (!disposed) initialized.value = true
      initializationTask = null
    })
  },
)
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
  const version = stateVersion
  try {
    const [info, state] = await Promise.all([
      getDesktopApi().getAppInfo(),
      getDesktopApi().getServiceState(),
    ])
    if (disposed) return
    appInfo.value = info
    // 查询期间收到的通知更新，不能被较早的查询快照撤回。
    if (version === stateVersion) serviceState.value = state
  } catch {
    if (!disposed) desktopError.value = '无法读取应用信息或服务状态，请重试。'
  } finally {
    if (!disposed) loading.value = false
  }
}

async function retryStart(): Promise<void> {
  if (restarting.value) return
  if (serviceState.value?.status !== 'startup-failed') {
    if (desktopError.value) await loadAppInfo()
    return
  }
  restarting.value = true
  retryError.value = ''
  initialized.value = false
  const version = stateVersion
  try {
    const result = await getDesktopApi().retryServiceStart()
    if (disposed) return
    if (!result.ok) retryError.value = result.error
    else if (version === stateVersion) serviceState.value = result.value
  } catch {
    if (!disposed) retryError.value = '无法提交重试启动请求，请重试。'
  } finally {
    if (!disposed) restarting.value = false
  }
}

onMounted(() => {
  unsubscribeState = getDesktopApi().onServiceState((state) => {
    stateVersion++
    serviceState.value = state
  })
  void loadAppInfo()
})
onScopeDispose(() => {
  disposed = true
  unsubscribeState?.()
})
</script>

<template>
  <AppStartupFailure
    v-if="startupFailure && !restarting"
    :error="startupFailure"
    :retry-error="retryError"
    @retry="retryStart"
  />
  <AppLoading v-else-if="showingLoading" :closing="serviceState?.status === 'closing'" />
  <AppShell
    v-else
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
