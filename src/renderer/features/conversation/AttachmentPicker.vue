<script setup lang="ts">
import { ref } from 'vue'
import { PaperclipIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ files: [files: File[]] }>()
const input = ref<HTMLInputElement | null>(null)
function selected(): void {
  if (!input.value) return
  const files = Array.from(input.value.files ?? [])
  input.value.value = ''
  if (files.length) emit('files', files)
}
</script>

<template>
  <input ref="input" type="file" multiple hidden @change="selected" />
  <Button
    type="button"
    variant="ghost"
    size="icon"
    class="size-7 shrink-0 rounded-full text-muted-foreground"
    :disabled="disabled"
    aria-label="添加附件"
    title="添加附件"
    @click="input?.click()"
  >
    <PaperclipIcon class="size-4" aria-hidden="true" />
  </Button>
</template>
