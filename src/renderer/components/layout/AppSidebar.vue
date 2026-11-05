<script setup lang="ts">
import { ref } from 'vue'
import {
  ChevronRightIcon,
  FolderIcon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
} from '@lucide/vue'
import type { AppInfo } from '@shared/desktop-api'
import type { Conversation, Workspace, WorkspaceInput } from '@shared/chat'
import type { AppPage } from '@/app/navigation'
import { Button } from '@/components/ui/button'
import { useConversations } from '@/features/conversation/useConversations'
import ConversationList from './ConversationList.vue'
import SidebarItemMenu from './SidebarItemMenu.vue'
import SidebarManagementDialog from './SidebarManagementDialog.vue'
import type { ManagementTarget } from './SidebarManagementDialog.vue'
import CreateProjectDialog from './CreateProjectDialog.vue'

defineProps<{
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
  renameWorkspace,
  deleteWorkspace,
  renameConversation,
  deleteConversation,
} = useConversations()
const managementTarget = ref<ManagementTarget | null>(null)
const managementReturnFocus = ref<HTMLElement | null>(null)
const managementError = ref('')
const creatingProject = ref(false)
function startConversation(workspaceId: string | null = null): void {
  if (workspaceId) expandWorkspace(workspaceId)
  newConversation(workspaceId)
  emit('navigate', 'conversation')
}
function selectConversation(conversationId: string): void {
  void openConversation(conversationId)
  emit('navigate', 'conversation')
}
function manageConversation(
  item: Conversation,
  deleting: boolean,
  trigger: HTMLElement | null,
): void {
  managementReturnFocus.value = trigger
  managementError.value = ''
  managementTarget.value = {
    kind: 'conversation',
    id: item.id,
    name: item.title,
    rootPath: '',
    deleting,
  }
}
function manageWorkspace(item: Workspace, deleting: boolean, trigger: HTMLElement | null): void {
  managementReturnFocus.value = trigger
  managementError.value = ''
  managementTarget.value = {
    kind: 'workspace',
    id: item.id,
    name: item.name,
    rootPath: item.rootPath,
    deleting,
  }
}
function addWorkspace(): void {
  if (state.managing) return
  managementReturnFocus.value =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  managementError.value = ''
  creatingProject.value = true
}
async function createProject(input: WorkspaceInput): Promise<void> {
  if (state.managing) return
  managementError.value = ''
  try {
    const workspace = await createWorkspace(input)
    creatingProject.value = false
    startConversation(workspace.id)
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : '无法创建项目，请重试。'
  }
}
async function confirmManagement(name: string): Promise<void> {
  const target = managementTarget.value
  if (!target || state.managing) return
  managementError.value = ''
  try {
    if (target.kind === 'conversation' && target.id) {
      if (target.deleting) await deleteConversation(target.id)
      else await renameConversation(target.id, name)
    } else if (target.id) {
      if (target.deleting) await deleteWorkspace(target.id)
      else await renameWorkspace(target.id, name)
    }
    managementTarget.value = null
  } catch (error) {
    managementError.value = error instanceof Error ? error.message : '无法保存，请重试。'
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

      <div class="mt-7 min-h-0 flex-1 space-y-7 overflow-y-auto">
        <section aria-labelledby="workspace-heading">
          <div
            class="mb-2 flex h-7 items-center"
            :class="collapsed ? 'justify-center' : 'gap-2 px-3'"
          >
            <FolderIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h2
              id="workspace-heading"
              class="text-xs font-medium text-muted-foreground"
              :class="collapsed ? 'sr-only' : ''"
            >
              项目
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
            class="mb-1"
          >
            <div
              class="group flex min-w-0 items-center rounded-lg"
              :class="
                state.workspaceId === workspace.id &&
                activePage === 'conversation' &&
                !state.selectedId
                  ? 'bg-secondary'
                  : 'hover:bg-accent/70'
              "
            >
              <Button
                variant="ghost"
                class="min-w-0 flex-1 justify-start gap-2 text-xs hover:bg-transparent"
                :class="collapsed ? 'justify-center px-0' : 'px-3'"
                :title="workspace.name"
                :aria-expanded="
                  collapsed ? undefined : !!state.workspaceGroups[workspace.id]?.expanded
                "
                @click="collapsed ? startConversation(workspace.id) : toggleWorkspace(workspace.id)"
              >
                <FolderIcon v-if="collapsed" class="size-3.5" aria-hidden="true" />
                <ChevronRightIcon
                  v-else
                  class="size-3.5 shrink-0 text-muted-foreground transition-transform"
                  :class="state.workspaceGroups[workspace.id]?.expanded ? 'rotate-90' : ''"
                  aria-hidden="true"
                />
                <span :class="collapsed ? 'sr-only' : 'truncate'">{{ workspace.name }}</span>
              </Button>
              <SidebarItemMenu
                v-if="!collapsed"
                :label="workspace.name"
                workspace
                :disabled="state.managing || !!state.serviceError"
                @rename="manageWorkspace(workspace, false, $event)"
                @delete="manageWorkspace(workspace, true, $event)"
                @new-conversation="startConversation(workspace.id)"
              />
            </div>
            <div
              v-if="!collapsed && state.workspaceGroups[workspace.id]?.expanded"
              class="ml-4 mt-1 border-l pl-1"
            >
              <ConversationList
                :items="state.workspaceGroups[workspace.id]?.items ?? []"
                :selected-id="state.selectedId"
                :active="activePage === 'conversation'"
                :collapsed="false"
                :disabled="state.managing || !!state.serviceError"
                @select="selectConversation"
                @rename="(item, trigger) => manageConversation(item, false, trigger)"
                @delete="(item, trigger) => manageConversation(item, true, trigger)"
              />
              <p
                v-if="state.workspaceGroups[workspace.id]?.loading"
                class="px-3 py-2 text-xs text-muted-foreground"
              >
                正在加载对话…
              </p>
              <div v-else-if="state.workspaceGroups[workspace.id]?.error" class="px-3 text-xs">
                <p role="alert" class="break-words text-destructive">
                  {{ state.workspaceGroups[workspace.id]?.error }}
                </p>
                <Button variant="link" size="sm" @click="loadWorkspaceConversations(workspace.id)"
                  >重新加载</Button
                >
              </div>
              <Button
                v-else-if="!state.workspaceGroups[workspace.id]?.items.length"
                variant="ghost"
                size="sm"
                class="w-full justify-start px-3 text-xs text-muted-foreground"
                @click="startConversation(workspace.id)"
                ><PlusIcon class="size-3.5" aria-hidden="true" />新建对话</Button
              >
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
        </section>

        <section aria-labelledby="conversations-heading">
          <div
            class="mb-2 flex h-7 items-center"
            :class="collapsed ? 'justify-center' : 'gap-2 px-3'"
          >
            <MessageSquareIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h2
              id="conversations-heading"
              class="text-xs font-medium text-muted-foreground"
              :class="collapsed ? 'sr-only' : ''"
            >
              对话
            </h2>
          </div>
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
            :selected-id="state.selectedId"
            :active="activePage === 'conversation'"
            :collapsed="collapsed"
            :disabled="state.managing || !!state.serviceError"
            @select="selectConversation"
            @rename="(item, trigger) => manageConversation(item, false, trigger)"
            @delete="(item, trigger) => manageConversation(item, true, trigger)"
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
        </section>
      </div>
    </nav>

    <div class="mt-5 shrink-0 space-y-4">
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
  />
</template>
