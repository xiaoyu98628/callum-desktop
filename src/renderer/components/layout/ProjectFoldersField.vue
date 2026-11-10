<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref } from 'vue'
import { FolderIcon, FolderPlusIcon, LoaderCircleIcon, XIcon } from '@lucide/vue'
import { MAX_WORKSPACE_FOLDERS } from '@shared/chat'
import type { SelectedDirectory } from '@shared/chat'
import { getDesktopApi } from '@/lib/desktop'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  folders: SelectedDirectory[]
  mainPath: string
  selectionId: string
  disabled: boolean
  headingId: string
}>()
const emit = defineEmits<{
  'update:folders': [folders: SelectedDirectory[]]
  'update:mainPath': [path: string]
  busy: [value: boolean]
  firstDirectory: [name: string]
}>()
const choosing = ref(false)
const removing = ref(false)
const error = ref('')
const list = ref<HTMLElement | null>(null)
const addButton = ref<InstanceType<typeof Button> | null>(null)
let disposed = false
const blocked = computed(() => props.disabled || choosing.value || removing.value)
const sortedFolders = computed(() =>
  props.folders.toSorted(
    (a, b) => Number(b.path === props.mainPath) - Number(a.path === props.mainPath),
  ),
)

async function choose(): Promise<void> {
  if (blocked.value || props.folders.length >= MAX_WORKSPACE_FOLDERS) return
  choosing.value = true
  emit('busy', true)
  error.value = ''
  try {
    const result = await getDesktopApi().chooseWorkspaceDirectories(props.selectionId)
    if (!result.ok) throw new Error(result.error)
    if (disposed) return
    const known = new Set(props.folders.map((folder) => folder.path))
    const added = result.value.filter((folder) => !known.has(folder.path))
    // 重选已有目录不占用新增选择额度；超出项目总量时撤销本次整批选择。
    const overflow = props.folders.length + added.length > MAX_WORKSPACE_FOLDERS
    for (const folder of result.value) {
      if (known.has(folder.path) || overflow) {
        const discarded = await getDesktopApi().discardWorkspaceDirectories(
          props.selectionId,
          folder.path,
        )
        if (!discarded.ok) throw new Error(discarded.error)
      }
    }
    if (disposed) return
    if (overflow) throw new Error(`项目最多可添加 ${MAX_WORKSPACE_FOLDERS} 个文件夹。`)
    emit('update:folders', [...props.folders, ...added])
    if (!props.mainPath && added[0]) {
      emit('update:mainPath', added[0].path)
      emit('firstDirectory', added[0].name)
    }
  } catch (failure) {
    if (!disposed) error.value = failure instanceof Error ? failure.message : '无法选择文件夹。'
  } finally {
    if (!disposed) {
      choosing.value = false
      emit('busy', false)
    }
  }
}

async function remove(path: string): Promise<void> {
  if (blocked.value) return
  removing.value = true
  emit('busy', true)
  error.value = ''
  try {
    const result = await getDesktopApi().discardWorkspaceDirectories(props.selectionId, path)
    if (!result.ok) throw new Error(result.error)
    if (disposed) return
    const folders = props.folders.filter((folder) => folder.path !== path)
    emit('update:folders', folders)
    if (props.mainPath === path) emit('update:mainPath', folders[0]?.path ?? '')
    removing.value = false
    emit('busy', false)
    await nextTick()
    if (!disposed) {
      const row = list.value?.querySelector('li')
      if (row) row.focus({ preventScroll: true })
      else addButton.value?.$el.focus()
    }
  } catch (failure) {
    if (!disposed) error.value = failure instanceof Error ? failure.message : '无法移除文件夹。'
  } finally {
    if (!disposed) {
      removing.value = false
      emit('busy', false)
    }
  }
}

async function selectMain(path: string, event: MouseEvent): Promise<void> {
  if (blocked.value) return
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('li') : null
  emit('update:mainPath', path)
  await nextTick()
  if (row?.isConnected) row.focus({ preventScroll: true })
}

onScopeDispose(() => {
  disposed = true
  emit('busy', false)
  // 选择授权只属于当前表单，关闭或取消时撤销；业务数据由保存接口提交。
  void getDesktopApi()
    .discardWorkspaceDirectories(props.selectionId)
    .catch(() => {})
})
</script>

<template>
  <p :id="headingId" class="mb-2 mt-3 text-sm font-medium">源文件夹</p>
  <section :aria-labelledby="headingId" class="min-w-0 overflow-hidden rounded-xl border bg-card">
    <ul v-if="folders.length" ref="list" class="min-w-0 divide-y border-b">
      <li
        v-for="folder in sortedFolders"
        :key="folder.path"
        tabindex="-1"
        class="group/folder flex h-12 min-w-0 items-center gap-2.5 px-3.5 focus-visible:outline-offset-[-2px]"
        :title="folder.path"
        :aria-label="folder.path === mainPath ? `主要目录 ${folder.name}` : undefined"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
          <FolderIcon class="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          <span class="truncate">{{ folder.name }}</span>
        </div>
        <span
          v-if="folder.path === mainPath"
          class="shrink-0 rounded-[10px] border px-2.5 py-1 text-xs text-muted-foreground"
          >主要</span
        >
        <Button
          v-else
          type="button"
          variant="secondary"
          size="sm"
          class="h-7 rounded-lg border px-2 font-normal text-foreground opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 disabled:opacity-0 group-hover/folder:disabled:opacity-50 group-focus-within/folder:disabled:opacity-50"
          :disabled="blocked"
          :aria-label="`将 ${folder.name} 设为主要`"
          @click="selectMain(folder.path, $event)"
          >设为主要</Button
        >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-6 text-muted-foreground/70"
          :disabled="blocked"
          :aria-label="`移除 ${folder.name}`"
          @click="remove(folder.path)"
          ><XIcon class="size-3.5" aria-hidden="true"
        /></Button>
      </li>
    </ul>
    <Button
      ref="addButton"
      type="button"
      variant="ghost"
      class="h-12 w-full justify-start gap-2.5 rounded-none px-3.5 font-normal"
      :disabled="blocked || folders.length >= MAX_WORKSPACE_FOLDERS"
      @click="choose"
    >
      <LoaderCircleIcon
        v-if="choosing"
        class="size-4 animate-spin text-muted-foreground/70"
        aria-hidden="true"
      />
      <FolderPlusIcon v-else class="size-4 text-muted-foreground/70" aria-hidden="true" />
      {{ choosing ? '正在选择…' : '添加文件夹' }}
    </Button>
  </section>
  <p v-if="folders.length >= MAX_WORKSPACE_FOLDERS" class="mt-2 text-xs text-muted-foreground">
    最多可添加 {{ MAX_WORKSPACE_FOLDERS }} 个文件夹
  </p>
  <p v-if="error" role="alert" class="mt-3 break-words text-sm text-destructive">{{ error }}</p>
</template>
