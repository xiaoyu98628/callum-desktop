<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui'
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useConversations } from './useConversations'
import type { ExecutionSettings } from '@shared/execution'

const props = defineProps<{ returnFocus: HTMLElement | null }>()
const emit = defineEmits<{ close: [] }>()
const {
  state,
  workspace,
  loadDirectories,
  revokeDirectory,
  refreshExecutionSettings,
  saveExecutionSettings,
} = useConversations()
const conversationId = state.selectedId
const grants = computed(() => state.detail?.directoryGrants ?? [])
const execution = ref<ExecutionSettings | null>(null)
const executionLoading = ref(false),
  executionSaving = ref(false),
  executionError = ref(''),
  executionSaved = ref(false)
let disposed = false
const busy = computed(
  () => !!state.revokingDirectory || state.executionSettingsSaving || executionSaving.value,
)
const unavailable = computed(() => state.directoriesLoading || !!state.serviceError || busy.value)
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (props.returnFocus?.isConnected) props.returnFocus.focus()
  else document.getElementById('new-conversation')?.focus()
}
async function loadExecution(): Promise<void> {
  if (executionLoading.value || executionSaving.value) return
  executionLoading.value = true
  executionError.value = ''
  executionSaved.value = false
  try {
    const result = await refreshExecutionSettings()
    if (!result) throw new Error(state.executionSettingsError || '执行权限正在读取，请重试。')
    if (!disposed) execution.value = { ...result }
  } catch (error) {
    if (!disposed)
      executionError.value = error instanceof Error ? error.message : '无法读取执行权限，请重试。'
  } finally {
    if (!disposed) executionLoading.value = false
  }
}
async function saveExecution(): Promise<void> {
  if (
    !execution.value ||
    executionLoading.value ||
    busy.value ||
    state.serviceError ||
    executionError.value
  )
    return
  executionSaving.value = true
  executionError.value = ''
  executionSaved.value = false
  try {
    const result = await saveExecutionSettings({ ...execution.value })
    if (!disposed) {
      execution.value = { ...result }
      executionSaved.value = true
    }
  } catch (error) {
    if (!disposed)
      executionError.value =
        error instanceof Error ? error.message : '无法保存执行权限，请重新读取后核对。'
  } finally {
    if (!disposed) executionSaving.value = false
  }
}
function changeSandbox(): void {
  if (
    execution.value?.sandboxMode !== 'danger-full-access' &&
    state.executionSettings?.sandboxMode === 'danger-full-access' &&
    execution.value
  )
    execution.value.approvalPolicy = 'on-request'
  executionSaved.value = false
}
function changePolicy(): void {
  if (execution.value?.approvalPolicy === 'never') execution.value.approvalsReviewer = 'user'
  executionSaved.value = false
}
watch(
  () => state.selectedId,
  (id) => {
    if (id !== conversationId) emit('close')
  },
)
onMounted(() => {
  void loadDirectories(0)
  void loadExecution()
})
onScopeDispose(() => {
  disposed = true
})
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-6 shadow-xl"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
        @close-auto-focus="restoreFocus"
      >
        <DialogTitle class="pr-8 text-base font-semibold">会话权限</DialogTitle>
        <DialogDescription class="mt-2 text-xs leading-6 text-muted-foreground">
          命令默认使用只读沙箱。允许项目写入时，命令仍需单次审批。下方设置影响所有会话的新任务，已受理任务保持原权限。额外目录授权仅关联当前会话。
        </DialogDescription>
        <Button
          variant="ghost"
          size="icon"
          class="absolute right-3 top-3 size-8"
          aria-label="关闭会话权限"
          :disabled="busy"
          @click="emit('close')"
        >
          <XIcon class="size-4" aria-hidden="true" />
        </Button>
        <div class="mt-4 space-y-4 text-xs leading-6">
          <section class="space-y-3 rounded-lg border p-3" aria-label="后续任务默认权限">
            <h3 class="font-medium">后续任务默认权限</h3>
            <p v-if="executionLoading" role="status" class="text-muted-foreground">
              正在读取执行权限…
            </p>
            <template v-if="execution">
              <label class="block"
                >访问范围
                <select
                  v-model="execution.sandboxMode"
                  aria-label="沙箱访问范围"
                  class="mt-1 block h-8 w-full rounded-md border bg-background px-2 text-xs"
                  :disabled="executionLoading || busy || !!state.serviceError || !!executionError"
                  @change="changeSandbox"
                >
                  <option
                    v-if="execution.sandboxMode === 'danger-full-access'"
                    value="danger-full-access"
                    disabled
                  >
                    完全访问权限
                  </option>
                  <option value="workspace-write">
                    项目写入：普通项目补丁可自动执行，命令写入需审批
                  </option>
                  <option value="read-only">只读：文件修改需审批，命令使用只读沙箱</option>
                </select>
              </label>
              <label class="block"
                >审批方式
                <select
                  v-model="execution.approvalPolicy"
                  aria-label="审批方式"
                  class="mt-1 block h-8 w-full rounded-md border bg-background px-2 text-xs"
                  :disabled="
                    execution.sandboxMode === 'danger-full-access' ||
                    executionLoading ||
                    busy ||
                    !!state.serviceError ||
                    !!executionError
                  "
                  @change="changePolicy"
                >
                  <option value="on-request">按需询问</option>
                  <option value="always">每次询问</option>
                  <option value="never">不询问：拒绝仍需审批的操作</option>
                </select>
              </label>
              <p v-if="execution.approvalsReviewer === 'auto_review'" class="text-muted-foreground">
                已开启帮我审批。超出 AI 审核范围的操作仍由你决定。
              </p>
              <p
                v-if="execution.sandboxMode === 'danger-full-access'"
                class="text-muted-foreground"
              >
                命令以当前系统用户权限访问文件和网络，审批关闭。
              </p>
              <p v-else class="text-muted-foreground">
                macOS
                命令及子进程使用系统沙箱。未关联项目时仅允许读取及私有临时目录写入；其他平台的命令仍需独立审批。模型请求不受命令网络限制影响。
              </p>
            </template>
            <p v-if="executionError" role="alert" class="break-words text-destructive">
              {{ executionError }}
            </p>
            <p v-if="executionSaved" role="status" class="text-muted-foreground">
              已保存，下一次发起任务时生效。
            </p>
            <div class="flex gap-2">
              <Button
                v-if="execution"
                variant="outline"
                size="sm"
                :disabled="executionLoading || busy || !!state.serviceError || !!executionError"
                @click="saveExecution"
                >{{ executionSaving ? '正在保存…' : '保存默认权限' }}</Button
              >
              <Button
                variant="ghost"
                size="sm"
                :disabled="executionLoading || busy || !!state.serviceError"
                @click="loadExecution"
                >重新读取权限</Button
              >
            </div>
          </section>
          <div v-if="state.workspaceId" class="rounded-lg bg-muted/50 p-3">
            <p class="font-medium">当前项目</p>
            <p class="break-all text-muted-foreground">
              {{
                workspace
                  ? workspace.rootPath || '未添加文件夹，请使用绝对路径'
                  : '项目详情尚未加载'
              }}
            </p>
          </div>
          <div>
            <h3 class="font-medium">额外目录授权</h3>
            <p class="mt-1 text-muted-foreground">
              写授权包含该目录及所有子目录的读取和普通修改，在本会话重启后保留。命令及其他需要独立审批的操作继续按规则判断。
            </p>
          </div>
          <p
            v-if="state.serviceError || state.directoriesError"
            role="alert"
            class="break-words text-destructive"
          >
            {{ state.serviceError || state.directoriesError }}
          </p>
          <p v-if="state.directoriesLoading" role="status" class="text-muted-foreground">
            正在读取目录授权…
          </p>
          <p
            v-else-if="!grants.length && !state.directoriesError && !state.serviceError"
            class="text-muted-foreground"
          >
            暂无额外目录授权。普通读取无需先添加授权。
          </p>
          <ul v-if="grants.length" class="space-y-2">
            <li v-for="grant in grants" :key="grant.id" class="rounded-lg border p-3">
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="break-all font-mono">{{ grant.scope.rootPath }}</p>
                  <p class="text-muted-foreground">
                    {{ grant.scope.access === 'read' ? '历史只读授权' : '读取和普通修改'
                    }}{{ grant.revokedAt === null ? '' : ' · 已撤销' }}
                  </p>
                  <p v-if="grant.scope.access === 'read'" class="text-muted-foreground">
                    默认只读策略已不依赖此授权，撤销它不会禁止普通读取。
                  </p>
                </div>
                <Button
                  v-if="grant.revokedAt === null"
                  variant="outline"
                  size="xs"
                  :disabled="unavailable"
                  @click="revokeDirectory(grant.id)"
                  >{{ state.revokingDirectory === grant.id ? '正在撤销…' : '撤销授权' }}</Button
                >
              </div>
            </li>
          </ul>
          <p class="text-muted-foreground">
            撤销后，依赖此目录写授权的后续操作会重新判断；已批准或开始的操作不会撤回。
          </p>
          <div class="flex flex-wrap gap-2 border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              :disabled="unavailable"
              @click="loadDirectories(state.directoriesOffset)"
              >刷新授权</Button
            >
            <Button
              v-if="state.directoriesOffset > 0"
              variant="ghost"
              size="sm"
              :disabled="unavailable"
              @click="loadDirectories(Math.max(0, state.directoriesOffset - 200))"
              >上一页授权</Button
            >
            <Button
              v-if="grants.length >= 200"
              variant="ghost"
              size="sm"
              :disabled="unavailable"
              @click="loadDirectories(state.directoriesOffset + 200)"
              >下一页授权</Button
            >
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
