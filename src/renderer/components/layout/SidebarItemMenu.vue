<script setup lang="ts">
import { ref } from 'vue'
import {
  ArchiveIcon,
  EllipsisIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
} from '@lucide/vue'
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from 'reka-ui'
import { Button } from '@/components/ui/button'

defineProps<{ label: string; workspace?: boolean; pinned?: boolean; disabled: boolean }>()
const emit = defineEmits<{
  rename: [trigger: HTMLElement | null]
  delete: [trigger: HTMLElement | null]
  pin: []
  archive: []
}>()
const openingDialog = ref(false)
const trigger = ref<InstanceType<typeof Button> | null>(null)
function choose(action: 'rename' | 'delete'): void {
  openingDialog.value = true
  const element = trigger.value?.$el
  if (action === 'rename') emit('rename', element instanceof HTMLElement ? element : null)
  else emit('delete', element instanceof HTMLElement ? element : null)
}
const itemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
</script>

<template>
  <DropdownMenuRoot @update:open="$event && (openingDialog = false)">
    <DropdownMenuTrigger as-child>
      <Button
        ref="trigger"
        variant="ghost"
        size="icon"
        class="mr-1 size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
        :aria-label="`${label}的操作`"
        :disabled="disabled"
      >
        <EllipsisIcon class="size-4" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        align="start"
        side="bottom"
        :side-offset="4"
        :collision-padding="8"
        class="z-40 w-40 rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg"
        @close-auto-focus="openingDialog && $event.preventDefault()"
      >
        <DropdownMenuItem :class="itemClass" @select="emit('pin')">
          <PinOffIcon v-if="pinned" class="size-3.5" aria-hidden="true" />
          <PinIcon v-else class="size-3.5" aria-hidden="true" />{{ pinned ? '取消置顶' : '置顶' }}
        </DropdownMenuItem>
        <DropdownMenuItem :class="itemClass" @select="choose('rename')"
          ><PencilIcon class="size-3.5" aria-hidden="true" />{{
            workspace ? '编辑' : '重命名'
          }}</DropdownMenuItem
        >
        <DropdownMenuSeparator v-if="workspace" class="my-1 border-t" />
        <DropdownMenuItem :class="itemClass" @select="emit('archive')">
          <ArchiveIcon class="size-3.5" aria-hidden="true" />{{
            workspace ? '归档项目' : '归档聊天'
          }}
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 border-t" />
        <DropdownMenuItem
          :class="[itemClass, !workspace && 'text-destructive focus:text-destructive']"
          @select="choose('delete')"
          ><XIcon v-if="workspace" class="size-3.5" aria-hidden="true" /><Trash2Icon
            v-else
            class="size-3.5"
            aria-hidden="true"
          />{{ workspace ? '移除项目' : '删除会话' }}</DropdownMenuItem
        >
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
