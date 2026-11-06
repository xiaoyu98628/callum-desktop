<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ChevronUpIcon, CircleHelpIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  label: string
  regionLabel: string
  collapsed: boolean
  busy: boolean
  count?: number
  error?: boolean
}>()
defineEmits<{ 'update:collapsed': [value: boolean] }>()
const panel = ref<HTMLElement | null>(null)
const collapsedButton = ref<InstanceType<typeof Button> | null>(null)
async function focusCard(): Promise<void> {
  await nextTick()
  if (props.collapsed) collapsedButton.value?.$el.focus({ preventScroll: true })
  else panel.value?.focus({ preventScroll: true })
}
onMounted(() => {
  if (!props.collapsed) void focusCard()
})
watch(
  () => props.collapsed,
  () => {
    void focusCard()
  },
)
</script>

<template>
  <section
    ref="panel"
    role="region"
    :aria-label="regionLabel"
    tabindex="-1"
    class="mx-auto mb-2 flex min-h-0 max-w-3xl flex-col outline-none"
    :class="
      collapsed
        ? ''
        : 'max-h-[min(28rem,60vh)] overflow-hidden rounded-3xl border bg-card shadow-sm focus-visible:border-foreground/25'
    "
  >
    <Button
      v-show="collapsed"
      ref="collapsedButton"
      type="button"
      variant="ghost"
      size="sm"
      class="w-fit gap-2 rounded-full text-xs text-muted-foreground"
      :aria-label="`展开${regionLabel}`"
      :aria-expanded="!collapsed"
      @click="$emit('update:collapsed', false)"
      ><CircleHelpIcon class="size-3.5" aria-hidden="true" />{{
        error ? '处理失败，请展开核对' : label
      }}<ChevronUpIcon class="size-3" aria-hidden="true"
    /></Button>
    <header v-show="!collapsed" class="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
      <CircleHelpIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
      <p class="text-xs text-muted-foreground">{{ label }}</p>
      <span v-if="count && count > 1" class="text-xs text-muted-foreground"
        >{{ count }} 项待处理</span
      >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        class="ml-auto size-6 text-muted-foreground"
        :aria-label="`收起${regionLabel}`"
        :disabled="busy"
        @click="$emit('update:collapsed', true)"
        ><XIcon class="size-3.5" aria-hidden="true"
      /></Button>
    </header>
    <div v-show="!collapsed" class="flex min-h-0 flex-1 flex-col"><slot /></div>
  </section>
</template>
