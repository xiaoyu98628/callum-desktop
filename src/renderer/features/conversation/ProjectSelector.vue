<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon, SearchIcon } from '@lucide/vue'
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
  ComboboxRoot,
  ComboboxInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxEmpty,
} from 'reka-ui'
import type { WorkspaceInput } from '@shared/chat'
import { Button } from '@/components/ui/button'
import CreateProjectDialog from '@/components/layout/CreateProjectDialog.vue'
import { useConversations } from './useConversations'

const { state, workspace, selectDraftProject, refreshWorkspaces, createWorkspace } =
  useConversations()
const open = ref(false)
const search = ref('')
const trigger = ref<InstanceType<typeof Button> | null>(null)
const creatingProject = ref(false)
const creationError = ref('')
let disposed = false
const blocked = computed(
  () =>
    !!state.selectedId || state.loading || state.sending || state.managing || !!state.serviceError,
)
const label = computed(() => workspace.value?.name ?? (state.workspaceId ? '项目' : '选择项目'))

function select(value: unknown): void {
  if (blocked.value || typeof value !== 'string') return
  if (selectDraftProject(value === 'unbound' ? null : value)) open.value = false
}
function addProject(): void {
  if (blocked.value) return
  creationError.value = ''
  creatingProject.value = true
  open.value = false
}
async function createProject(input: WorkspaceInput): Promise<void> {
  if (blocked.value) return
  const previousProject = state.workspaceId
  creationError.value = ''
  try {
    const project = await createWorkspace(input)
    if (!disposed && !state.selectedId && state.workspaceId === previousProject) {
      selectDraftProject(project.id)
      creatingProject.value = false
    }
  } catch (error) {
    if (!disposed)
      creationError.value = error instanceof Error ? error.message : '无法创建项目，请重试。'
  }
}
watch(open, (value) => {
  if (value) search.value = ''
})
watch(blocked, (value) => {
  if (value) open.value = false
})
watch([() => state.selectedId, () => state.workspaceId], () => {
  open.value = false
  creatingProject.value = false
})
onScopeDispose(() => {
  disposed = true
})
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        ref="trigger"
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 min-w-0 max-w-[60%] gap-1.5 rounded-full px-2 text-xs font-normal"
        :class="state.workspaceId ? 'text-foreground' : 'text-muted-foreground'"
        :title="workspace?.rootPath"
        :disabled="blocked"
        aria-label="选择项目"
      >
        <FolderIcon class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ label }}</span>
        <ChevronDownIcon class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="top"
        align="start"
        :side-offset="8"
        :collision-padding="12"
        class="z-40 flex max-h-[min(24rem,var(--reka-popover-content-available-height))] w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border bg-card p-1 text-card-foreground shadow-lg"
        aria-label="选择项目"
        @close-auto-focus="creatingProject && $event.preventDefault()"
      >
        <ComboboxRoot
          :open="true"
          :model-value="state.workspaceId ?? 'unbound'"
          :reset-search-term-on-blur="false"
          :reset-search-term-on-select="false"
          class="flex min-h-0 flex-1 flex-col"
          @update:model-value="select"
          @update:open="!$event && (open = false)"
        >
          <div class="mx-2 flex shrink-0 items-center gap-2 border-b px-1">
            <SearchIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <ComboboxInput
              v-model="search"
              :display-value="() => ''"
              aria-label="搜索项目"
              placeholder="搜索项目"
              autocomplete="off"
              class="h-9 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <ComboboxContent class="min-h-0 overflow-y-auto py-1" aria-label="项目列表">
            <ComboboxItem
              v-for="project in state.workspaces"
              :key="project.id"
              :value="project.id"
              :text-value="project.name"
              :title="project.rootPath"
              class="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs outline-none data-[highlighted]:bg-accent data-[state=checked]:bg-muted/70"
            >
              <FolderIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
              <ComboboxItemIndicator><CheckIcon class="size-3.5" /></ComboboxItemIndicator>
            </ComboboxItem>
            <ComboboxItem
              value="unbound"
              text-value="不选择项目"
              class="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted-foreground outline-none data-[highlighted]:bg-accent"
            >
              <span class="min-w-0 flex-1">不选择项目</span>
              <ComboboxItemIndicator><CheckIcon class="size-3.5" /></ComboboxItemIndicator>
            </ComboboxItem>
            <ComboboxEmpty class="px-3 py-4 text-xs text-muted-foreground">
              {{ state.workspacesLoading ? '正在加载项目…' : '没有匹配的项目' }}
            </ComboboxEmpty>
          </ComboboxContent>
          <div class="shrink-0 space-y-1 border-t pt-1">
            <p v-if="state.workspacesError" role="alert" class="px-2 py-1 text-xs text-destructive">
              {{ state.workspacesError }}
            </p>
            <Button
              v-if="state.workspacesError || state.workspacesHasMore"
              type="button"
              variant="ghost"
              size="sm"
              class="w-full justify-start text-xs font-normal"
              :disabled="state.workspacesLoading"
              @click="refreshWorkspaces(!state.workspacesError)"
              >{{
                state.workspacesLoading
                  ? '正在加载项目…'
                  : state.workspacesError
                    ? '重新加载项目'
                    : search
                      ? '加载更多项目以继续搜索'
                      : '加载更多项目'
              }}</Button
            >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="w-full justify-start gap-2 text-xs font-normal text-muted-foreground"
              :disabled="blocked"
              @click="addProject"
              ><PlusIcon class="size-3.5" aria-hidden="true" />新建项目</Button
            >
          </div>
        </ComboboxRoot>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
  <CreateProjectDialog
    v-if="creatingProject"
    :busy="state.managing"
    :error="creationError"
    :return-focus="trigger?.$el ?? null"
    @close="creatingProject = false"
    @create="createProject"
  />
</template>
