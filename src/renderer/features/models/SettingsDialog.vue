<script setup lang="ts">
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui'
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{ title: string; description: string; busy: boolean }>()
const emit = defineEmits<{ close: [] }>()
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (previousFocus?.isConnected) previousFocus.focus()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-6 shadow-xl"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="pr-8 text-lg font-semibold">{{ title }}</DialogTitle>
        <DialogDescription class="mt-2 break-words text-sm leading-6 text-muted-foreground">{{
          description
        }}</DialogDescription>
        <div class="mt-6"><slot /></div>
        <Button
          variant="ghost"
          size="icon"
          class="absolute right-4 top-4 size-8"
          aria-label="关闭对话框"
          :disabled="busy"
          @click="emit('close')"
          ><XIcon class="size-4" aria-hidden="true"
        /></Button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
