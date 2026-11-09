<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref } from 'vue'
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
const sortedDirectories = computed(() =>
  directories.value.toSorted(
    (a, b) => Number(b.path === mainPath.value) - Number(a.path === mainPath.value),
  ),
)
async function selectMain(path: string, event: MouseEvent): Promise<void> {
  if (blocked.value) return
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('li') : null
  mainPath.value = path
  // 切换后操作按钮会变成“主要”标记，将焦点留在置顶后的目录行。
  await nextTick()
  if (row?.isConnected) row.focus({ preventScroll: true })
}
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
          <p id="project-source-heading" class="mb-2 mt-3 text-sm font-medium">源文件夹</p>
          <section
            aria-labelledby="project-source-heading"
            class="min-w-0 overflow-hidden rounded-xl border bg-card"
          >
            <ul v-if="directories.length" class="min-w-0 divide-y border-b">
              <li
                v-for="directory in sortedDirectories"
                :key="directory.path"
                class="group/folder flex h-12 min-w-0 items-center gap-2.5 px-3.5 focus-visible:outline-offset-[-2px]"
                :title="directory.path"
                :tabindex="directory.path === mainPath ? -1 : undefined"
                :aria-label="directory.path === mainPath ? `主要目录 ${directory.name}` : undefined"
              >
                <div class="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
                  <FolderIcon class="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                  <span class="truncate">{{ directory.name }}</span>
                </div>
                <span
                  v-if="directory.path === mainPath"
                  class="shrink-0 rounded-[10px] border px-2.5 py-1 text-xs text-muted-foreground"
                  >主要</span
                >
                <Button
                  v-else
                  type="button"
                  variant="secondary"
                  size="sm"
                  class="h-7 rounded-lg border px-2 font-normal text-foreground opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100"
                  :disabled="blocked"
                  :aria-label="`将 ${directory.name} 设为主要`"
                  @click="selectMain(directory.path, $event)"
                  >设为主要</Button
                >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="size-6 text-muted-foreground/70"
                  :disabled="blocked"
                  :aria-label="`移除 ${directory.name}`"
                  @click="removeDirectory(directory.path)"
                  ><XIcon class="size-3.5" aria-hidden="true"
                /></Button>
              </li>
            </ul>
            <Button
              type="button"
              variant="ghost"
              class="h-12 w-full justify-start gap-2.5 rounded-none px-3.5 font-normal"
              :disabled="!canAdd"
              @click="chooseDirectories"
              ><LoaderCircleIcon
                v-if="choosing"
                class="size-4 animate-spin text-muted-foreground/70"
                aria-hidden="true"
              /><FolderPlusIcon v-else class="size-4 text-muted-foreground/70" aria-hidden="true" />
              {{ choosing ? '正在选择…' : '添加文件夹' }}</Button
            >
          </section>
          <p
            v-if="directories.length >= MAX_WORKSPACE_FOLDERS"
            class="mt-2 text-xs text-muted-foreground"
          >
            最多可添加 {{ MAX_WORKSPACE_FOLDERS }} 个文件夹
          </p>
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
