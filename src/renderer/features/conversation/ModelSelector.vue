<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@lucide/vue'
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from 'reka-ui'
import type { ChatModel } from '@shared/chat'

const props = defineProps<{ modelValue: string; models: ChatModel[]; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
const selectedModel = computed(() => props.models.find((model) => model.id === props.modelValue))
function selectModel(value: unknown): void {
  if (
    !props.disabled &&
    typeof value === 'string' &&
    props.models.some((model) => model.id === value)
  )
    emit('update:modelValue', value)
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false
  },
)
</script>

<template>
  <SelectRoot
    v-model:open="open"
    :model-value="modelValue"
    :disabled="disabled"
    @update:model-value="selectModel"
  >
    <SelectTrigger
      aria-label="模型"
      :title="selectedModel?.name ?? '当前模型不可用'"
      class="group inline-flex h-8 min-w-0 max-w-56 items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
    >
      <SelectValue class="min-w-0 truncate">{{
        selectedModel?.name ?? '当前模型不可用'
      }}</SelectValue>
      <SelectIcon as-child
        ><ChevronDownIcon
          class="size-3.5 shrink-0 opacity-70 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
      /></SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        aria-label="选择模型"
        position="popper"
        side="top"
        align="end"
        :side-offset="8"
        :collision-padding="12"
        class="z-50 flex max-h-[min(18rem,var(--reka-select-content-available-height))] min-w-56 max-w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-card p-1.5 text-card-foreground shadow-[0_8px_32px_-8px_rgba(0,0,0,0.2)] outline-none"
      >
        <SelectScrollUpButton
          class="flex h-5 shrink-0 items-center justify-center text-muted-foreground"
          ><ChevronUpIcon class="size-3.5" aria-hidden="true"
        /></SelectScrollUpButton>
        <SelectViewport class="min-h-0">
          <SelectGroup>
            <SelectLabel class="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground"
              >选择模型</SelectLabel
            >
            <SelectItem
              v-if="modelValue && !selectedModel"
              :value="modelValue"
              disabled
              class="relative flex items-center rounded-lg px-2.5 py-2 text-xs text-muted-foreground opacity-50"
              ><SelectItemText>当前模型不可用</SelectItemText></SelectItem
            >
            <SelectItem
              v-for="model in models"
              :key="model.id"
              :value="model.id"
              :text-value="model.name"
              :title="model.name"
              class="relative flex cursor-pointer select-none items-center gap-4 rounded-lg px-2.5 py-2 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:font-medium data-[state=checked]:text-primary"
            >
              <SelectItemText class="min-w-0 flex-1"
                ><span class="block truncate">{{ model.name }}</span></SelectItemText
              >
              <span class="flex size-4 shrink-0 items-center justify-center"
                ><SelectItemIndicator
                  ><CheckIcon
                    class="size-3.5 text-primary"
                    aria-hidden="true" /></SelectItemIndicator
              ></span>
            </SelectItem>
          </SelectGroup>
        </SelectViewport>
        <SelectScrollDownButton
          class="flex h-5 shrink-0 items-center justify-center text-muted-foreground"
          ><ChevronDownIcon class="size-3.5" aria-hidden="true"
        /></SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
