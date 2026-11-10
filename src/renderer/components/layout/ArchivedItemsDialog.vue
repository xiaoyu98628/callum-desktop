<script setup lang="ts">
import { computed } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from 'reka-ui'
import { ArchiveRestoreIcon, LoaderCircleIcon, RefreshCwIcon, XIcon } from '@lucide/vue'
import type { Conversation, Workspace } from '@shared/chat'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  view: 'conversations' | 'workspaces'
  items: Conversation[]
  projects: Workspace[]
  workspaces: Workspace[]
  loading: boolean
  hasMore: boolean
  busy: boolean
  disabled: boolean
  restoringId: string
  error: string
  notice: string
  returnFocus: HTMLElement | null
}>()
const emit = defineEmits<{
  close: []
  load: [more: boolean]
  view: [kind: 'conversations' | 'workspaces']
  restore: [item: Conversation]
  restoreWorkspace: [item: Workspace]
}>()
const label = computed(() => (props.view === 'workspaces' ? '项目' : '会话'))
const rows = computed(() => (props.view === 'workspaces' ? props.projects : props.items))
function itemName(item: Conversation | Workspace): string {
  return 'title' in item ? item.title : item.name
}
function itemDescription(item: Conversation | Workspace): string {
  if ('rootPath' in item) return item.rootPath || '未添加文件夹'
  return item.workspaceId
    ? (props.workspaces.find((workspace) => workspace.id === item.workspaceId)?.name ?? '项目会话')
    : '独立会话'
}
function itemKey(item: Conversation | Workspace): string {
  return 'rootPath' in item ? `workspace:${item.id}` : item.id
}
function restore(item: Conversation | Workspace): void {
  if ('rootPath' in item) emit('restoreWorkspace', item)
  else emit('restore', item)
}
function changeView(value: string | number): void {
  if (!props.busy && (value === 'workspaces' || value === 'conversations')) emit('view', value)
}
function initialFocus(event: Event): void {
  event.preventDefault()
  document.getElementById('archived-items-title')?.focus()
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (props.returnFocus?.isConnected) props.returnFocus.focus()
  else document.getElementById('new-conversation')?.focus()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/10 dark:bg-black/45" />
      <DialogContent
        aria-labelledby="archived-items-title"
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border bg-background p-5 shadow-lg"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
        @open-auto-focus="initialFocus"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle as-child
          ><h2
            id="archived-items-title"
            tabindex="-1"
            class="pr-8 text-xl font-semibold outline-none"
          >
            已归档{{ label }}
          </h2></DialogTitle
        >
        <DialogDescription class="mt-1 text-sm leading-6 text-muted-foreground">{{
          view === 'workspaces'
            ? '恢复项目及未归档的会话，磁盘文件保持原样。'
            : '恢复后，会话会回到原来的项目或最近列表。'
        }}</DialogDescription>
        <TabsRoot :model-value="view" @update:model-value="changeView">
          <div class="my-3 flex items-center justify-between gap-3">
            <TabsList aria-label="归档类型" class="flex gap-1 rounded-xl bg-muted p-1">
              <TabsTrigger
                value="conversations"
                :disabled="busy"
                class="rounded-lg px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-popover data-[state=active]:shadow-sm disabled:opacity-50"
                >会话</TabsTrigger
              >
              <TabsTrigger
                value="workspaces"
                :disabled="busy"
                class="rounded-lg px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-popover data-[state=active]:shadow-sm disabled:opacity-50"
                >项目</TabsTrigger
              >
            </TabsList>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :disabled="loading || disabled"
              :aria-label="`刷新已归档${label}`"
              @click="emit('load', false)"
              ><RefreshCwIcon class="size-3.5" aria-hidden="true" />刷新</Button
            >
          </div>
          <TabsContent :value="view" class="outline-none">
            <p v-if="error" role="alert" class="mb-3 break-words text-sm text-destructive">
              {{ error }}
            </p>
            <p v-if="notice" role="status" class="mb-3 break-words text-sm text-muted-foreground">
              {{ notice }}
            </p>
            <div
              v-if="loading && !rows.length"
              role="status"
              class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
            >
              <LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />正在加载已归档{{
                label
              }}…
            </div>
            <p
              v-else-if="!rows.length && !error"
              class="py-8 text-center text-sm text-muted-foreground"
            >
              暂无已归档{{ label }}
            </p>
            <ul
              v-if="rows.length"
              :aria-label="`已归档${label}列表`"
              :aria-busy="loading"
              class="max-h-[45vh] space-y-1 overflow-y-auto"
            >
              <li
                v-for="item in rows"
                :key="itemKey(item)"
                class="flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-3"
              >
                <div class="min-w-0 flex-1">
                  <p class="break-words text-sm [overflow-wrap:anywhere]">{{ itemName(item) }}</p>
                  <p class="mt-1 break-all text-xs text-muted-foreground">
                    {{ itemDescription(item) }}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="shrink-0 rounded-[10px]"
                  :disabled="disabled"
                  :aria-label="`恢复${itemName(item)}`"
                  @click="restore(item)"
                  ><LoaderCircleIcon
                    v-if="restoringId === itemKey(item)"
                    class="size-3.5 animate-spin"
                    aria-hidden="true"
                  /><ArchiveRestoreIcon v-else class="size-3.5" aria-hidden="true" />恢复</Button
                >
              </li>
            </ul>
            <Button
              v-if="hasMore"
              type="button"
              variant="ghost"
              size="sm"
              class="mt-3 w-full"
              :disabled="loading || disabled"
              @click="emit('load', true)"
              >{{ loading ? '正在加载…' : `加载更多${label}` }}</Button
            >
          </TabsContent>
        </TabsRoot>
        <div class="mt-5 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="rounded-[10px] px-4"
            :disabled="busy"
            @click="emit('close')"
            >关闭</Button
          >
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="absolute right-3 top-3 size-7 text-muted-foreground"
          aria-label="关闭对话框"
          :disabled="busy"
          @click="emit('close')"
          ><XIcon class="size-4" aria-hidden="true"
        /></Button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
