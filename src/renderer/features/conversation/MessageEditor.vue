<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowUpIcon, LoaderCircleIcon } from '@lucide/vue'
import { MAX_MESSAGE_LENGTH } from '@shared/chat'
import { Button } from '@/components/ui/button'

const props = defineProps<{ modelValue: string; busy: boolean; disabled: boolean; error: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; submit: []; cancel: [] }>()
const input = ref<HTMLTextAreaElement | null>(null)
const resendHint = '重发会替换旧回答，已执行的操作会保留。'
const canSubmit = computed(() => !props.busy && !props.disabled && !!props.modelValue.trim())
function submit(): void {
  if (canSubmit.value) emit('submit')
}
function keydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Escape' && !props.busy) {
    event.preventDefault()
    emit('cancel')
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    submit()
  }
}
onMounted(() => {
  input.value?.focus({ preventScroll: true })
})
</script>

<template>
  <form
    class="min-w-0 rounded-2xl border bg-muted/60 px-3 pt-2.5 pb-2"
    aria-label="编辑最后一条提问"
    @submit.prevent="submit"
  >
    <label class="sr-only" for="edit-message">编辑提问</label>
    <textarea
      id="edit-message"
      ref="input"
      :value="modelValue"
      rows="1"
      :maxlength="MAX_MESSAGE_LENGTH"
      :disabled="busy"
      class="block max-h-48 min-h-6 w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 outline-none [field-sizing:content]"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown="keydown"
    />
    <span id="edit-message-hint" class="sr-only">{{ resendHint }}</span>
    <p v-if="error" role="alert" class="mt-2 break-words text-xs text-destructive">{{ error }}</p>
    <div class="mt-2 flex items-center justify-end gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 rounded-full text-muted-foreground hover:bg-background/70 hover:text-foreground"
        aria-label="取消编辑"
        :disabled="busy"
        @click="$emit('cancel')"
        >取消</Button
      >
      <Button
        type="submit"
        size="icon"
        class="size-7 rounded-full bg-foreground text-background hover:bg-foreground/90"
        :disabled="!canSubmit"
        :aria-label="busy ? '正在重新发送' : '重新发送'"
        :aria-busy="busy"
        aria-describedby="edit-message-hint"
        :title="busy ? '正在重新发送…' : `重新发送。${resendHint}`"
      >
        <LoaderCircleIcon v-if="busy" class="size-4 animate-spin" aria-hidden="true" />
        <ArrowUpIcon v-else class="size-4" aria-hidden="true" />
      </Button>
    </div>
  </form>
</template>
