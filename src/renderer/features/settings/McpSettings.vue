<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { PlugIcon, PlusIcon, RefreshCwIcon } from '@lucide/vue'
import type {
  McpCatalog,
  McpOAuthState,
  McpRequest,
  McpResponse,
  McpServerView,
  McpTool,
} from '@shared/mcp'
import { parseMcpServer } from '@shared/mcp'
import { Button } from '@/components/ui/button'
import { getDesktopApi } from '@/lib/desktop'
import McpServerEditor from './McpServerEditor.vue'

type Intent = {
  kind: 'test' | 'enable' | 'delete' | 'disconnect'
  server: McpServerView
  revision: number
}
const catalog = ref<McpCatalog | null>(null)
const editor = ref<McpServerView | null | undefined>(undefined)
const selectedId = ref('')
const discovered = ref<McpTool[] | null>(null)
const selectedTools = ref<string[]>([])
const intent = ref<Intent | null>(null)
const pendingId = ref('')
const oauth = ref<McpOAuthState | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

async function request(input: McpRequest): Promise<McpResponse> {
  const result = await getDesktopApi().mcp(input)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

async function refresh(): Promise<void> {
  const value = await request({ action: 'list' })
  if (typeof value !== 'object' || Array.isArray(value) || !('servers' in value)) return
  if (catalog.value && value.revision < catalog.value.revision) return
  catalog.value = value
  if (!value.servers.some((server) => server.id === selectedId.value)) select(null)
  if (pendingId.value && !value.servers.some((server) => server.id === pendingId.value)) {
    clearTimeout(timer)
    pendingId.value = ''
    oauth.value = null
  }
}

function select(server: McpServerView | null): void {
  selectedId.value = server?.id ?? ''
  discovered.value = server?.tools.length ? server.tools : null
  selectedTools.value = [...(server?.allowed_tools ?? [])]
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'MCP 操作失败，请重试。'
  } finally {
    busy.value = false
  }
}

async function save(input: Extract<McpRequest, { action: 'save' }>): Promise<void> {
  const previous = catalog.value?.servers.find((server) => server.id === input.server.id)
  const result = await request(input)
  if (previous && previous.scope !== input.server.scope && pendingId.value === result) {
    clearTimeout(timer)
    pendingId.value = ''
    oauth.value = null
  }
  editor.value = undefined
  await refresh()
  select(catalog.value?.servers.find((server) => server.id === result) ?? null)
  notice.value = 'MCP 服务已保存。'
}

async function choose(server: McpServerView): Promise<void> {
  select(server)
  if (server.auth === 'oauth') {
    const value = await request({ action: 'status', id: server.id })
    if (isOAuth(value)) track(server.id, value)
  }
}

function isOAuth(value: McpResponse): value is McpOAuthState {
  return typeof value === 'object' && !Array.isArray(value) && 'status' in value
}

function track(id: string, state: McpOAuthState): void {
  clearTimeout(timer)
  pendingId.value = id
  oauth.value = state
  if (state.status === 'pending') timer = setTimeout(() => void poll(id), 900)
}

async function poll(id: string): Promise<void> {
  if (disposed || pendingId.value !== id) return
  let trackedState = oauth.value
  try {
    const value = await request({ action: 'status', id })
    if (disposed || pendingId.value !== id || oauth.value !== trackedState || !isOAuth(value))
      return
    track(id, value)
    trackedState = oauth.value
    if (value.status === 'authorized') await refresh()
  } catch {
    if (disposed || pendingId.value !== id || oauth.value !== trackedState) return
    track(id, { status: 'failed', message: '无法读取授权状态，请刷新后查看。' })
  }
}

async function oauthAction(action: 'start' | 'cancel', id: string): Promise<void> {
  const value = await request({ action, id })
  if (isOAuth(value)) track(id, value)
}

async function test(
  server: McpServerView,
  confirmed: boolean,
  revision = catalog.value?.revision,
): Promise<void> {
  if (revision === undefined) return
  const value = await request({ action: 'test', id: server.id, confirmed, revision })
  if (Array.isArray(value)) discovered.value = value
  await refresh()
  notice.value = Array.isArray(value) ? `连接成功，发现 ${value.length} 个工具。` : '连接成功。'
}

async function update(
  server: McpServerView,
  changes: Partial<McpServerView>,
  confirmed = false,
  revision = catalog.value?.revision,
): Promise<void> {
  if (revision === undefined) return
  await request({
    action: 'save',
    revision,
    server: parseMcpServer({ ...server, ...changes }),
    secrets: {},
    confirmed,
  })
  await refresh()
}

function ask(kind: Intent['kind'], server: McpServerView): void {
  if (catalog.value) intent.value = { kind, server, revision: catalog.value.revision }
}

async function confirmIntent(): Promise<void> {
  const selected = intent.value
  if (!selected) return
  const { kind, server, revision } = selected
  intent.value = null
  if (kind === 'test') await test(server, true, revision)
  else if (kind === 'enable') await update(server, { enabled: true }, true, revision)
  else if (kind === 'disconnect') {
    await request({ action: 'disconnect', id: server.id })
    await refresh()
  } else if (catalog.value) {
    await request({ action: 'delete', id: server.id, revision })
    await refresh()
  }
}

async function saveTools(server: McpServerView): Promise<void> {
  await update(server, { allowed_tools: [...selectedTools.value] })
  notice.value = '工具选择已保存。'
}

onMounted(() => void run(refresh))
onUnmounted(() => {
  disposed = true
  clearTimeout(timer)
})
</script>

<template>
  <section aria-labelledby="mcp-title" class="min-w-0 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="mcp-title" class="text-lg font-semibold">MCP 服务</h2>
      <div class="flex gap-2">
        <Button type="button" size="sm" variant="outline" :disabled="busy" @click="run(refresh)">
          <RefreshCwIcon class="size-4" aria-hidden="true" />刷新
        </Button>
        <Button type="button" size="sm" :disabled="busy || !catalog" @click="editor = null">
          <PlusIcon class="size-4" aria-hidden="true" />添加服务
        </Button>
      </div>
    </div>
    <p v-if="error" role="alert" class="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
      {{ error }}
    </p>
    <p v-if="notice" role="status" class="text-sm text-muted-foreground">{{ notice }}</p>
    <p v-if="!catalog && busy" role="status" class="text-sm text-muted-foreground">
      正在读取 MCP 设置…
    </p>

    <McpServerEditor
      v-if="editor !== undefined && catalog"
      :key="editor?.id ?? 'new'"
      :current="editor"
      :revision="catalog.revision"
      :busy="busy"
      @save="run(() => save($event))"
      @cancel="editor = undefined"
    />
    <p
      v-if="catalog?.servers.length === 0 && editor === undefined"
      class="rounded-xl border p-5 text-sm text-muted-foreground"
    >
      暂无 MCP 服务。添加服务时可以直接粘贴 MCP JSON。
    </p>
    <article
      v-for="server in catalog?.servers"
      :key="server.id"
      class="min-w-0 rounded-xl border bg-card"
    >
      <div class="flex flex-wrap items-center justify-between gap-3 p-4">
        <button
          type="button"
          class="flex min-w-0 items-center gap-3 text-left focus-visible:outline-ring"
          :aria-expanded="selectedId === server.id"
          :disabled="busy"
          @click="selectedId === server.id ? select(null) : run(() => choose(server))"
        >
          <PlugIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0">
            <span class="block break-words text-sm font-medium [overflow-wrap:anywhere]">{{
              server.name
            }}</span>
            <span class="block text-xs text-muted-foreground">
              {{ server.transport === 'stdio' ? '本地 stdio' : '远程 Streamable HTTP' }}
              · {{ server.enabled ? '已启用' : '已停用' }} ·
              {{ server.connected ? '已连接' : '未连接' }}
            </span>
          </span>
        </button>
        <div class="flex gap-2">
          <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="editor = server"
            >编辑</Button
          >
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="
              server.enabled || server.transport !== 'stdio'
                ? run(() => update(server, { enabled: !server.enabled }))
                : ask('enable', server)
            "
            >{{ server.enabled ? '停用' : '启用' }}</Button
          >
        </div>
      </div>
      <div v-if="selectedId === server.id" class="space-y-4 border-t p-4">
        <p class="break-all font-mono text-xs text-muted-foreground">
          {{ server.url ?? server.command }}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="
              server.transport === 'stdio' ? ask('test', server) : run(() => test(server, false))
            "
            >测试连接</Button
          >
          <Button
            v-if="server.auth === 'oauth'"
            type="button"
            size="sm"
            variant="outline"
            :disabled="busy || (pendingId === server.id && oauth?.status === 'pending')"
            @click="run(() => oauthAction('start', server.id))"
            >{{ server.authorized ? '重新授权' : 'OAuth 授权' }}</Button
          >
          <Button
            v-if="pendingId === server.id && oauth?.status === 'pending'"
            type="button"
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="run(() => oauthAction('cancel', server.id))"
            >取消授权</Button
          >
          <Button
            v-if="server.authorized"
            type="button"
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="ask('disconnect', server)"
            >清除凭据</Button
          >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            class="text-destructive"
            :disabled="busy"
            @click="ask('delete', server)"
            >删除</Button
          >
        </div>
        <p v-if="server.auth !== 'none'" class="text-xs text-muted-foreground">
          {{ server.authorized ? '已配置访问凭据' : '待授权' }}
        </p>
        <p v-if="server.secret_env_keys.length" class="text-xs text-muted-foreground">
          加密环境变量 {{ server.secret_env_keys.join('、') }}
        </p>
        <p
          v-if="pendingId === server.id && oauth"
          role="status"
          class="text-sm text-muted-foreground"
        >
          {{
            oauth.message ??
            {
              idle: '',
              pending: '请在系统浏览器中完成授权。',
              authorized: '授权成功。',
              cancelled: '已取消授权。',
              failed: '授权失败。',
            }[oauth.status]
          }}
        </p>
        <fieldset
          v-if="discovered !== null || selectedTools.length"
          :disabled="busy"
          class="space-y-2"
        >
          <legend class="mb-2 text-sm font-medium">允许模型使用的工具</legend>
          <p
            v-if="discovered?.length === 0 && !selectedTools.length"
            class="text-sm text-muted-foreground"
          >
            该服务没有提供工具。
          </p>
          <label
            v-for="entry in discovered ?? []"
            :key="entry.name"
            class="flex min-w-0 items-start gap-2 text-sm"
          >
            <input v-model="selectedTools" :value="entry.name" class="mt-1" type="checkbox" />
            <span class="break-words [overflow-wrap:anywhere]"
              >{{ entry.name
              }}<span class="block text-xs text-muted-foreground">{{
                entry.description
              }}</span></span
            >
          </label>
          <label
            v-for="name in selectedTools.filter(
              (item) => !discovered?.some((tool) => tool.name === item),
            )"
            :key="name"
            class="flex items-center gap-2 break-all text-sm"
          >
            <input v-model="selectedTools" :value="name" type="checkbox" />{{ name }} · 未发现
          </label>
          <Button type="button" size="sm" variant="outline" @click="run(() => saveTools(server))"
            >保存工具选择</Button
          >
        </fieldset>
      </div>
    </article>

    <section
      v-if="intent"
      role="alertdialog"
      aria-label="确认 MCP 操作"
      class="space-y-3 rounded-xl border p-4"
    >
      <p v-if="intent.kind === 'delete'" class="text-sm">
        删除 {{ intent.server.name }} 及其在 Callum 中保存的凭据？
      </p>
      <p v-else-if="intent.kind === 'disconnect'" class="text-sm">
        清除 {{ intent.server.name }} 在 Callum 中保存的访问凭据？
      </p>
      <div v-else class="space-y-2 text-sm">
        <p>
          {{
            intent.kind === 'test' ? '测试连接' : '启用服务'
          }}会启动以下程序。程序以当前系统用户权限运行。
        </p>
        <p class="break-all font-mono text-xs">
          {{ intent.server.command }}
          {{ (intent.server.args ?? []).map((arg) => JSON.stringify(arg)).join(' ') }}
        </p>
        <p class="break-all text-xs text-muted-foreground">
          工作目录 {{ intent.server.directory || '系统临时目录' }}
        </p>
      </div>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" :disabled="busy" @click="intent = null">取消</Button>
        <Button type="button" :disabled="busy" @click="run(confirmIntent)">确认</Button>
      </div>
    </section>
  </section>
</template>
