<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'
import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
} from '@lucide/vue'
import type { AppInfo } from '@shared/desktop-api'
import type { Conversation, Workspace, WorkspaceInput, WorkspaceChange } from '@shared/chat'
import type { AppPage } from '@/app/navigation'
import { Button } from '@/components/ui/button'
import { useConversations } from '@/features/conversation/useConversations'
import ConversationList from './ConversationList.vue'
import SidebarHoverCard from './SidebarHoverCard.vue'
import SidebarItemMenu from './SidebarItemMenu.vue'
import SidebarManagementDialog from './SidebarManagementDialog.vue'
import type { ManagementTarget } from './SidebarManagementDialog.vue'
import CreateProjectDialog from './CreateProjectDialog.vue'
import ArchivedItemsDialog from './ArchivedItemsDialog.vue'

const props = defineProps<{
  collapsed: boolean
  activePage: AppPage
  appInfo: AppInfo | null
  loading: boolean
}>()

const emit = defineEmits<{ navigate: [page: AppPage] }>()

const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as const
const {
  state,
  newConversation,
  openConversation,
  refreshOverview,
  refreshWorkspaces,
  toggleWorkspace,
  expandWorkspace,
  loadWorkspaceConversations,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  renameConversation,
  deleteConversation,
  setConversationPinned,
  setConversationArchived,
  setWorkspacePinned,
  setWorkspaceArchived,
  changeArchiveKind,
  openArchives,
  closeArchives,
  refreshArchives,
} = useConversations()
const managementTarget = ref<ManagementTarget | null>(null)
const managementReturnFocus = ref<HTMLElement | null>(null)
const managementError = ref('')
const creatingProject = ref(false)
const sidebarError = ref('')
const archivesReturnFocus = ref<HTMLElement | null>(null)
const restoreError = ref('')
const restoreNotice = ref('')
const restoringId = ref('')
const projectsOpen = ref(true)
const recentOpen = ref(true)
const scrollbarVisible = ref(false)
let scrollbarTimer: number | undefined
function trackSidebarScroll(): void {
  scrollbarVisible.value = true
  window.clearTimeout(scrollbarTimer)
  scrollbarTimer = window.setTimeout(() => {
    scrollbarVisible.value = false
  }, 700)
}
onScopeDispose(() => window.clearTimeout(scrollbarTimer))
let workspaceClick: { id: string; expanded: boolean } | null = null
function startConversation(workspaceId: string | null = null): void {
  if (workspaceId) expandWorkspace(workspaceId)
  newConversation(workspaceId)
  emit('navigate', 'conversation')
}
function selectConversation(conversationId: string): void {
  void openConversation(conversationId)
  emit('navigate', 'conversation')
}
function selectWorkspace(item: Workspace, event: MouseEvent): void {
  if (event.detail > 1) return
  if (props.collapsed) {
    startConversation(item.id)
    return
  }
  workspaceClick = { id: item.id, expanded: !!state.workspaceGroups[item.id]?.expanded }
  toggleWorkspace(item.id)
}
function editWorkspace(item: Workspace, event: MouseEvent): void {
  if (props.collapsed || state.managing || state.serviceError) return
  // 单击立即展开；双击编辑时恢复此前状态，不让编辑动作改变分组展示。
  if (
    workspaceClick?.id === item.id &&
    workspaceClick.expanded !== !!state.workspaceGroups[item.id]?.expanded
  )
    toggleWorkspace(item.id)
  workspaceClick = null
  manageWorkspace(
    item,
    false,
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
  )
}
function manageConversation(
  item: Conversation,
  deleting: boolean,
  trigger: HTMLElement | null,
): void {
  if (state.managing || state.serviceError) return
  managementReturnFocus.value = trigger
  managementError.value = ''
  managementTarget.value = {
    kind: 'conversation',
    id: item.id,
    name: item.title,
    rootPath: '',
    otherPaths: [],
    deleting,
  }
}
function manageWorkspace(item: Workspace, deleting: boolean, trigger: HTMLElement | null): void {
  if (state.managing || state.serviceError) return
  managementReturnFocus.value = trigger
  managementError.value = ''
  managementTarget.value = {
    kind: 'workspace',
    id: item.id,
    name: item.name,
    rootPath: item.rootPath,
    otherPaths: item.otherPaths,
    deleting,
  }
}
function removeWorkspace(): void {
  const target = managementTarget.value
  if (!target || target.kind !== 'workspace' || state.managing || state.serviceError) return
  managementError.value = ''
  managementTarget.value = { ...target, deleting: true }
}
function addWorkspace(): void {
  if (state.managing) return
  managementReturnFocus.value =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  managementError.value = ''
  creatingProject.value = true
}
async function createProject(input: WorkspaceInput, selectionId: string): Promise<void> {
  if (state.managing) return
  managementError.value = ''
  try {
    const workspace = await createWorkspace(input, selectionId)
    creatingProject.value = false
    startConversation(workspace.id)
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : '无法创建项目，请重试。'
  }
}
async function confirmManagement(
  name: string,
  folders?: Omit<WorkspaceChange, 'name'>,
  selectionId?: string,
): Promise<void> {
  const target = managementTarget.value
  if (!target || state.managing) return
  managementError.value = ''
  try {
    if (target.kind === 'conversation' && target.id) {
      if (target.deleting) await deleteConversation(target.id)
      else await renameConversation(target.id, name)
    } else if (target.id) {
      if (target.deleting) await deleteWorkspace(target.id)
      else await updateWorkspace(target.id, { name, ...folders }, selectionId)
    }
    managementTarget.value = null
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : '无法保存，请重试。'
  }
}
async function pinConversation(item: Conversation): Promise<void> {
  if (state.managing || state.serviceError) return
  sidebarError.value = ''
  try {
    await setConversationPinned(item.id, item.pinnedAt === null)
  } catch (error) {
    sidebarError.value = error instanceof Error ? error.message : '无法更新置顶状态，请重试。'
  }
}
async function archiveConversation(item: Conversation): Promise<void> {
  if (state.managing || state.serviceError) return
  const trigger = document.activeElement
  sidebarError.value = ''
  try {
    await setConversationArchived(item.id, true)
    if (document.activeElement === trigger || document.activeElement === document.body)
      document.getElementById('archived-conversations')?.focus()
  } catch (error) {
    sidebarError.value = error instanceof Error ? error.message : '无法归档会话，请重试。'
  }
}
function showArchives(event: MouseEvent): void {
  archivesReturnFocus.value =
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  restoreError.value = ''
  restoreNotice.value = ''
  openArchives()
}
function loadArchives(more: boolean): void {
  restoreError.value = ''
  restoreNotice.value = ''
  void refreshArchives(more)
}
function changeArchivesView(kind: 'conversations' | 'workspaces'): void {
  restoreError.value = ''
  restoreNotice.value = ''
  changeArchiveKind(kind)
}
async function pinWorkspace(item: Workspace): Promise<void> {
  if (state.managing || state.serviceError) return
  sidebarError.value = ''
  try {
    await setWorkspacePinned(item.id, item.pinnedAt === null)
  } catch (error) {
    sidebarError.value = error instanceof Error ? error.message : '无法更新项目置顶状态，请重试。'
  }
}
async function archiveWorkspace(item: Workspace): Promise<void> {
  if (state.managing || state.serviceError) return
  const trigger = document.activeElement
  sidebarError.value = ''
  try {
    await setWorkspaceArchived(item.id, true)
    if (document.activeElement === trigger || document.activeElement === document.body)
      document.getElementById('archived-conversations')?.focus()
  } catch (error) {
    sidebarError.value = error instanceof Error ? error.message : '无法归档项目，请重试。'
  }
}
async function restoreWorkspace(item: Workspace): Promise<void> {
  if (state.managing || state.serviceError || restoringId.value) return
  restoringId.value = `workspace:${item.id}`
  restoreError.value = ''
  restoreNotice.value = ''
  try {
    await setWorkspaceArchived(item.id, false)
    if (state.archivesOpen) {
      restoreNotice.value = `已恢复项目“${item.name}”`
      document.getElementById('archived-items-title')?.focus()
    }
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : '无法恢复项目，请重试。'
  } finally {
    restoringId.value = ''
  }
}
async function restoreConversation(item: Conversation): Promise<void> {
  if (state.managing || state.serviceError || restoringId.value) return
  restoringId.value = item.id
  restoreError.value = ''
  restoreNotice.value = ''
  try {
    await setConversationArchived(item.id, false)
    if (state.archivesOpen) {
      restoreNotice.value = `已恢复“${item.title}”`
      document.getElementById('archived-items-title')?.focus()
    }
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : '无法恢复会话，请重试。'
  } finally {
    restoringId.value = ''
  }
}
</script>

<template>
  <aside
    id="app-sidebar"
    class="flex min-h-0 shrink-0 flex-col border-r bg-sidebar px-3 py-6 transition-[width] duration-200"
    :class="collapsed ? 'w-18' : 'w-60'"
    aria-label="主导航"
  >
    <div
      class="mb-7 flex shrink-0 items-center gap-3"
      :class="collapsed ? 'justify-center' : 'px-2'"
    >
      <div
        class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
      >
        <SparklesIcon class="size-5" aria-hidden="true" />
      </div>
      <p v-if="!collapsed" class="text-base font-semibold tracking-tight">Callum</p>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col" aria-label="工作内容">
      <Button
        id="new-conversation"
        variant="outline"
        class="w-full shrink-0 gap-3 rounded-xl bg-card font-medium"
        :class="collapsed ? 'px-0' : 'justify-start px-3'"
        :aria-current="activePage === 'conversation' && !state.selectedId ? 'page' : undefined"
        :title="collapsed ? '新对话' : undefined"
        @click="startConversation()"
      >
        <SquarePenIcon class="size-4 shrink-0" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : ''">新对话</span>
      </Button>

      <div
        data-sidebar-scroll
        :data-scrolling="scrollbarVisible ? '' : undefined"
        class="mt-7 min-h-0 flex-1 space-y-7 overflow-y-auto"
        @scroll="trackSidebarScroll"
      >
        <p v-if="sidebarError" role="alert" class="break-words px-3 text-xs text-destructive">
          {{ sidebarError }}
        </p>
        <section aria-labelledby="workspace-heading">
          <div class="mb-2 flex h-7 items-center gap-1" :class="collapsed ? '' : 'px-2'">
            <h2 class="min-w-0 flex-1">
              <Button
                id="workspace-heading"
                type="button"
                variant="ghost"
                size="icon"
                class="h-7 w-full gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
                :class="collapsed ? 'justify-center' : 'justify-start'"
                :aria-expanded="projectsOpen"
                aria-controls="workspace-list"
                :title="collapsed ? '项目' : undefined"
                @click="projectsOpen = !projectsOpen"
              >
                <FolderIcon v-if="collapsed" class="size-3.5" aria-hidden="true" />
                <span :class="collapsed ? 'sr-only' : ''">项目</span>
                <ChevronRightIcon
                  v-if="!collapsed"
                  class="sidebar-chevron ml-auto size-3.5"
                  :class="{ 'rotate-90': projectsOpen }"
                  aria-hidden="true"
                />
              </Button>
            </h2>
            <span v-if="!collapsed" class="ml-auto">
              <Button
                id="add-workspace"
                variant="ghost"
                size="icon"
                class="size-6 text-muted-foreground"
                :disabled="state.managing || !!state.serviceError"
                aria-label="添加项目"
                @click="addWorkspace"
              >
                <PlusIcon class="size-3.5" aria-hidden="true" />
              </Button>
            </span>
          </div>
          <div
            id="workspace-list"
            class="sidebar-disclosure"
            :data-open="projectsOpen ? '' : undefined"
            :aria-hidden="!projectsOpen || undefined"
            :inert="!projectsOpen"
          >
            <div class="sidebar-disclosure-clip">
              <p
                v-if="state.workspacesLoading && !state.workspaces.length"
                class="px-3 text-xs text-muted-foreground"
                :class="collapsed ? 'sr-only' : ''"
              >
                正在加载项目…
              </p>
              <p
                v-else-if="!state.workspaces.length && !state.workspacesError"
                class="px-3 text-xs leading-6 text-muted-foreground/80"
                :class="collapsed ? 'sr-only' : ''"
              >
                暂无项目
              </p>
              <div
                v-if="state.workspacesError"
                class="px-3 text-xs"
                :class="collapsed ? 'sr-only' : ''"
              >
                <p role="alert" class="break-words text-destructive">
                  {{ state.workspacesError }}
                </p>
                <Button
                  v-if="state.workspacesError"
                  variant="link"
                  size="sm"
                  :disabled="state.workspacesLoading"
                  @click="refreshWorkspaces()"
                  >重新加载项目</Button
                >
              </div>
              <section
                v-for="workspace in state.workspaces"
                :key="workspace.id"
                :aria-label="workspace.name"
                class="mb-0.5"
              >
                <div
                  class="group relative flex min-w-0 items-center rounded-lg has-[[data-state=open]]:bg-secondary"
                  :class="
                    state.workspaceId === workspace.id &&
                    activePage === 'conversation' &&
                    !state.selectedId
                      ? 'bg-secondary'
                      : 'hover:bg-accent/70'
                  "
                >
                  <SidebarHoverCard
                    v-slot="{ triggerEvents }"
                    :item="workspace"
                    :home-directory="appInfo?.homeDirectory ?? ''"
                    :disabled="state.managing || !!state.serviceError"
                    :suspended="
                      !!managementTarget || creatingProject || state.archivesOpen || !projectsOpen
                    "
                    @pin="pinWorkspace(workspace)"
                    @edit="manageWorkspace(workspace, false, $event)"
                  >
                    <Button
                      variant="ghost"
                      class="h-7 min-w-0 flex-1 justify-start gap-2 py-1 text-[13px] font-normal hover:bg-transparent"
                      :class="collapsed ? 'justify-center px-0' : 'pl-3 pr-16 has-[>svg]:pr-16'"
                      :aria-expanded="
                        collapsed ? undefined : !!state.workspaceGroups[workspace.id]?.expanded
                      "
                      :aria-controls="
                        collapsed ? undefined : `workspace-conversations-${workspace.id}`
                      "
                      aria-keyshortcuts="ArrowRight"
                      v-on="triggerEvents"
                      @click="selectWorkspace(workspace, $event)"
                      @dblclick="editWorkspace(workspace, $event)"
                    >
                      <FolderOpenIcon
                        v-if="!collapsed && state.workspaceGroups[workspace.id]?.expanded"
                        class="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <FolderIcon
                        v-else
                        class="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span :class="collapsed ? 'sr-only' : 'truncate'">{{ workspace.name }}</span>
                    </Button>
                  </SidebarHoverCard>
                  <div v-if="!collapsed" class="absolute right-3 flex items-center">
                    <SidebarItemMenu
                      :label="workspace.name"
                      workspace
                      :pinned="workspace.pinnedAt !== null"
                      :disabled="state.managing || !!state.serviceError"
                      @rename="manageWorkspace(workspace, false, $event)"
                      @delete="manageWorkspace(workspace, true, $event)"
                      @pin="pinWorkspace(workspace)"
                      @archive="archiveWorkspace(workspace)"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      class="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-has-[[data-state=open]]:opacity-100"
                      :aria-label="`在${workspace.name}中新建对话`"
                      title="新建对话"
                      :disabled="state.managing || !!state.serviceError"
                      @click="startConversation(workspace.id)"
                    >
                      <SquarePenIcon class="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div
                  v-if="!collapsed"
                  :id="`workspace-conversations-${workspace.id}`"
                  class="sidebar-disclosure"
                  :data-open="state.workspaceGroups[workspace.id]?.expanded ? '' : undefined"
                  :aria-hidden="!state.workspaceGroups[workspace.id]?.expanded || undefined"
                  :inert="!state.workspaceGroups[workspace.id]?.expanded"
                >
                  <div class="sidebar-disclosure-clip">
                    <div v-if="state.workspaceGroups[workspace.id]" class="ml-6 pt-0.5">
                      <ConversationList
                        :items="state.workspaceGroups[workspace.id]?.items ?? []"
                        :workspace-name="workspace.name"
                        :preview-suspended="
                          !!managementTarget ||
                          creatingProject ||
                          state.archivesOpen ||
                          !projectsOpen ||
                          !state.workspaceGroups[workspace.id]?.expanded
                        "
                        :selected-id="state.selectedId"
                        :active="activePage === 'conversation'"
                        :collapsed="false"
                        :disabled="state.managing || !!state.serviceError"
                        @select="selectConversation"
                        @rename="(item, trigger) => manageConversation(item, false, trigger)"
                        @delete="(item, trigger) => manageConversation(item, true, trigger)"
                        @pin="pinConversation"
                        @archive="archiveConversation"
                      />
                      <p
                        v-if="state.workspaceGroups[workspace.id]?.loading"
                        class="px-3 py-2 text-xs text-muted-foreground"
                      >
                        正在加载对话…
                      </p>
                      <div
                        v-else-if="state.workspaceGroups[workspace.id]?.error"
                        class="px-3 text-xs"
                      >
                        <p role="alert" class="break-words text-destructive">
                          {{ state.workspaceGroups[workspace.id]?.error }}
                        </p>
                        <Button
                          variant="link"
                          size="sm"
                          @click="loadWorkspaceConversations(workspace.id)"
                          >重新加载</Button
                        >
                      </div>
                      <p
                        v-else-if="!state.workspaceGroups[workspace.id]?.items.length"
                        class="px-3 py-1 text-[13px] leading-6 text-muted-foreground/60"
                      >
                        暂无聊天
                      </p>
                      <Button
                        v-if="state.workspaceGroups[workspace.id]?.hasMore"
                        variant="ghost"
                        size="sm"
                        class="w-full text-xs text-muted-foreground"
                        :disabled="state.workspaceGroups[workspace.id]?.loading"
                        @click="loadWorkspaceConversations(workspace.id, true)"
                        >加载更多对话</Button
                      >
                    </div>
                  </div>
                </div>
              </section>
              <Button
                v-if="state.workspacesHasMore && !collapsed"
                variant="ghost"
                size="sm"
                class="w-full text-xs text-muted-foreground"
                :disabled="state.workspacesLoading"
                @click="refreshWorkspaces(true)"
                >加载更多项目</Button
              >
            </div>
          </div>
        </section>

        <section aria-labelledby="conversations-heading">
          <div
            class="group/recent mb-2 flex h-7 items-center gap-1"
            :class="collapsed ? '' : 'px-2'"
          >
            <h2 class="min-w-0 flex-1">
              <Button
                id="conversations-heading"
                type="button"
                variant="ghost"
                size="icon"
                class="h-7 w-full gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
                :class="collapsed ? 'justify-center' : 'justify-start'"
                :aria-expanded="recentOpen"
                aria-controls="recent-conversations"
                :title="collapsed ? '最近' : undefined"
                @click="recentOpen = !recentOpen"
              >
                <MessageSquareIcon v-if="collapsed" class="size-3.5" aria-hidden="true" />
                <span :class="collapsed ? 'sr-only' : ''">最近</span>
                <ChevronRightIcon
                  v-if="!collapsed"
                  class="sidebar-chevron ml-auto size-3.5"
                  :class="{ 'rotate-90': recentOpen }"
                  aria-hidden="true"
                />
              </Button>
            </h2>
            <Button
              v-if="!collapsed"
              type="button"
              variant="ghost"
              size="icon"
              class="ml-auto size-6 text-muted-foreground opacity-0 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100"
              aria-label="最近中新建对话"
              title="新建对话"
              @click="startConversation()"
            >
              <SquarePenIcon class="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          <div
            id="recent-conversations"
            class="sidebar-disclosure"
            :data-open="recentOpen ? '' : undefined"
            :aria-hidden="!recentOpen || undefined"
            :inert="!recentOpen"
          >
            <div class="sidebar-disclosure-clip">
              <p
                v-if="state.loadingList && !state.conversations.length"
                class="px-3 text-xs text-muted-foreground"
                :class="collapsed ? 'sr-only' : ''"
              >
                正在加载对话…
              </p>
              <p
                v-else-if="!state.conversations.length && !state.serviceError"
                class="px-3 text-xs leading-6 text-muted-foreground/80"
                :class="collapsed ? 'sr-only' : ''"
              >
                暂无对话
              </p>
              <ConversationList
                :items="state.conversations"
                :preview-suspended="
                  !!managementTarget || creatingProject || state.archivesOpen || !recentOpen
                "
                :selected-id="state.selectedId"
                :active="activePage === 'conversation'"
                :collapsed="collapsed"
                :disabled="state.managing || !!state.serviceError"
                @select="selectConversation"
                @rename="(item, trigger) => manageConversation(item, false, trigger)"
                @delete="(item, trigger) => manageConversation(item, true, trigger)"
                @pin="pinConversation"
                @archive="archiveConversation"
              />
              <Button
                v-if="state.hasMore && !collapsed"
                variant="ghost"
                size="sm"
                class="mt-2 w-full text-xs text-muted-foreground"
                :disabled="state.loadingList"
                @click="refreshOverview(true)"
                >加载更多对话</Button
              >
            </div>
          </div>
        </section>
      </div>
    </nav>

    <div class="mt-5 shrink-0 space-y-4">
      <Button
        id="archived-conversations"
        variant="ghost"
        class="w-full gap-3 rounded-lg"
        :class="collapsed ? 'px-0' : 'justify-start px-3'"
        :title="collapsed ? '已归档' : undefined"
        :disabled="state.managing"
        @click="showArchives"
      >
        <ArchiveIcon class="size-4 shrink-0" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : ''">已归档</span>
      </Button>
      <Button
        :variant="activePage === 'settings' ? 'secondary' : 'ghost'"
        class="w-full gap-3 rounded-lg"
        :class="collapsed ? 'px-0' : 'justify-start px-3'"
        :aria-current="activePage === 'settings' ? 'page' : undefined"
        :title="collapsed ? '设置' : undefined"
        @click="$emit('navigate', 'settings')"
      >
        <Settings2Icon class="size-4 shrink-0" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : ''">设置</span>
      </Button>
      <div
        v-if="!collapsed"
        class="flex items-center justify-between border-t px-2 pt-4 text-[10px] text-muted-foreground"
      >
        <span>{{
          appInfo ? `v${appInfo.version}` : loading ? '读取应用信息…' : '版本信息不可用'
        }}</span>
        <span v-if="appInfo">{{ platformNames[appInfo.platform] }}</span>
      </div>
    </div>
  </aside>
  <ArchivedItemsDialog
    v-if="state.archivesOpen"
    :items="state.archivedConversations"
    :projects="state.archivedWorkspaces"
    :view="state.archiveKind"
    :workspaces="state.workspaces"
    :loading="state.archivesLoading"
    :has-more="state.archivesHasMore"
    :busy="state.managing || !!restoringId"
    :disabled="state.managing || !!state.serviceError || !!restoringId"
    :restoring-id="restoringId"
    :error="restoreError || state.archivesError || state.serviceError"
    :notice="restoreNotice"
    :return-focus="archivesReturnFocus"
    @close="closeArchives"
    @load="loadArchives"
    @restore="restoreConversation"
    @restore-workspace="restoreWorkspace"
    @view="changeArchivesView"
  />
  <CreateProjectDialog
    v-if="creatingProject"
    :busy="state.managing"
    :error="managementError"
    :return-focus="managementReturnFocus"
    @close="creatingProject = false"
    @create="createProject"
  />
  <SidebarManagementDialog
    v-if="managementTarget"
    :target="managementTarget"
    :busy="state.managing"
    :error="managementError"
    :return-focus="managementReturnFocus"
    @close="managementTarget = null"
    @confirm="confirmManagement"
    @remove="removeWorkspace"
  />
</template>

<style scoped>
@property --sidebar-scrollbar-thumb {
  syntax: '<color>';
  inherits: true;
  initial-value: transparent;
}

[data-sidebar-scroll] {
  transition: --sidebar-scrollbar-thumb 180ms ease-out;
}

[data-sidebar-scroll][data-scrolling] {
  --sidebar-scrollbar-thumb: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
  transition-duration: 0ms;
}

[data-sidebar-scroll]::-webkit-scrollbar {
  width: 6px;
  background: transparent;
}

[data-sidebar-scroll]::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background-color: var(--sidebar-scrollbar-thumb);
}

[data-sidebar-scroll]::-webkit-scrollbar-thumb:hover,
[data-sidebar-scroll]::-webkit-scrollbar-thumb:active {
  background-color: color-mix(in srgb, var(--muted-foreground) 75%, transparent);
}

.sidebar-disclosure {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  visibility: hidden;
  transition:
    grid-template-rows 220ms ease,
    opacity 160ms ease,
    visibility 0s linear 220ms;
}

.sidebar-disclosure[data-open] {
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}

.sidebar-disclosure-clip {
  min-width: 0;
  min-height: 0;
  overflow: clip;
}

.sidebar-chevron {
  transition: rotate 220ms ease;
}
</style>
