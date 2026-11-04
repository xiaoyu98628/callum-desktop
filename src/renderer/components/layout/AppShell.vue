<script setup lang="ts">
import { ref } from 'vue'
import { CircleAlertIcon, PanelLeftIcon } from '@lucide/vue'
import type { AppInfo } from '@shared/desktop-api'
import type { AppPage } from '@/app/navigation'
import { Button } from '@/components/ui/button'
import AppSidebar from './AppSidebar.vue'

defineProps<{
  activePage: AppPage
  appInfo: AppInfo | null
  loading: boolean
  desktopError: string | null
}>()

defineEmits<{
  navigate: [page: AppPage]
  retry: []
}>()

const collapsed = ref(false)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header
      class="window-drag flex h-14 shrink-0 items-center gap-4 border-b bg-sidebar/60 pr-5"
      :class="appInfo?.platform === 'darwin' ? 'pl-24' : 'pl-4'"
    >
      <Button
        variant="ghost"
        size="icon"
        :aria-expanded="!collapsed"
        aria-controls="app-sidebar"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        class="size-8 text-muted-foreground"
        @click="collapsed = !collapsed"
      >
        <PanelLeftIcon class="size-4" aria-hidden="true" />
      </Button>
      <span class="h-4 border-l" aria-hidden="true"></span>
      <span class="text-xs font-medium text-muted-foreground">Callum</span>
      <span class="text-muted-foreground/40" aria-hidden="true">/</span>
      <span class="text-xs font-medium">{{
        activePage === 'conversation' ? '新对话' : '设置'
      }}</span>
      <span class="ml-auto text-[11px] tracking-wide text-muted-foreground">桌面客户端</span>
    </header>

    <div class="flex min-h-0 flex-1">
      <AppSidebar
        :collapsed="collapsed"
        :active-page="activePage"
        :app-info="appInfo"
        :loading="loading"
        @navigate="$emit('navigate', $event)"
      />

      <main id="main-content" class="min-w-0 flex-1 overflow-y-auto">
        <div
          v-if="desktopError"
          role="alert"
          class="m-6 flex items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm"
        >
          <CircleAlertIcon class="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <p class="flex-1">{{ desktopError }}</p>
          <Button size="sm" variant="outline" :disabled="loading" @click="$emit('retry')"
            >重试</Button
          >
        </div>
        <slot />
      </main>
    </div>
  </div>
</template>
