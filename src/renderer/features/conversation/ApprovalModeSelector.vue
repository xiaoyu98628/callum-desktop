<script setup lang="ts">
import { computed, ref } from 'vue'
import { CheckIcon, ShieldCheckIcon, ShieldAlertIcon, ShieldIcon } from '@lucide/vue'
import {
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { approvalMode, withApprovalMode } from '@shared/execution'
import { useConversations } from './useConversations'

const { state, refreshExecutionSettings, saveExecutionSettings } = useConversations()
const modes = [
  { id: 'request', label: '请求批准', icon: ShieldIcon, description: '需要审批的操作由你决定。' },
  {
    id: 'assist',
    label: '帮我审批',
    icon: ShieldCheckIcon,
    description: 'AI 审核低风险操作，其余交给你。',
  },
  {
    id: 'full',
    label: '完全访问权限',
    icon: ShieldAlertIcon,
    description: '命令可按系统账户权限访问文件和网络，无需逐次审批。',
  },
] as const
const open = ref(false)
const current = computed(() =>
  state.executionSettings ? approvalMode(state.executionSettings) : null,
)
const selected = computed(() => modes.find((mode) => mode.id === current.value))
const rejectsRequests = computed(() => state.executionSettings !== null && current.value === null)
const blocked = computed(
  () =>
    state.executionSettingsSaving ||
    state.sending ||
    state.resending ||
    !!state.compacting ||
    !!state.serviceError,
)
async function setMode(value: unknown): Promise<void> {
  const settings = state.executionSettings
  const choice = modes.find((item) => item.id === value)?.id
  if (
    !choice ||
    !settings ||
    blocked.value ||
    state.executionSettingsLoading ||
    state.executionSettingsError
  )
    return
  const next = withApprovalMode(settings, choice)
  if (
    next.sandboxMode === settings.sandboxMode &&
    next.approvalPolicy === settings.approvalPolicy &&
    next.approvalsReviewer === settings.approvalsReviewer
  )
    return
  try {
    await saveExecutionSettings(next)
  } catch {
    // 由共享设置状态在入口旁显示错误，保留已确认的选择。
  }
}
function toggle(value: boolean): void {
  open.value = value
  if (value) void refreshExecutionSettings()
}
</script>

<template>
  <div class="min-w-0">
    <DropdownMenuRoot :open="open" @update:open="toggle">
      <DropdownMenuTrigger
        type="button"
        aria-label="审批模式"
        :disabled="blocked"
        :aria-busy="state.executionSettingsSaving"
        :title="rejectsRequests ? '高级权限设置拒绝需要审批的操作。' : selected?.description"
        class="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
        :class="current === 'full' ? 'text-destructive' : 'text-muted-foreground'"
      >
        <component
          :is="selected?.icon ?? ShieldIcon"
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span class="truncate">{{
          state.executionSettingsSaving
            ? '正在保存…'
            : (selected?.label ?? (rejectsRequests ? '不询问' : '审批模式'))
        }}</span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          side="top"
          align="start"
          :side-offset="8"
          :collision-padding="12"
          class="z-50 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-card p-1.5 text-card-foreground shadow-lg"
        >
          <DropdownMenuRadioGroup :model-value="current" @update:model-value="setMode">
            <DropdownMenuRadioItem
              v-for="mode in modes"
              :key="mode.id"
              :value="mode.id"
              :text-value="mode.label"
              :disabled="
                blocked ||
                state.executionSettingsLoading ||
                !!state.executionSettingsError ||
                !state.executionSettings
              "
              class="relative flex items-start gap-2 rounded-lg px-2 py-2 pr-7 text-xs outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
            >
              <component
                :is="mode.icon"
                class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span class="min-w-0">
                <span class="block font-medium">{{ mode.label }}</span>
                <span class="mt-0.5 block leading-4 text-muted-foreground">{{
                  mode.description
                }}</span>
              </span>
              <DropdownMenuItemIndicator class="absolute right-2 top-2.5"
                ><CheckIcon class="size-3.5" aria-hidden="true"
              /></DropdownMenuItemIndicator>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <p class="border-t px-2 pb-1 pt-2 text-[11px] leading-4 text-muted-foreground">
            用于所有后续任务，已受理任务沿用原设置。
          </p>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <p
      v-if="state.executionSettingsError && !state.serviceError"
      role="status"
      class="mt-1 break-words px-2 text-[11px] leading-4 text-destructive"
    >
      {{ state.executionSettingsError }} 再次打开菜单可重试。
    </p>
  </div>
</template>
