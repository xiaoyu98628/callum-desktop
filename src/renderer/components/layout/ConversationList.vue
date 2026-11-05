<script setup lang="ts">
import { MessageSquareIcon } from '@lucide/vue'
import type { Conversation } from '@shared/chat'
import { Button } from '@/components/ui/button'
import SidebarItemMenu from './SidebarItemMenu.vue'

defineProps<{
  items: Conversation[]
  selectedId: string | null
  active: boolean
  collapsed: boolean
  disabled: boolean
}>()
defineEmits<{
  select: [id: string]
  rename: [item: Conversation, trigger: HTMLElement | null]
  delete: [item: Conversation, trigger: HTMLElement | null]
}>()
</script>

<template>
  <div class="space-y-1">
    <div
      v-for="item in items"
      :key="item.id"
      class="group flex min-w-0 items-center rounded-lg"
      :class="active && selectedId === item.id ? 'bg-secondary' : 'hover:bg-accent/70'"
    >
      <Button
        variant="ghost"
        class="min-w-0 flex-1 justify-start gap-2 text-xs hover:bg-transparent"
        :class="collapsed ? 'justify-center px-0' : 'px-3'"
        :aria-current="active && selectedId === item.id ? 'page' : undefined"
        :title="item.title"
        @click="$emit('select', item.id)"
      >
        <MessageSquareIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : 'truncate'">{{ item.title }}</span>
      </Button>
      <SidebarItemMenu
        v-if="!collapsed"
        :label="item.title"
        :disabled="disabled"
        @rename="$emit('rename', item, $event)"
        @delete="$emit('delete', item, $event)"
      />
    </div>
  </div>
</template>
