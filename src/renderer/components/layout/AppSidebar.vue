<script setup lang="ts">
import {
  FolderIcon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
} from '@lucide/vue'
import type { AppInfo } from '@shared/desktop-api'
import type { AppPage } from '@/app/navigation'
import { Button } from '@/components/ui/button'
import { useConversations } from '@/features/conversation/useConversations'

defineProps<{
  collapsed: boolean
  activePage: AppPage
  appInfo: AppInfo | null
  loading: boolean
}>()

const emit = defineEmits<{ navigate: [page: AppPage] }>()

const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as const
const { state, newConversation, openConversation, refreshOverview } = useConversations()
function startConversation(): void {
  newConversation()
  emit('navigate', 'conversation')
}
function selectConversation(conversationId: string): void {
  void openConversation(conversationId)
  emit('navigate', 'conversation')
}
</script>

<template>
  <aside
    id="app-sidebar"
    class="flex min-h-0 shrink-0 flex-col border-r bg-sidebar px-3 py-6 transition-[width] duration-200"
    :class="collapsed ? 'w-18' : 'w-60'"
    aria-label="主导航"
  >
    <div
      class="mb-7 flex shrink-0 items-center gap-3"
      :class="collapsed ? 'justify-center' : 'px-2'"
    >
      <div
        class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
      >
        <SparklesIcon class="size-5" aria-hidden="true" />
      </div>
      <p v-if="!collapsed" class="text-base font-semibold tracking-tight">Callum</p>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col" aria-label="工作内容">
      <Button
        variant="outline"
        class="w-full shrink-0 gap-3 rounded-xl bg-card font-medium"
        :class="collapsed ? 'px-0' : 'justify-start px-3'"
        :aria-current="activePage === 'conversation' && !state.selectedId ? 'page' : undefined"
        :title="collapsed ? '新对话' : undefined"
        @click="startConversation"
      >
        <SquarePenIcon class="size-4 shrink-0" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : ''">新对话</span>
      </Button>

      <div class="mt-7 min-h-0 flex-1 space-y-7 overflow-y-auto">
        <section aria-labelledby="workspace-heading">
          <div
            class="mb-2 flex h-7 items-center"
            :class="collapsed ? 'justify-center' : 'gap-2 px-3'"
          >
            <FolderIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h2
              id="workspace-heading"
              class="text-xs font-medium text-muted-foreground"
              :class="collapsed ? 'sr-only' : ''"
            >
              工作区
            </h2>
            <span v-if="!collapsed" class="ml-auto" title="添加工作区功能尚未开放">
              <Button
                variant="ghost"
                size="icon"
                class="size-6 text-muted-foreground"
                disabled
                aria-label="添加工作区"
                aria-describedby="workspace-availability"
              >
                <PlusIcon class="size-3.5" aria-hidden="true" />
              </Button>
            </span>
          </div>
          <div class="px-3" :class="collapsed ? 'sr-only' : ''">
            <p class="text-xs leading-6 text-muted-foreground/80">暂无工作区</p>
            <p id="workspace-availability" class="sr-only">添加工作区功能尚未开放</p>
          </div>
        </section>

        <section aria-labelledby="conversations-heading">
          <div
            class="mb-2 flex h-7 items-center"
            :class="collapsed ? 'justify-center' : 'gap-2 px-3'"
          >
            <MessageSquareIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h2
              id="conversations-heading"
              class="text-xs font-medium text-muted-foreground"
              :class="collapsed ? 'sr-only' : ''"
            >
              对话
            </h2>
          </div>
          <p
            v-if="state.loadingList && !state.conversations.length"
            class="px-3 text-xs text-muted-foreground"
            :class="collapsed ? 'sr-only' : ''"
          >
            正在加载对话…
          </p>
          <p
            v-else-if="!state.conversations.length && !state.serviceError"
            class="px-3 text-xs leading-6 text-muted-foreground/80"
            :class="collapsed ? 'sr-only' : ''"
          >
            暂无对话
          </p>
          <div v-if="state.conversations.length" class="space-y-1">
            <Button
              v-for="conversation in state.conversations"
              :key="conversation.id"
              :variant="
                activePage === 'conversation' && state.selectedId === conversation.id
                  ? 'secondary'
                  : 'ghost'
              "
              class="w-full min-w-0 justify-start gap-2 text-xs"
              :class="collapsed ? 'justify-center px-0' : 'px-3'"
              :aria-current="
                activePage === 'conversation' && state.selectedId === conversation.id
                  ? 'page'
                  : undefined
              "
              :title="conversation.title"
              @click="selectConversation(conversation.id)"
            >
              <MessageSquareIcon class="size-3.5 shrink-0" aria-hidden="true" />
              <span :class="collapsed ? 'sr-only' : 'truncate'">{{ conversation.title }}</span>
            </Button>
          </div>
          <Button
            v-if="state.hasMore && !collapsed"
            variant="ghost"
            size="sm"
            class="mt-2 w-full text-xs text-muted-foreground"
            :disabled="state.loadingList"
            @click="refreshOverview(true)"
            >加载更多对话</Button
          >
        </section>
      </div>
    </nav>

    <div class="mt-5 shrink-0 space-y-4">
      <Button
        :variant="activePage === 'settings' ? 'secondary' : 'ghost'"
        class="w-full gap-3 rounded-lg"
        :class="collapsed ? 'px-0' : 'justify-start px-3'"
        :aria-current="activePage === 'settings' ? 'page' : undefined"
        :title="collapsed ? '设置' : undefined"
        @click="$emit('navigate', 'settings')"
      >
        <Settings2Icon class="size-4 shrink-0" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : ''">设置</span>
      </Button>
      <div
        v-if="!collapsed"
        class="flex items-center justify-between border-t px-2 pt-4 text-[10px] text-muted-foreground"
      >
        <span>{{
          appInfo ? `v${appInfo.version}` : loading ? '读取应用信息…' : '版本信息不可用'
        }}</span>
        <span v-if="appInfo">{{ platformNames[appInfo.platform] }}</span>
      </div>
    </div>
  </aside>
</template>
