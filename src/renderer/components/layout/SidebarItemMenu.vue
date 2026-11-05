<script setup lang="ts">
import { ref } from 'vue'
import { EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from 'reka-ui'
import { Button } from '@/components/ui/button'

defineProps<{ label: string; workspace?: boolean; disabled: boolean }>()
const emit = defineEmits<{
  rename: [trigger: HTMLElement | null]
  delete: [trigger: HTMLElement | null]
  newConversation: []
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
  'flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
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
        side="right"
        :side-offset="6"
        class="z-40 min-w-36 rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
        @close-auto-focus="openingDialog && $event.preventDefault()"
      >
        <DropdownMenuItem v-if="workspace" :class="itemClass" @select="emit('newConversation')"
          ><PlusIcon class="size-3.5" aria-hidden="true" />新建对话</DropdownMenuItem
        >
        <DropdownMenuItem :class="itemClass" @select="choose('rename')"
          ><PencilIcon class="size-3.5" aria-hidden="true" />{{
            workspace ? '编辑工作区' : '重命名'
          }}</DropdownMenuItem
        >
        <DropdownMenuSeparator class="my-1 border-t" />
        <DropdownMenuItem
          :class="[itemClass, 'text-destructive focus:text-destructive']"
          @select="choose('delete')"
          ><Trash2Icon class="size-3.5" aria-hidden="true" />{{
            workspace ? '删除工作区' : '删除会话'
          }}</DropdownMenuItem
        >
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
