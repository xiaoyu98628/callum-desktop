<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { LoaderCircleIcon, PencilIcon } from '@lucide/vue'
import type { ChatUserInput, UserInputAnswer } from '@shared/chat'
import { Button } from '@/components/ui/button'
import InteractionCard from './InteractionCard.vue'

const props = defineProps<{
  input: ChatUserInput
  reply: UserInputAnswer
  collapsed: boolean
  submitting: boolean
  cancelling: boolean
  unavailable: boolean
  error: string
}>()
const emit = defineEmits<{
  'update:collapsed': [value: boolean]
  'update:reply': [value: UserInputAnswer]
  submit: [id: string, skipped: boolean]
  reload: []
}>()
const groupId = useId()
const replyInput = ref<HTMLTextAreaElement | null>(null)
const body = ref<HTMLElement | null>(null)
const busy = computed(() => props.submitting || props.cancelling)
const disabled = computed(() => busy.value || props.unavailable)
const replyTooLong = computed(() => new TextEncoder().encode(props.reply.text).length > 4096)
const canSubmit = computed(
  () =>
    !disabled.value &&
    (props.reply.optionIndex !== null || !!props.reply.text.trim()) &&
    new TextEncoder().encode(props.reply.text).length <= 4096,
)
function updateText(event: Event): void {
  if (event.target instanceof HTMLTextAreaElement)
    emit('update:reply', { ...props.reply, text: event.target.value, skipped: false })
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    if (canSubmit.value) emit('submit', props.input.id, false)
  }
}
watch(
  () => props.error,
  async (error) => {
    if (!error) return
    await nextTick()
    if (body.value) body.value.scrollTop = 0
  },
)
watch(
  () => [props.reply.text, props.collapsed],
  async () => {
    await nextTick()
    const element = replyInput.value
    if (element && !props.collapsed) {
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 96)}px`
    }
  },
  { immediate: true },
)
</script>

<template>
  <InteractionCard
    label="问题"
    region-label="补充输入"
    :collapsed="collapsed"
    :busy="busy"
    :error="!!error"
    @update:collapsed="emit('update:collapsed', $event)"
  >
    <div ref="body" class="min-h-0 flex-1 overflow-y-auto px-4 pb-2 pt-1">
      <p v-if="replyTooLong" role="alert" class="mt-2 text-xs text-destructive">
        回复内容过长，请缩短后发送。
      </p>
      <div v-if="error" role="alert" class="mt-2 text-xs leading-5 text-destructive">
        <p class="break-words">{{ error }}</p>
        <Button variant="link" size="xs" :disabled="busy" @click="emit('reload')"
          >重新加载问题</Button
        >
      </div>
      <p class="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
        {{ input.question }}
      </p>
      <fieldset v-if="input.options.length" class="mt-3 space-y-1" :disabled="disabled">
        <legend class="sr-only">选择回复</legend>
        <label
          v-for="(option, index) in input.options"
          :key="index"
          class="relative flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-1 py-1.5 text-sm leading-5 hover:bg-muted/60 has-[:checked]:bg-muted/70 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-foreground/30 has-[:disabled]:cursor-default has-[:disabled]:opacity-60"
        >
          <input
            type="radio"
            :name="groupId"
            :value="index"
            :checked="reply.optionIndex === index"
            class="sr-only"
            @change="emit('update:reply', { ...reply, optionIndex: index, skipped: false })"
          />
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded border bg-muted/50 text-xs text-muted-foreground"
            aria-hidden="true"
            >{{ index + 1 }}</span
          >
          <span class="min-w-0 break-words [overflow-wrap:anywhere]">{{ option }}</span>
        </label>
      </fieldset>
    </div>
    <form
      class="flex shrink-0 items-end gap-2 px-4 pb-3 pt-2"
      @submit.prevent="canSubmit && emit('submit', input.id, false)"
    >
      <PencilIcon class="mb-2 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <label :for="`${groupId}-reply`" class="sr-only">自行回复</label>
      <textarea
        :id="`${groupId}-reply`"
        ref="replyInput"
        :value="reply.text"
        rows="1"
        maxlength="4096"
        placeholder="或自行撰写回复"
        class="block max-h-24 min-h-8 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
        :disabled="disabled"
        @input="updateText"
        @keydown="keydown"
      ></textarea>
      <Button
        type="button"
        variant="outline"
        size="xs"
        class="mb-0.5 shrink-0 rounded-full"
        :disabled="disabled"
        @click="emit('submit', input.id, true)"
        >跳过</Button
      >
      <Button
        type="submit"
        size="xs"
        class="mb-0.5 shrink-0 gap-1 rounded-full bg-foreground text-background hover:bg-foreground/90"
        :disabled="!canSubmit"
        ><LoaderCircleIcon
          v-if="submitting"
          class="size-3 animate-spin"
          aria-hidden="true"
        />发送</Button
      >
    </form>
  </InteractionCard>
</template>
