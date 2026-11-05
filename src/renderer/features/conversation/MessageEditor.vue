<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { LoaderCircleIcon } from '@lucide/vue'
import { MAX_MESSAGE_LENGTH } from '@shared/chat'
import { Button } from '@/components/ui/button'

const props = defineProps<{ modelValue: string; busy: boolean; disabled: boolean; error: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; submit: []; cancel: [] }>()
const input = ref<HTMLTextAreaElement | null>(null)
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
    class="min-w-0 rounded-2xl border bg-card p-3"
    aria-label="编辑最后一条提问"
    @submit.prevent="submit"
  >
    <label class="sr-only" for="edit-message">编辑提问</label>
    <textarea
      id="edit-message"
      ref="input"
      :value="modelValue"
      rows="3"
      :maxlength="MAX_MESSAGE_LENGTH"
      :disabled="busy"
      aria-describedby="edit-message-hint"
      class="block max-h-48 min-h-24 w-full resize-y bg-transparent text-sm leading-6 outline-none"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown="keydown"
    />
    <p id="edit-message-hint" class="mt-2 text-xs leading-5 text-muted-foreground">
      重新发送会替换旧回答，已执行的工具操作不会撤销。
    </p>
    <p v-if="error" role="alert" class="mt-2 break-words text-xs text-destructive">{{ error }}</p>
    <div class="mt-3 flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" :disabled="busy" @click="$emit('cancel')"
        >取消编辑</Button
      >
      <Button type="submit" size="sm" :disabled="!canSubmit">
        <LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" aria-hidden="true" />
        {{ busy ? '正在重新发送…' : '重新发送' }}
      </Button>
    </div>
  </form>
</template>
