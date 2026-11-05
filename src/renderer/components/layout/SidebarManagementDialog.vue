<script lang="ts">
export interface ManagementTarget {
  kind: 'workspace' | 'conversation'
  id: string | null
  name: string
  rootPath: string
  deleting: boolean
}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui'
import { LoaderCircleIcon, XIcon } from '@lucide/vue'
import { parseName } from '@shared/chat'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  target: ManagementTarget
  busy: boolean
  error: string
  returnFocus: HTMLElement | null
}>()
const emit = defineEmits<{ close: []; confirm: [name: string] }>()
const name = ref(props.target.name)
const validationError = ref('')
const cancelButton = ref<InstanceType<typeof Button> | null>(null)
const previousFocus =
  props.returnFocus ??
  (document.activeElement instanceof HTMLElement ? document.activeElement : null)
const title = computed(() =>
  props.target.kind === 'conversation'
    ? props.target.deleting
      ? '删除会话'
      : '重命名会话'
    : props.target.deleting
      ? '删除项目'
      : props.target.id
        ? '编辑项目'
        : '编辑项目',
)
const description = computed(() =>
  props.target.deleting
    ? props.target.kind === 'workspace'
      ? '项目及其对话将从列表移除，磁盘文件保留。重新添加同一文件夹可恢复项目及对话。'
      : '此会话将从列表移除，当前窗口中的对应草稿也会清除。'
    : props.target.kind === 'workspace'
      ? '为这个文件夹设置一个便于识别的名称。'
      : '修改后的标题会保留，不会被自动生成的标题覆盖。',
)
function confirm(): void {
  if (props.busy) return
  validationError.value = ''
  try {
    emit('confirm', props.target.deleting ? props.target.name : parseName(name.value))
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : '请检查名称。'
  }
}
function initialFocus(event: Event): void {
  if (!props.target.deleting) return
  event.preventDefault()
  cancelButton.value?.$el.focus()
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (previousFocus?.isConnected) previousFocus.focus()
  else document.getElementById('new-conversation')?.focus()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-6 shadow-xl"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
        @open-auto-focus="initialFocus"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="pr-8 text-lg font-semibold">{{ title }}</DialogTitle>
        <DialogDescription class="mt-2 text-sm leading-6 text-muted-foreground">{{
          description
        }}</DialogDescription>
        <form class="mt-5 space-y-5" @submit.prevent="confirm">
          <p v-if="target.deleting" class="break-all rounded-lg bg-muted/60 px-3 py-2 text-sm">
            {{ target.name }}
          </p>
          <div v-else>
            <label for="management-name" class="text-sm font-medium">{{
              target.kind === 'workspace' ? '项目名称' : '会话标题'
            }}</label>
            <input
              id="management-name"
              v-model="name"
              class="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              :disabled="busy"
              maxlength="1024"
              required
              autocomplete="off"
            />
          </div>
          <div v-if="target.rootPath" class="space-y-1">
            <p class="text-xs text-muted-foreground">
              文件夹{{ !target.deleting && target.id ? '（创建后固定）' : '' }}
            </p>
            <p class="break-all text-sm leading-6">{{ target.rootPath }}</p>
          </div>
          <p
            v-if="validationError || error"
            role="alert"
            class="break-words text-sm text-destructive"
          >
            {{ validationError || error }}
          </p>
          <div class="flex justify-end gap-2 border-t pt-4">
            <Button
              ref="cancelButton"
              type="button"
              variant="outline"
              :disabled="busy"
              @click="emit('close')"
              >取消</Button
            >
            <Button
              type="submit"
              :variant="target.deleting ? 'destructive' : 'default'"
              :disabled="busy"
              class="gap-2"
              ><LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" aria-hidden="true" />{{
                target.deleting ? '确认删除' : '保存'
              }}</Button
            >
          </div>
        </form>
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
