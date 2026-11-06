<script setup lang="ts">
import { ArchiveIcon, MessageSquareIcon, PinIcon, PinOffIcon } from '@lucide/vue'
import type { Conversation } from '@shared/chat'
import { Button } from '@/components/ui/button'
import SidebarItemMenu from './SidebarItemMenu.vue'

const props = defineProps<{
  items: Conversation[]
  selectedId: string | null
  active: boolean
  collapsed: boolean
  disabled: boolean
}>()
const emit = defineEmits<{
  select: [id: string]
  rename: [item: Conversation, trigger: HTMLElement | null]
  delete: [item: Conversation, trigger: HTMLElement | null]
  pin: [item: Conversation]
  archive: [item: Conversation]
}>()

function rename(item: Conversation, event: MouseEvent): void {
  if (props.disabled || props.collapsed) return
  emit('rename', item, event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
}
</script>

<template>
  <div class="space-y-0.5">
    <div
      v-for="item in items"
      :key="item.id"
      class="group relative flex min-w-0 items-center rounded-lg"
      :class="active && selectedId === item.id ? 'bg-secondary' : 'hover:bg-accent/70'"
    >
      <Button
        variant="ghost"
        class="h-8 min-w-0 flex-1 justify-start gap-2 text-[13px] font-normal hover:bg-transparent"
        :class="
          collapsed ? 'justify-center px-0' : 'px-3 group-hover:pr-21 group-focus-within:pr-21'
        "
        :aria-current="active && selectedId === item.id ? 'page' : undefined"
        :title="item.title"
        @click="$event.detail < 2 && emit('select', item.id)"
        @dblclick="rename(item, $event)"
      >
        <MessageSquareIcon
          v-if="collapsed"
          class="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span :class="collapsed ? 'sr-only' : 'truncate'">{{ item.title }}</span>
      </Button>
      <div v-if="!collapsed" class="absolute right-0 flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          :aria-label="`${item.pinnedAt === null ? '置顶' : '取消置顶'}${item.title}`"
          :title="item.pinnedAt === null ? '置顶聊天' : '取消置顶'"
          :aria-pressed="item.pinnedAt !== null"
          :disabled="disabled"
          @click="emit('pin', item)"
          ><PinIcon v-if="item.pinnedAt === null" class="size-3.5" aria-hidden="true" />
          <PinOffIcon v-else class="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          :aria-label="`归档${item.title}`"
          title="归档聊天"
          :disabled="disabled"
          @click="emit('archive', item)"
          ><ArchiveIcon class="size-3.5" aria-hidden="true"
        /></Button>
        <SidebarItemMenu
          :label="item.title"
          :disabled="disabled"
          :pinned="item.pinnedAt !== null"
          @pin="emit('pin', item)"
          @archive="emit('archive', item)"
          @rename="$emit('rename', item, $event)"
          @delete="$emit('delete', item, $event)"
        />
      </div>
    </div>
  </div>
</template>
