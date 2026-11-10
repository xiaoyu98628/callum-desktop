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
import { FolderIcon, LoaderCircleIcon, XIcon } from '@lucide/vue'
import { parseWorkspaceInput } from '@shared/chat'
import type { SelectedDirectory, WorkspaceInput } from '@shared/chat'
import { Button } from '@/components/ui/button'
import ProjectFoldersField from './ProjectFoldersField.vue'

const props = defineProps<{ busy: boolean; error: string; returnFocus: HTMLElement | null }>()
const emit = defineEmits<{ close: []; create: [input: WorkspaceInput, selectionId: string] }>()
const name = ref('')
const directories = ref<SelectedDirectory[]>([])
const mainPath = ref('')
const selectionId = crypto.randomUUID()
const foldersBusy = ref(false)
const validationError = ref('')
const blocked = computed(() => props.busy || foldersBusy.value)
const canCreate = computed(() => !blocked.value && !!name.value.trim())
function setDefaultName(value: string): void {
  if (!name.value.trim()) name.value = value
}
function create(): void {
  if (!canCreate.value) return
  validationError.value = ''
  try {
    emit(
      'create',
      parseWorkspaceInput({
        name: name.value,
        rootPath: mainPath.value,
        otherPaths: directories.value
          .filter((directory) => directory.path !== mainPath.value)
          .map((directory) => directory.path),
      }),
      selectionId,
    )
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : '请检查项目信息。'
  }
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (props.returnFocus?.isConnected) props.returnFocus.focus()
  else document.getElementById('new-conversation')?.focus()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !blocked && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/10 dark:bg-black/45" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border bg-background p-5 shadow-lg"
        @interact-outside.prevent
        @escape-key-down="blocked && $event.preventDefault()"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="pr-8 text-xl font-semibold">创建项目</DialogTitle>
        <DialogDescription class="sr-only">
          填写项目名称，选择本机源文件夹。点击“设为主要”可切换主要目录，主要目录始终排在首行。
        </DialogDescription>
        <form class="mt-3" @submit.prevent="create">
          <label for="project-name" class="sr-only">项目名称</label>
          <div
            class="flex h-10 items-center rounded-xl border bg-card transition-colors focus-within:border-blue-500"
          >
            <span
              class="flex h-5 w-10 shrink-0 items-center justify-center border-r text-muted-foreground"
              ><FolderIcon class="size-3.5" aria-hidden="true"
            /></span>
            <input
              id="project-name"
              v-model="name"
              class="h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
              placeholder="项目名称"
              maxlength="1024"
              :disabled="blocked"
              required
              autocomplete="off"
            />
          </div>
          <ProjectFoldersField
            v-model:folders="directories"
            v-model:main-path="mainPath"
            :selection-id="selectionId"
            :disabled="busy"
            heading-id="project-source-heading"
            @busy="foldersBusy = $event"
            @first-directory="setDefaultName"
          />
          <p
            v-if="validationError || error"
            role="alert"
            class="mt-3 break-words text-sm text-destructive"
          >
            {{ validationError || error }}
          </p>
          <div class="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="rounded-[10px] px-4 text-muted-foreground"
              :disabled="blocked"
              @click="emit('close')"
              >取消</Button
            >
            <Button
              type="submit"
              size="sm"
              class="gap-2 rounded-[10px] bg-foreground px-4 text-background hover:bg-foreground/90"
              :disabled="!canCreate"
              ><LoaderCircleIcon
                v-if="busy"
                class="size-3.5 animate-spin"
                aria-hidden="true"
              />创建项目</Button
            >
          </div>
        </form>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="absolute right-3 top-3 size-7 text-muted-foreground"
          aria-label="关闭对话框"
          :disabled="blocked"
          @click="emit('close')"
          ><XIcon class="size-4" aria-hidden="true"
        /></Button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
