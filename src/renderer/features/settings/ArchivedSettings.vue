<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue'
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from 'reka-ui'
import { LoaderCircleIcon, RefreshCwIcon } from '@lucide/vue'
import type { Conversation, Workspace } from '@shared/chat'
import { Button } from '@/components/ui/button'
import { useConversations } from '@/features/conversation/useConversations'

const {
  state,
  openArchives,
  closeArchives,
  changeArchiveKind,
  refreshArchives,
  setConversationArchived,
  setWorkspaceArchived,
  deleteConversation,
} = useConversations()
const heading = useTemplateRef<HTMLHeadingElement>('heading')
const unarchiveError = ref('')
const deleteError = ref('')
const notice = ref('')
const updating = ref(false)
const pendingDeletion = shallowRef<{ id: string; title: string; trigger: HTMLElement } | null>(null)
let disposed = false

const label = computed(() => (state.archiveKind === 'workspaces' ? '项目' : '会话'))
const rows = computed(() =>
  state.archiveKind === 'workspaces' ? state.archivedWorkspaces : state.archivedConversations,
)
const busy = computed(() => state.managing || updating.value)
const disabled = computed(() => busy.value || !!state.serviceError)
const error = computed(() => unarchiveError.value || state.archivesError || state.serviceError)

onMounted(openArchives)
onScopeDispose(() => {
  disposed = true
  closeArchives()
})
watch(rows, (items) => {
  const target = pendingDeletion.value
  if (target && !updating.value && !items.some((item) => item.id === target.id)) clearDeletion()
})

function itemName(item: Conversation | Workspace): string {
  return 'title' in item ? item.title : item.name
}
function itemDescription(item: Conversation | Workspace): string {
  if ('rootPath' in item) return item.rootPath || '未添加文件夹'
  return item.workspaceId
    ? (state.workspaces.find((workspace) => workspace.id === item.workspaceId)?.name ?? '项目会话')
    : '独立会话'
}
function itemKey(item: Conversation | Workspace): string {
  return 'rootPath' in item ? `workspace:${item.id}` : item.id
}
function resetFeedback(): void {
  unarchiveError.value = ''
  notice.value = ''
}
function clearDeletion(): void {
  pendingDeletion.value = null
  deleteError.value = ''
}
function loadArchives(more: boolean): void {
  resetFeedback()
  if (!more) clearDeletion()
  void refreshArchives(more)
}
function changeView(value: string | number): void {
  if (busy.value || (value !== 'workspaces' && value !== 'conversations')) return
  resetFeedback()
  clearDeletion()
  changeArchiveKind(value)
}
function focusAfterRemoval(trigger: EventTarget | null): void {
  if (document.activeElement === trigger || document.activeElement === document.body)
    heading.value?.focus()
}
async function unarchive(item: Conversation | Workspace, event: MouseEvent): Promise<void> {
  if (disabled.value) return
  const trigger = event.currentTarget
  const project = 'rootPath' in item
  updating.value = true
  resetFeedback()
  clearDeletion()
  try {
    if (project) await setWorkspaceArchived(item.id, false)
    else await setConversationArchived(item.id, false)
    if (disposed) return
    notice.value = project ? `已取消归档项目“${item.name}”` : `已取消归档“${item.title}”`
    focusAfterRemoval(trigger)
  } catch (error) {
    if (!disposed)
      unarchiveError.value =
        error instanceof Error
          ? error.message
          : `无法取消归档${project ? '项目' : '会话'}，请重试。`
  } finally {
    updating.value = false
  }
}
async function requestDeletion(item: Conversation, event: MouseEvent): Promise<void> {
  const trigger = event.currentTarget
  if (disabled.value || !(trigger instanceof HTMLElement)) return
  resetFeedback()
  deleteError.value = ''
  const target = { id: item.id, title: item.title, trigger }
  pendingDeletion.value = target
  await nextTick()
  if (pendingDeletion.value === target)
    document.getElementById(`archive-delete-cancel-${item.id}`)?.focus()
}
function cancelDeletion(): void {
  const trigger = pendingDeletion.value?.trigger
  clearDeletion()
  if (trigger?.isConnected) trigger.focus()
}
async function confirmDeletion(event: MouseEvent): Promise<void> {
  const target = pendingDeletion.value
  if (!target || disabled.value) return
  const trigger = event.currentTarget
  updating.value = true
  deleteError.value = ''
  try {
    await deleteConversation(target.id)
    if (disposed) return
    clearDeletion()
    notice.value = `已删除“${target.title}”`
    focusAfterRemoval(trigger)
  } catch (error) {
    if (!disposed)
      deleteError.value = error instanceof Error ? error.message : '无法删除会话，请重试。'
  } finally {
    updating.value = false
  }
}
</script>

<template>
  <section class="min-w-0" aria-labelledby="archived-settings-title">
    <h2
      id="archived-settings-title"
      ref="heading"
      tabindex="-1"
      class="text-base font-semibold tracking-tight outline-none"
    >
      已归档
    </h2>
    <p class="mt-2 text-xs leading-6 text-muted-foreground">
      {{
        state.archiveKind === 'workspaces'
          ? '取消归档后，项目及其未归档的会话会重新显示。'
          : '取消归档后，会话会回到原来的项目或最近列表。'
      }}
    </p>

    <TabsRoot class="mt-6" :model-value="state.archiveKind" @update:model-value="changeView">
      <div class="my-3 flex items-center justify-between gap-3">
        <TabsList aria-label="归档类型" class="flex gap-1 rounded-xl bg-muted p-1">
          <TabsTrigger
            value="conversations"
            :disabled="busy"
            class="rounded-lg px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-popover data-[state=active]:shadow-sm disabled:opacity-50"
            >会话</TabsTrigger
          >
          <TabsTrigger
            value="workspaces"
            :disabled="busy"
            class="rounded-lg px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-popover data-[state=active]:shadow-sm disabled:opacity-50"
            >项目</TabsTrigger
          >
        </TabsList>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          :disabled="state.archivesLoading || disabled"
          :aria-label="`刷新已归档${label}`"
          @click="loadArchives(false)"
          ><RefreshCwIcon class="size-3.5" aria-hidden="true" />刷新</Button
        >
      </div>
      <TabsContent :value="state.archiveKind" class="outline-none">
        <p v-if="error" role="alert" class="mb-3 break-words text-sm text-destructive">
          {{ error }}
        </p>
        <p v-if="notice" role="status" class="mb-3 break-words text-sm text-muted-foreground">
          {{ notice }}
        </p>
        <div
          v-if="state.archivesLoading && !rows.length"
          role="status"
          class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
          <LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />正在加载已归档{{
            label
          }}…
        </div>
        <p
          v-else-if="!rows.length && !error"
          class="py-8 text-center text-sm text-muted-foreground"
        >
          暂无已归档{{ label }}
        </p>
        <ul
          v-if="rows.length"
          :aria-label="`已归档${label}列表`"
          :aria-busy="state.archivesLoading"
          class="space-y-1"
        >
          <li
            v-for="item in rows"
            :key="itemKey(item)"
            class="min-w-0 rounded-xl border bg-card px-3 py-3"
          >
            <div class="flex min-w-0 items-center gap-3">
              <div class="min-w-0 flex-1">
                <p class="break-words text-sm [overflow-wrap:anywhere]">{{ itemName(item) }}</p>
                <p class="mt-1 break-all text-xs text-muted-foreground">
                  {{ itemDescription(item) }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="rounded-[10px]"
                  :disabled="disabled"
                  :aria-label="`取消归档${itemName(item)}`"
                  @click="unarchive(item, $event)"
                  >取消归档</Button
                >
                <Button
                  v-if="'title' in item"
                  type="button"
                  variant="outline"
                  size="sm"
                  class="rounded-[10px] border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive focus-visible:ring-destructive/20 dark:border-destructive dark:hover:bg-destructive/15"
                  :disabled="disabled"
                  :aria-label="`删除${item.title}`"
                  :aria-expanded="pendingDeletion?.id === item.id"
                  @click="requestDeletion(item, $event)"
                  >删除</Button
                >
              </div>
            </div>
            <div
              v-if="pendingDeletion?.id === item.id"
              class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
            >
              <p class="text-xs leading-5 text-muted-foreground">
                删除后会话将从列表移除，并清除本窗口中的对应草稿。
              </p>
              <div class="ml-auto flex items-center gap-2">
                <Button
                  :id="`archive-delete-cancel-${item.id}`"
                  type="button"
                  variant="ghost"
                  size="sm"
                  :disabled="updating"
                  @click="cancelDeletion"
                  >取消</Button
                >
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  :disabled="disabled"
                  @click="confirmDeletion"
                  >{{ updating ? '正在删除…' : '确认删除' }}</Button
                >
              </div>
              <p
                v-if="deleteError"
                role="alert"
                class="w-full break-words text-sm text-destructive"
              >
                {{ deleteError }}
              </p>
            </div>
          </li>
        </ul>
        <Button
          v-if="state.archivesHasMore"
          type="button"
          variant="ghost"
          size="sm"
          class="mt-3 w-full"
          :disabled="state.archivesLoading || disabled"
          @click="loadArchives(true)"
          >{{ state.archivesLoading ? '正在加载…' : `加载更多${label}` }}</Button
        >
      </TabsContent>
    </TabsRoot>
  </section>
</template>
