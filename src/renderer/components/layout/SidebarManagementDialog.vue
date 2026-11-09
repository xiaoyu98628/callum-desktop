<script lang="ts">
export interface ManagementTarget {
  kind: 'workspace' | 'conversation'
  id: string | null
  name: string
  rootPath: string
  otherPaths: string[]
  deleting: boolean
}
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui'
import { FolderIcon, LoaderCircleIcon, XIcon } from '@lucide/vue'
import { parseName } from '@shared/chat'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  target: ManagementTarget
  busy: boolean
  error: string
  returnFocus: HTMLElement | null
}>()
const emit = defineEmits<{ close: []; confirm: [name: string, rootPath?: string]; remove: [] }>()
const name = ref(props.target.name)
const mainPath = ref(props.target.rootPath)
const validationError = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const cancelButton = ref<InstanceType<typeof Button> | null>(null)
const previousFocus =
  props.returnFocus ??
  (document.activeElement instanceof HTMLElement ? document.activeElement : null)
const editingWorkspace = computed(() => props.target.kind === 'workspace' && !props.target.deleting)
const directories = computed(() =>
  [props.target.rootPath, ...props.target.otherPaths]
    .toSorted((a, b) => Number(b === mainPath.value) - Number(a === mainPath.value))
    .map((path) => ({ path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path })),
)
const title = computed(() =>
  props.target.kind === 'conversation'
    ? props.target.deleting
      ? '删除会话'
      : '重命名会话'
    : props.target.deleting
      ? '删除项目'
      : '编辑项目',
)
const description = computed(() =>
  props.target.deleting
    ? props.target.kind === 'workspace'
      ? '项目及其对话将从列表移除，磁盘文件保留。重新添加同一主目录可恢复项目及对话，其他目录以新选择为准。'
      : '此会话将从列表移除，当前窗口中的对应草稿也会清除。'
    : props.target.kind === 'workspace'
      ? '修改项目名称，点击“设为主要”可切换主要目录，主要目录始终排在首行。保存后作为相对路径的基准。'
      : '保持简短且易于识别',
)
function confirm(): void {
  if (props.busy) return
  validationError.value = ''
  try {
    emit(
      'confirm',
      props.target.deleting ? props.target.name : parseName(name.value),
      editingWorkspace.value && mainPath.value !== props.target.rootPath
        ? mainPath.value
        : undefined,
    )
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : '请检查名称。'
  }
}
async function selectMain(path: string, event: MouseEvent): Promise<void> {
  if (props.busy) return
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('li') : null
  mainPath.value = path
  // 操作按钮切换为“主要”标记后，将焦点留在置顶后的目录行。
  await nextTick()
  if (row?.isConnected) row.focus({ preventScroll: true })
}
function initialFocus(event: Event): void {
  event.preventDefault()
  if (props.target.deleting) cancelButton.value?.$el.focus()
  else {
    nameInput.value?.focus()
    nameInput.value?.select()
  }
}
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (previousFocus?.isConnected) previousFocus.focus()
  else document.getElementById('new-conversation')?.focus()
}
// 项目编辑切到移除确认时复用同一弹窗，焦点转到取消，避免回车误删。
watch(
  () => props.target.deleting,
  (deleting) => {
    if (!deleting) return
    validationError.value = ''
    cancelButton.value?.$el.focus()
  },
  { flush: 'post' },
)
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('close')">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-40"
        :class="
          target.deleting ? 'bg-black/30 backdrop-blur-[2px]' : 'bg-black/10 dark:bg-black/45'
        "
      />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border bg-background p-5 shadow-lg"
        :class="editingWorkspace ? 'max-w-[520px]' : 'max-w-[420px]'"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
        @open-auto-focus="initialFocus"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="pr-8 text-xl font-semibold">{{ title }}</DialogTitle>
        <DialogDescription
          :class="editingWorkspace ? 'sr-only' : 'mt-1 text-sm leading-6 text-muted-foreground'"
          >{{ description }}</DialogDescription
        >
        <form class="mt-3" @submit.prevent="confirm">
          <p v-if="target.deleting" class="break-all rounded-lg bg-muted/60 px-3 py-2 text-sm">
            {{ target.name }}
          </p>
          <div v-else>
            <label for="management-name" class="sr-only">{{
              target.kind === 'workspace' ? '项目名称' : '会话标题'
            }}</label>
            <div
              class="flex items-center border bg-card transition-colors focus-within:border-blue-500"
              :class="
                editingWorkspace
                  ? 'h-10 rounded-xl'
                  : 'h-9 rounded-[10px] focus-within:ring-1 focus-within:ring-blue-500'
              "
            >
              <span
                v-if="editingWorkspace"
                class="flex h-5 w-10 shrink-0 items-center justify-center border-r text-muted-foreground"
                ><FolderIcon class="size-3.5" aria-hidden="true"
              /></span>
              <input
                id="management-name"
                ref="nameInput"
                v-model="name"
                class="h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:opacity-50"
                :disabled="busy"
                maxlength="1024"
                required
                autocomplete="off"
              />
            </div>
          </div>
          <template v-if="editingWorkspace">
            <p id="management-source-heading" class="mb-2 mt-3 text-sm font-medium">源文件夹</p>
            <section
              aria-labelledby="management-source-heading"
              class="min-w-0 overflow-hidden rounded-xl border bg-card"
            >
              <ul class="min-w-0 divide-y">
                <li
                  v-for="directory in directories"
                  :key="directory.path"
                  class="group/folder flex h-12 min-w-0 items-center gap-2.5 px-3.5 focus-visible:outline-offset-[-2px]"
                  :title="directory.path"
                  :tabindex="directory.path === mainPath ? -1 : undefined"
                  :aria-label="
                    directory.path === mainPath ? `主要目录 ${directory.name}` : undefined
                  "
                >
                  <div class="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
                    <FolderIcon
                      class="size-4 shrink-0 text-muted-foreground/70"
                      aria-hidden="true"
                    />
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
                    :disabled="busy"
                    :aria-label="`将 ${directory.name} 设为主要`"
                    @click="selectMain(directory.path, $event)"
                    >设为主要</Button
                  >
                </li>
              </ul>
            </section>
          </template>
          <div v-else-if="target.rootPath" class="mt-4 space-y-1">
            <p class="text-xs text-muted-foreground">文件夹</p>
            <p class="break-all text-sm leading-6">{{ target.rootPath }}</p>
          </div>
          <p
            v-if="validationError || error"
            role="alert"
            class="mt-3 break-words text-sm text-destructive"
          >
            {{ validationError || error }}
          </p>
          <div class="mt-5 flex flex-wrap items-center justify-end gap-2">
            <Button
              v-if="editingWorkspace"
              type="button"
              variant="ghost"
              size="sm"
              class="mr-auto rounded-[10px] bg-destructive/10 px-4 text-destructive hover:bg-destructive/15 hover:text-destructive"
              :disabled="busy"
              @click="emit('remove')"
              >移除本地项目</Button
            >
            <Button
              ref="cancelButton"
              type="button"
              :variant="editingWorkspace ? 'ghost' : 'outline'"
              size="sm"
              class="rounded-[10px] px-4"
              :class="editingWorkspace ? 'text-muted-foreground' : ''"
              :disabled="busy"
              @click="emit('close')"
              >取消</Button
            >
            <Button
              type="submit"
              :variant="target.deleting ? 'destructive' : 'default'"
              size="sm"
              class="gap-2 rounded-[10px] px-4"
              :class="target.deleting ? '' : 'bg-foreground text-background hover:bg-foreground/90'"
              :disabled="busy"
              ><LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" aria-hidden="true" />{{
                target.deleting ? '确认删除' : '保存'
              }}</Button
            >
          </div>
        </form>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="absolute right-3 top-3 size-7 text-muted-foreground"
          aria-label="关闭对话框"
          :disabled="busy"
          @click="emit('close')"
          ><XIcon class="size-4" aria-hidden="true"
        /></Button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
