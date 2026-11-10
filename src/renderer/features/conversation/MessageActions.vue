<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { CheckIcon, CopyIcon, LoaderCircleIcon, PencilIcon } from '@lucide/vue'
import {
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui'
import type { ChatMessage } from '@shared/chat'
import { messageText } from '@shared/message-actions'
import { formatMessageTime, fullMessageTime, messageTime } from '@shared/message-time'
import { Button } from '@/components/ui/button'
import { getDesktopApi } from '@/lib/desktop'

const props = defineProps<{
  message: ChatMessage
  editable: boolean
  editDisabled: boolean
  now: number
}>()
defineEmits<{ edit: [] }>()
const text = computed(() => messageText(props.message.content))
const label = computed(() => (props.message.role === 'user' ? '复制提问' : '复制回答'))
const timestamp = computed(() => messageTime(props.message))
const copying = ref(false),
  copied = ref(false),
  error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false,
  generation = 0
function reset(): void {
  generation++
  clearTimeout(timer)
  copied.value = false
  error.value = ''
}
async function copy(): Promise<void> {
  if (!text.value || copying.value) return
  const token = generation,
    value = text.value
  copying.value = true
  copied.value = false
  clearTimeout(timer)
  error.value = ''
  try {
    const result = await getDesktopApi().copyMessage(value)
    if (!result.ok) throw new Error(result.error)
    if (!result.value) throw new Error('消息复制失败，请重试。')
    if (!disposed && token === generation) {
      copied.value = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        copied.value = false
      }, 2000)
    }
  } catch (cause) {
    if (!disposed && token === generation)
      error.value = cause instanceof Error ? cause.message : '消息复制失败，请重试。'
  } finally {
    if (!disposed) copying.value = false
  }
}
watch([() => props.message.id, text], reset)
onScopeDispose(() => {
  disposed = true
  clearTimeout(timer)
})
</script>

<template>
  <div
    v-if="text || editable"
    class="mt-1 flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground"
  >
    <div
      role="group"
      aria-label="消息操作"
      class="flex items-center gap-0.5 opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        class="size-7 rounded-lg aria-disabled:opacity-50"
        :aria-label="label"
        :title="copied ? '已复制' : label"
        :disabled="!text"
        :aria-disabled="copying"
        :aria-busy="copying"
        @click="copy"
      >
        <LoaderCircleIcon v-if="copying" class="size-3.5 animate-spin" aria-hidden="true" />
        <CheckIcon v-else-if="copied" class="size-3.5" aria-hidden="true" />
        <CopyIcon v-else class="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        v-if="editable"
        type="button"
        variant="ghost"
        size="icon"
        class="size-7 rounded-lg"
        aria-label="编辑提问"
        title="编辑提问"
        :disabled="editDisabled"
        @click="$emit('edit')"
      >
        <PencilIcon class="size-3.5" aria-hidden="true" />
      </Button>
      <TooltipProvider v-if="timestamp" :delay-duration="250" disable-hoverable-content>
        <TooltipRoot ignore-non-keyboard-focus>
          <TooltipTrigger as-child>
            <time
              tabindex="0"
              :datetime="new Date(timestamp.value).toISOString()"
              :aria-label="timestamp.label"
              class="ml-1.5 inline-flex min-h-7 cursor-default items-center rounded px-1 text-xs font-normal tabular-nums text-muted-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >{{ formatMessageTime(timestamp.value, now) }}</time
            >
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent
              side="top"
              :side-offset="6"
              :collision-padding="12"
              class="pointer-events-none z-50 max-w-[calc(100vw-1.5rem)] rounded-md bg-[#202123] px-2.5 py-1.5 text-xs leading-5 text-white shadow-sm"
              >{{ timestamp.label }} · {{ fullMessageTime(timestamp.value) }}</TooltipContent
            >
          </TooltipPortal>
        </TooltipRoot>
      </TooltipProvider>
    </div>
    <span v-if="copied" role="status" class="sr-only">已复制</span>
    <span v-if="error" role="alert" class="max-w-full break-words px-1 text-destructive">{{
      error
    }}</span>
  </div>
</template>
