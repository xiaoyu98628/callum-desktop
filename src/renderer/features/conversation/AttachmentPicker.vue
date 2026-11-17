<script setup lang="ts">
import { ref, watch } from 'vue'
import { PaperclipIcon, PlusIcon } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { Button } from '@/components/ui/button'

const props = defineProps<{ disabled: boolean; menuAnchor?: HTMLElement | null }>()
const emit = defineEmits<{ files: [files: File[]] }>()
const input = ref<HTMLInputElement | null>(null)
const open = ref(false)

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false
  },
)

function chooseFiles(): void {
  if (!props.disabled) input.value?.click()
}

function selected(): void {
  if (!input.value) return
  const files = Array.from(input.value.files ?? [])
  input.value.value = ''
  if (files.length) emit('files', files)
}
</script>

<template>
  <input ref="input" type="file" multiple hidden @change="selected" />
  <DropdownMenuRoot v-if="menuAnchor !== undefined" v-model:open="open" :modal="false">
    <DropdownMenuTrigger as-child :disabled="disabled">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        class="size-7 rounded-full text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        aria-label="添加"
        title="添加"
      >
        <PlusIcon class="size-4" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        v-if="menuAnchor"
        :reference="menuAnchor"
        side="top"
        align="start"
        :side-offset="8"
        :collision-padding="12"
        class="z-50 w-[var(--reka-dropdown-menu-trigger-width)] max-w-[var(--reka-dropdown-menu-content-available-width)] rounded-xl border bg-card p-1 text-card-foreground shadow-lg outline-none"
      >
        <DropdownMenuLabel class="px-2 pt-1 pb-0.5 text-xs leading-4 text-muted-foreground">
          添加
        </DropdownMenuLabel>
        <DropdownMenuItem
          :disabled="disabled"
          class="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
          @select="chooseFiles"
        >
          <PaperclipIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          添加附件
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <Button
    v-else
    type="button"
    variant="ghost"
    size="icon"
    class="size-7 shrink-0 rounded-full text-muted-foreground"
    :disabled="disabled"
    aria-label="添加附件"
    title="添加附件"
    @click="chooseFiles"
  >
    <PaperclipIcon class="size-4" aria-hidden="true" />
  </Button>
</template>
