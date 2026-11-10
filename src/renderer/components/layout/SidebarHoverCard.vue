<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { FolderIcon, PinIcon, PinOffIcon, SettingsIcon } from '@lucide/vue'
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui'
import type { Conversation, Workspace } from '@shared/chat'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  item: Workspace | Conversation
  workspaceName?: string
  disabled: boolean
  suspended?: boolean
}>()
const emit = defineEmits<{
  pin: []
  edit: [trigger: HTMLElement | null]
}>()
const open = ref(false)
const content = ref<InstanceType<typeof PopoverContent> | null>(null)
const project = computed(() => ('rootPath' in props.item ? props.item : null))
const conversation = computed(() => ('title' in props.item ? props.item : null))
const label = computed(() => project.value?.name ?? conversation.value?.title ?? '')
const folders = computed(() =>
  project.value ? [project.value.rootPath, ...project.value.otherPaths].filter(Boolean) : [],
)
const now = ref(Date.now())
const relativeTime = computed(() => {
  const minutes = Math.max(0, Math.floor((now.value - props.item.updatedAt) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(props.item.updatedAt).toLocaleDateString('zh-CN')
})
let trigger: HTMLElement | null = null
let openTimer: number | undefined
let closeTimer: number | undefined
// 虚拟锚点让预览和右键菜单各自持有定位上下文，触发条目保留在原有菜单层级内。
const reference = { getBoundingClientRect: () => trigger?.getBoundingClientRect() ?? new DOMRect() }

function dismiss(): void {
  window.clearTimeout(openTimer)
  window.clearTimeout(closeTimer)
  open.value = false
}
function enter(event: PointerEvent): void {
  if (event.pointerType === 'touch' || props.suspended) return
  if (event.currentTarget instanceof HTMLElement) trigger = event.currentTarget
  window.clearTimeout(closeTimer)
  window.clearTimeout(openTimer)
  openTimer = window.setTimeout(() => {
    if (!trigger?.isConnected || trigger.closest('[inert]')) return
    now.value = Date.now()
    open.value = true
  }, 450)
}
function leave(): void {
  window.clearTimeout(openTimer)
  window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    const panel = content.value?.$el
    if (panel instanceof HTMLElement && panel.contains(document.activeElement)) return
    open.value = false
  }, 180)
}
function keepOpen(): void {
  window.clearTimeout(closeTimer)
}
function focus(event: FocusEvent): void {
  if (event.currentTarget instanceof HTMLElement) trigger = event.currentTarget
}
async function enterWithKeyboard(event: KeyboardEvent): Promise<void> {
  if (event.key !== 'ArrowRight' || props.suspended) return
  event.preventDefault()
  window.clearTimeout(openTimer)
  if (event.currentTarget instanceof HTMLElement) trigger = event.currentTarget
  now.value = Date.now()
  open.value = true
  await nextTick()
  const panel = content.value?.$el
  if (panel instanceof HTMLElement)
    (panel.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? panel).focus()
}
function escape(): void {
  const panel = content.value?.$el
  if (panel instanceof HTMLElement && panel.contains(document.activeElement))
    trigger?.focus({ preventScroll: true })
  dismiss()
}
function edit(): void {
  dismiss()
  emit('edit', trigger)
}
const triggerEvents = {
  pointerenter: enter,
  pointerleave: leave,
  pointerdown: dismiss,
  contextmenu: dismiss,
  focus,
  blur: leave,
  keydown: enterWithKeyboard,
}
watch(
  () => props.suspended,
  (value) => {
    if (value) dismiss()
  },
)
watch(open, (value, _, cleanup) => {
  if (!value) return
  const closeOnScroll = (event: Event): void => {
    if (event.target instanceof Element && event.target.contains(trigger)) dismiss()
  }
  window.addEventListener('scroll', closeOnScroll, { capture: true, passive: true })
  cleanup(() => window.removeEventListener('scroll', closeOnScroll, true))
})
onScopeDispose(dismiss)
</script>

<template>
  <slot :trigger-events="triggerEvents" />
  <PopoverRoot :open="open" :modal="false" @update:open="!$event && dismiss()">
    <PopoverAnchor as="template" :reference="reference" />
    <PopoverPortal>
      <PopoverContent
        ref="content"
        side="right"
        align="start"
        :side-offset="12"
        :collision-padding="12"
        hide-when-detached
        update-position-strategy="always"
        :aria-label="`${project ? '项目' : '会话'}预览`"
        :aria-labelledby="undefined"
        :aria-describedby="undefined"
        data-sidebar-preview
        class="sidebar-hover-card z-40 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-foreground/10 bg-popover p-1 text-[13px] leading-5 text-popover-foreground shadow-[0_4px_24px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.04)] outline-none"
        @open-auto-focus.prevent
        @close-auto-focus.prevent
        @escape-key-down="escape"
        @pointerenter="keepOpen"
        @pointerleave="leave"
        @focusin="keepOpen"
        @focusout="leave"
      >
        <div class="flex items-start gap-2 px-2 py-1.5">
          <FolderIcon
            v-if="project"
            class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p class="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]">{{ label }}</p>
          <Button
            v-if="project"
            type="button"
            variant="ghost"
            size="icon-xs"
            class="-mr-1 -mt-0.5 shrink-0 text-muted-foreground"
            :aria-label="project.pinnedAt === null ? '置顶项目' : '取消项目置顶'"
            :aria-pressed="project.pinnedAt !== null"
            :disabled="disabled"
            @click="emit('pin')"
          >
            <PinIcon v-if="project.pinnedAt === null" class="size-3.5" aria-hidden="true" />
            <PinOffIcon v-else class="size-3.5" aria-hidden="true" />
          </Button>
          <time
            v-else
            class="shrink-0 pt-0.5 text-xs font-normal text-muted-foreground/80"
            :datetime="new Date(item.updatedAt).toISOString()"
            :title="new Date(item.updatedAt).toLocaleString('zh-CN')"
            >{{ relativeTime }}</time
          >
        </div>
        <template v-if="project">
          <div class="mx-1 border-t border-foreground/8" />
          <div
            class="sidebar-preview-folders max-h-[min(15rem,calc(var(--reka-popover-content-available-height)-6rem))] overflow-y-auto py-1"
          >
            <div v-for="path in folders" :key="path" class="flex gap-2 px-2 py-1">
              <FolderIcon
                class="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
                aria-hidden="true"
              />
              <span class="min-w-0 break-words text-muted-foreground [overflow-wrap:anywhere]">{{
                path
              }}</span>
            </div>
            <p v-if="!folders.length" class="px-2 py-1 text-muted-foreground">未添加文件夹</p>
          </div>
          <div class="mx-1 border-t border-foreground/8" />
          <Button
            type="button"
            variant="ghost"
            class="h-8 w-full justify-start gap-2 rounded-lg px-2 text-[13px] font-normal"
            :disabled="disabled"
            @click="edit"
          >
            <SettingsIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />编辑项目
          </Button>
        </template>
        <div v-else-if="workspaceName" class="flex items-start gap-2 px-2 pb-1.5 pt-0.5">
          <FolderIcon
            class="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
            aria-hidden="true"
          />
          <p class="min-w-0 break-words text-muted-foreground [overflow-wrap:anywhere]">
            {{ workspaceName }}
          </p>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
.sidebar-hover-card {
  animation: sidebar-preview-enter 120ms ease-out;
  transform-origin: var(--reka-popover-content-transform-origin);
}

.sidebar-hover-card[data-state='closed'] {
  animation: sidebar-preview-leave 90ms ease-in;
}

.sidebar-preview-folders::-webkit-scrollbar {
  width: 6px;
  background: transparent;
}

.sidebar-preview-folders::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
}

@keyframes sidebar-preview-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes sidebar-preview-leave {
  to {
    opacity: 0;
  }
}
</style>
