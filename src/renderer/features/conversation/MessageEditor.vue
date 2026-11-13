<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowUpIcon, LoaderCircleIcon } from '@lucide/vue'
import { MAX_MESSAGE_LENGTH } from '@shared/chat'
import AttachmentPicker from './AttachmentPicker.vue'
import AttachmentList from './AttachmentList.vue'
import { dragFiles, dropFiles, pasteFiles, isImageAttachment } from './attachment-files'
import type { AttachmentItem } from './attachment-files'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  modelValue: string
  busy: boolean
  disabled: boolean
  error: string
  attachments: AttachmentItem[]
  imageInput: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  submit: []
  cancel: []
  files: [files: File[]]
  remove: [index: number]
}>()
const input = ref<HTMLTextAreaElement | null>(null)
const resendHint = '重发会替换旧回答，已执行的操作会保留。'
const canSubmit = computed(
  () =>
    !props.busy &&
    !props.disabled &&
    (!!props.attachments.length || !!props.modelValue.trim()) &&
    (!props.attachments.some(isImageAttachment) || props.imageInput),
)
function receiveFiles(files: File[]): void {
  if (!props.busy && !props.disabled) emit('files', files)
}
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
    @dragover="dragFiles"
    @drop="dropFiles($event, receiveFiles)"
    @paste="pasteFiles($event, receiveFiles)"
  >
    <AttachmentList
      :items="attachments"
      removable
      :disabled="busy"
      @remove="emit('remove', $event)"
    />
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
    <p
      v-if="attachments.some(isImageAttachment) && !imageInput"
      class="mt-2 text-xs text-muted-foreground"
    >
      当前模型未启用图片输入，请在模型设置中启用、切换模型，或移除图片。
    </p>
    <div class="mt-2 flex items-center justify-end gap-1.5">
      <AttachmentPicker class="mr-auto" :disabled="busy || disabled" @files="receiveFiles" />
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
