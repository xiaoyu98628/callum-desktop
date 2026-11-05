<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
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

const props = defineProps<{ returnFocus: HTMLElement | null }>()
const emit = defineEmits<{ close: [] }>()
const { state, workspace, loadDirectories, revokeDirectory } = useConversations()
const conversationId = state.selectedId
const grants = computed(() => state.detail?.directoryGrants ?? [])
const busy = computed(() => !!state.revokingDirectory)
const unavailable = computed(() => state.directoriesLoading || !!state.serviceError || busy.value)
function restoreFocus(event: Event): void {
  event.preventDefault()
  if (props.returnFocus?.isConnected) props.returnFocus.focus()
  else document.getElementById('new-conversation')?.focus()
}
watch(
  () => state.selectedId,
  (id) => {
    if (id !== conversationId) emit('close')
  },
)
onMounted(() => {
  void loadDirectories(0)
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
          权限仅关联当前会话。默认 on-request
          下，读取文件、查看目录和搜索无需逐次审批；写入按项目范围及目录授权判断。
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
          <div v-if="state.workspaceId" class="rounded-lg bg-muted/50 p-3">
            <p class="font-medium">当前项目</p>
            <p class="break-all text-muted-foreground">
              {{ workspace?.rootPath ?? '项目详情尚未加载' }}
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
