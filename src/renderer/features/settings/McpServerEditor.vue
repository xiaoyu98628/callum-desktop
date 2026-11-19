<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { McpRequest, McpServerView } from '@shared/mcp'
import {
  editableMcpConfig,
  MCP_JSON_EXAMPLE,
  mcpConfigForSave,
  parseMcpConfig,
} from '@shared/mcp-config'
import { Button } from '@/components/ui/button'

const props = defineProps<{ current: McpServerView | null; revision: number; busy: boolean }>()
const emit = defineEmits<{ save: [input: Extract<McpRequest, { action: 'save' }>]; cancel: [] }>()
const current = props.current
const revision = props.revision
const content = ref(current ? editableMcpConfig(current) : '')
const selection = ref('')
const submitted = ref(false)
const hintId = useId()
const errorId = useId()

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : '无法读取 MCP 配置。'
}

const candidates = computed(() => {
  if (!content.value.trim()) return { entries: [], error: '请粘贴 MCP JSON 配置。' }
  try {
    return { entries: parseMcpConfig(content.value), error: '' }
  } catch (cause) {
    return { entries: [], error: message(cause) }
  }
})

const selected = computed(() => {
  const { entries } = candidates.value
  return entries.length === 1 ? entries[0] : entries.find(({ name }) => name === selection.value)
})

const input = computed(() => {
  if (!selected.value)
    return { value: null, error: candidates.value.error || '请选择要保存的服务。' }
  try {
    return { value: mcpConfigForSave(selected.value, current), error: '' }
  } catch (cause) {
    return { value: null, error: message(cause) }
  }
})

function save(): void {
  submitted.value = true
  if (!input.value.value) return
  emit('save', { action: 'save', revision, ...input.value.value, confirmed: false })
}
</script>

<template>
  <form class="space-y-4 rounded-xl border bg-card p-5" @submit.prevent="save">
    <h3 class="font-medium">{{ current ? '编辑 MCP 服务' : '添加 MCP 服务' }}</h3>
    <fieldset :disabled="busy" class="space-y-4">
      <label class="block space-y-2 text-sm">
        <span class="font-medium">MCP JSON</span>
        <textarea
          v-model="content"
          :placeholder="MCP_JSON_EXAMPLE"
          :aria-describedby="submitted && input.error ? `${hintId} ${errorId}` : hintId"
          :aria-invalid="submitted && !!input.error"
          rows="12"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          wrap="off"
          class="block w-full rounded-lg border border-input bg-muted/35 px-3.5 py-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <p :id="hintId" class="text-xs leading-5 text-muted-foreground">
        粘贴包含 mcpServers 的 JSON。使用 stdio 时，command 填可执行文件的绝对路径。
      </p>
      <label v-if="candidates.entries.length > 1" class="block space-y-1.5 text-sm">
        <span>要保存的服务</span>
        <select
          v-model="selection"
          class="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="" disabled>选择一个服务</option>
          <option v-for="entry in candidates.entries" :key="entry.name" :value="entry.name">
            {{ entry.name }}
          </option>
        </select>
      </label>
    </fieldset>
    <p v-if="current?.secret_env_keys.length" class="text-sm text-muted-foreground">
      已保存加密环境变量。填写新的 env 值会整体替换，env 设为空对象可清除。
    </p>
    <p v-if="current?.authorized && current.auth === 'token'" class="text-sm text-muted-foreground">
      已保存访问令牌。填写 Authorization 会替换令牌。
    </p>
    <p v-if="current?.enabled" class="text-sm text-muted-foreground">
      保存后服务会停用。检查配置后可重新启用。
    </p>
    <p v-if="submitted && input.error" :id="errorId" role="alert" class="text-sm text-destructive">
      {{ input.error }}
    </p>
    <div class="flex justify-end gap-2">
      <Button type="button" variant="ghost" :disabled="busy" @click="emit('cancel')">取消</Button>
      <Button type="submit" :disabled="busy">保存</Button>
    </div>
  </form>
</template>
