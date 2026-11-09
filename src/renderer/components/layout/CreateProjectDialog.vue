<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui'
import { FolderIcon, FolderPlusIcon, LoaderCircleIcon, XIcon } from '@lucide/vue'
import { MAX_WORKSPACE_FOLDERS, parseWorkspaceInput } from '@shared/chat'
import type { SelectedDirectory, WorkspaceInput } from '@shared/chat'
import { getDesktopApi } from '@/lib/desktop'
import { Button } from '@/components/ui/button'

const props = defineProps<{ busy: boolean; error: string; returnFocus: HTMLElement | null }>()
const emit = defineEmits<{ close: []; create: [input: WorkspaceInput, selectionId: string] }>()
const name = ref('')
const directories = ref<SelectedDirectory[]>([])
const mainPath = ref('')
const selectionId = crypto.randomUUID()
const choosing = ref(false)
const removing = ref(false)
const validationError = ref('')
let disposed = false
const blocked = computed(() => props.busy || choosing.value || removing.value)
const canAdd = computed(() => !blocked.value && directories.value.length < MAX_WORKSPACE_FOLDERS)
const canCreate = computed(() => !blocked.value && !!name.value.trim() && !!mainPath.value)
async function chooseDirectories(): Promise<void> {
  if (!canAdd.value) return
  choosing.value = true
  validationError.value = ''
  try {
    const result = await getDesktopApi().chooseWorkspaceDirectories(selectionId)
    if (!result.ok) throw new Error(result.error)
    const first = result.value[0]
    if (!disposed && first) {
      directories.value.push(...result.value)
      if (!mainPath.value) {
        mainPath.value = first.path
        if (!name.value.trim()) name.value = first.name
      }
    }
  } catch (error) {
    if (!disposed)
      validationError.value = error instanceof Error ? error.message : '无法选择文件夹。'
  } finally {
    if (!disposed) choosing.value = false
  }
}
async function removeDirectory(path: string): Promise<void> {
  if (blocked.value) return
  removing.value = true
  validationError.value = ''
  try {
    const result = await getDesktopApi().discardWorkspaceDirectories(selectionId, path)
    if (!result.ok) throw new Error(result.error)
    if (disposed) return
    directories.value = directories.value.filter((directory) => directory.path !== path)
    if (mainPath.value === path) mainPath.value = directories.value[0]?.path ?? ''
  } catch (error) {
    if (!disposed)
      validationError.value = error instanceof Error ? error.message : '无法移除文件夹。'
  } finally {
    if (!disposed) removing.value = false
  }
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
onScopeDispose(() => {
  disposed = true
  void getDesktopApi()
    .discardWorkspaceDirectories(selectionId)
    .catch(() => {})
})
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !blocked && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-4 shadow-xl"
        @interact-outside.prevent
        @escape-key-down="blocked && $event.preventDefault()"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="pr-8 text-xl font-semibold">创建项目</DialogTitle>
        <DialogDescription class="sr-only">
          填写项目名称，选择本机源文件夹并指定主目录。
        </DialogDescription>
        <form class="mt-4" @submit.prevent="create">
          <label for="project-name" class="sr-only">项目名称</label>
          <div
            class="flex h-10 items-center rounded-xl border transition-colors focus-within:border-foreground/50 focus-within:ring-1 focus-within:ring-foreground/20"
          >
            <span
              class="flex h-5 w-10 shrink-0 items-center justify-center border-r text-muted-foreground"
              ><FolderIcon class="size-4" aria-hidden="true"
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
          <p id="project-source-heading" class="mb-2 mt-4 text-sm font-medium">源文件夹</p>
          <section
            aria-labelledby="project-source-heading"
            class="flex min-h-28 min-w-0 flex-col items-center justify-center gap-3 rounded-xl border bg-card px-4 py-5"
          >
            <ul v-if="directories.length" class="w-full min-w-0 divide-y">
              <li
                v-for="directory in directories"
                :key="directory.path"
                class="flex min-w-0 items-start gap-2 py-2.5 first:pt-0"
              >
                <FolderIcon
                  class="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <p class="break-words text-sm font-medium [overflow-wrap:anywhere]">
                    {{ directory.name }}
                  </p>
                  <p class="mt-1 break-all text-xs leading-5 text-muted-foreground">
                    {{ directory.path }}
                  </p>
                </div>
                <div class="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  <span class="rounded-lg border px-2 py-0.5 text-xs text-muted-foreground">
                    {{ directory.path === mainPath ? '主要' : '其他' }}
                  </span>
                  <Button
                    v-if="directory.path !== mainPath"
                    type="button"
                    variant="ghost"
                    size="xs"
                    :disabled="blocked"
                    :aria-label="`将 ${directory.name} 设为主要`"
                    @click="mainPath = directory.path"
                    >设为主要</Button
                  >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class="size-6 text-muted-foreground"
                    :disabled="blocked"
                    :aria-label="`移除 ${directory.name}`"
                    @click="removeDirectory(directory.path)"
                    ><XIcon class="size-3.5" aria-hidden="true"
                  /></Button>
                </div>
              </li>
            </ul>
            <p v-else class="text-sm text-muted-foreground">在此电脑上添加文件夹</p>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              class="gap-1.5 rounded-full"
              :disabled="!canAdd"
              @click="chooseDirectories"
              ><LoaderCircleIcon
                v-if="choosing"
                class="size-3.5 animate-spin"
                aria-hidden="true"
              /><FolderPlusIcon v-else class="size-3.5" aria-hidden="true" />{{
                choosing ? '正在选择…' : '添加'
              }}</Button
            >
            <p
              v-if="directories.length >= MAX_WORKSPACE_FOLDERS"
              class="text-xs text-muted-foreground"
            >
              最多可添加 {{ MAX_WORKSPACE_FOLDERS }} 个文件夹
            </p>
          </section>
          <p
            v-if="validationError || error"
            role="alert"
            class="mt-3 break-words text-sm text-destructive"
          >
            {{ validationError || error }}
          </p>
          <div class="mt-7 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              class="text-muted-foreground"
              :disabled="blocked"
              @click="emit('close')"
              >取消</Button
            >
            <Button
              type="submit"
              class="gap-2 rounded-xl bg-foreground text-background hover:bg-foreground/90"
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
