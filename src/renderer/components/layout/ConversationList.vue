<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'
import {
  ArchiveIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from '@lucide/vue'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'reka-ui'
import type { Conversation } from '@shared/chat'
import { Button } from '@/components/ui/button'

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

const list = ref<HTMLElement | null>(null)
const openMenuId = ref<string | null>(null)
let dialogItemId: string | null = null
let titleObserver: ResizeObserver | undefined
const menuItemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

function rowButton(id: string): HTMLButtonElement | null {
  return list.value?.querySelector(`button[data-conversation-id="${CSS.escape(id)}"]`) ?? null
}

function rename(item: Conversation, event: MouseEvent): void {
  if (props.disabled || props.collapsed) return
  emit('rename', item, event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
}

function setMenuOpen(id: string, open: boolean): void {
  if (open && !props.disabled) openMenuId.value = id
  else if (!open && openMenuId.value === id) openMenuId.value = null
}

function handleMenuKey(id: string, event: KeyboardEvent): void {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault()
  setMenuOpen(id, true)
}

function chooseDialog(action: 'rename' | 'delete', item: Conversation): void {
  dialogItemId = item.id
  const trigger = rowButton(item.id)
  if (action === 'rename') emit('rename', item, trigger)
  else emit('delete', item, trigger)
}

function restoreMenuFocus(id: string, event: Event): void {
  event.preventDefault()
  if (dialogItemId === id) dialogItemId = null
  else rowButton(id)?.focus({ preventScroll: true })
}

function startTitleScroll(event: MouseEvent): void {
  if (!(event.currentTarget instanceof HTMLElement)) return
  const viewport = event.currentTarget.querySelector<HTMLElement>('.conversation-title')
  const title = viewport?.firstElementChild
  if (!viewport || !title) return
  titleObserver?.disconnect()
  titleObserver = new ResizeObserver(() => {
    const distance = title.getBoundingClientRect().width - viewport.clientWidth
    viewport.toggleAttribute('data-overflow', distance >= 1)
    if (distance < 1) return
    viewport.style.setProperty('--title-scroll-offset', `${-distance}px`)
    viewport.style.setProperty('--title-scroll-time', `${Math.max(0.8, distance / 32)}s`)
  })
  titleObserver.observe(viewport)
  titleObserver.observe(title)
}

function stopTitleScroll(event: MouseEvent): void {
  titleObserver?.disconnect()
  if (event.currentTarget instanceof HTMLElement)
    event.currentTarget.querySelector('.conversation-title')?.removeAttribute('data-overflow')
}

onScopeDispose(() => titleObserver?.disconnect())
</script>

<template>
  <div ref="list">
    <ContextMenuRoot
      v-for="item in items"
      :key="item.id"
      :open="openMenuId === item.id"
      @update:open="setMenuOpen(item.id, $event)"
    >
      <div
        class="group conversation-row relative flex min-w-0 items-center rounded-lg"
        :class="active && selectedId === item.id ? 'bg-secondary' : 'hover:bg-accent/70'"
        @mouseenter="startTitleScroll"
        @mouseleave="stopTitleScroll"
      >
        <ContextMenuTrigger as-child :disabled="disabled">
          <Button
            variant="ghost"
            class="h-7 min-w-0 flex-1 justify-start gap-2 py-1 text-[13px] font-normal hover:bg-transparent"
            :class="
              collapsed ? 'justify-center px-0' : 'px-3 group-hover:pr-14 group-focus-within:pr-14'
            "
            :data-conversation-id="item.id"
            :aria-current="active && selectedId === item.id ? 'page' : undefined"
            :aria-haspopup="disabled ? undefined : 'menu'"
            :aria-expanded="disabled ? undefined : openMenuId === item.id"
            :aria-keyshortcuts="disabled ? undefined : 'Shift+F10'"
            :title="item.title"
            @click="$event.detail < 2 && emit('select', item.id)"
            @dblclick="rename(item, $event)"
            @keydown="handleMenuKey(item.id, $event)"
            @contextmenu="disabled && $event.preventDefault()"
          >
            <MessageSquareIcon
              v-if="collapsed"
              class="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span v-if="collapsed" class="sr-only">{{ item.title }}</span>
            <span v-else class="conversation-title min-w-0 truncate">
              <span class="conversation-title-text">{{ item.title }}</span>
            </span>
          </Button>
        </ContextMenuTrigger>
        <div v-if="!collapsed" class="absolute right-1 flex items-center">
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
        </div>
      </div>
      <ContextMenuPortal>
        <ContextMenuContent
          :collision-padding="8"
          class="z-40 w-40 rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg"
          @close-auto-focus="restoreMenuFocus(item.id, $event)"
        >
          <ContextMenuItem :class="menuItemClass" :disabled="disabled" @select="emit('pin', item)">
            <PinIcon v-if="item.pinnedAt === null" class="size-3.5" aria-hidden="true" />
            <PinOffIcon v-else class="size-3.5" aria-hidden="true" />
            {{ item.pinnedAt === null ? '置顶' : '取消置顶' }}
          </ContextMenuItem>
          <ContextMenuItem
            :class="menuItemClass"
            :disabled="disabled"
            @select="chooseDialog('rename', item)"
          >
            <PencilIcon class="size-3.5" aria-hidden="true" />重命名
          </ContextMenuItem>
          <ContextMenuItem
            :class="menuItemClass"
            :disabled="disabled"
            @select="emit('archive', item)"
          >
            <ArchiveIcon class="size-3.5" aria-hidden="true" />归档聊天
          </ContextMenuItem>
          <ContextMenuSeparator class="my-1 border-t" />
          <ContextMenuItem
            :class="[menuItemClass, 'text-destructive focus:text-destructive']"
            :disabled="disabled"
            @select="chooseDialog('delete', item)"
          >
            <Trash2Icon class="size-3.5" aria-hidden="true" />删除会话
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenuRoot>
  </div>
</template>

<style scoped>
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  .conversation-row:hover .conversation-title[data-overflow] {
    text-overflow: clip;
  }

  .conversation-row:hover .conversation-title-text {
    display: inline-block;
  }

  .conversation-row:hover .conversation-title[data-overflow] .conversation-title-text {
    animation:
      conversation-title-scroll var(--title-scroll-time) 450ms linear forwards,
      conversation-title-reset 0s calc(var(--title-scroll-time) + 1.25s) forwards;
  }
}

@keyframes conversation-title-scroll {
  100% {
    transform: translateX(var(--title-scroll-offset));
  }
}

@keyframes conversation-title-reset {
  100% {
    transform: none;
  }
}
</style>
