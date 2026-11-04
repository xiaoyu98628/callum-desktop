<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'
import { CpuIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import type { ChatModel, ChatResult } from '@shared/chat'
import type {
  ConfiguredModel,
  ModelCatalog,
  ModelInput,
  ModelProvider,
  ProviderInput,
} from '@shared/models'
import { availableModels } from '@shared/models'
import { Button } from '@/components/ui/button'
import { getDesktopApi } from '@/lib/desktop'
import ProviderEditor from './ProviderEditor.vue'
import ModelEditor from './ModelEditor.vue'
import SettingsDialog from './SettingsDialog.vue'

type Editor =
  | { kind: 'provider'; value: ModelProvider | null }
  | { kind: 'model'; value: ConfiguredModel | null; providerId: string }
type Deletion = { kind: 'provider' | 'model'; id: string; name: string }
const emit = defineEmits<{ updated: [models: ChatModel[]]; invalidated: [] }>()
const catalog = ref<ModelCatalog>({ providers: [], models: [] })
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
const editor = ref<Editor | null>(null),
  deletion = ref<Deletion | null>(null)
let disposed = false,
  loadToken = 0
function unwrap<T>(value: ChatResult<T>): T {
  if (!value.ok) throw new Error(value.error)
  return value.value
}
async function load(): Promise<boolean> {
  const token = ++loadToken
  loading.value = true
  try {
    const value = unwrap(await getDesktopApi().getModelCatalog())
    if (disposed || token !== loadToken) return false
    catalog.value = value
    error.value = ''
    emit('updated', availableModels(value))
    return true
  } catch (cause) {
    if (!disposed && token === loadToken)
      error.value = cause instanceof Error ? cause.message : '无法读取模型配置，请重试。'
    return false
  } finally {
    if (!disposed && token === loadToken) loading.value = false
  }
}
function edit(value: Editor): void {
  error.value = ''
  notice.value = ''
  editor.value = value
}
function close(): void {
  if (busy.value) return
  editor.value = null
  deletion.value = null
  error.value = ''
}
function requestDeletion(value: Deletion): void {
  error.value = ''
  notice.value = ''
  deletion.value = value
}
async function mutate(action: () => Promise<ChatResult<string>>, success: string): Promise<void> {
  if (busy.value || loading.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    unwrap(await action())
    if (disposed) return
    editor.value = null
    deletion.value = null
    notice.value = success
    if (!(await load())) {
      error.value = `配置已保存，但列表读取失败。${error.value}`
      emit('invalidated')
    }
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '配置操作失败，请重试。'
  } finally {
    if (!disposed) busy.value = false
  }
}
function saveProvider(input: ProviderInput): void {
  void mutate(() => getDesktopApi().saveModelProvider(input), '供应商已保存')
}
function saveModel(input: ModelInput): void {
  void mutate(() => getDesktopApi().saveModel(input), '模型已保存')
}
function toggle(model: ConfiguredModel): void {
  void mutate(
    () => getDesktopApi().setModelEnabled(model.id, !model.enabled),
    model.enabled ? '模型已停用' : '模型已启用',
  )
}
function remove(): void {
  const target = deletion.value
  if (!target) return
  void mutate(
    () =>
      target.kind === 'provider'
        ? getDesktopApi().deleteModelProvider(target.id)
        : getDesktopApi().deleteModel(target.id),
    target.kind === 'provider' ? '供应商已删除' : '模型已删除',
  )
}
function modelsFor(providerId: string): ConfiguredModel[] {
  return catalog.value.models.filter((model) => model.providerId === providerId)
}
onMounted(() => {
  void load()
})
onScopeDispose(() => {
  disposed = true
  loadToken++
})
</script>

<template>
  <section aria-labelledby="models-settings-title" class="min-w-0">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="models-settings-title" class="text-lg font-semibold">模型</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">管理模型服务与可用于对话的模型。</p>
      </div>
      <Button
        v-if="catalog.providers.length"
        size="sm"
        :disabled="busy || loading"
        @click="edit({ kind: 'provider', value: null })"
        ><PlusIcon class="size-4" aria-hidden="true" />添加供应商</Button
      >
    </div>
    <div
      v-if="error && !editor && !deletion"
      role="alert"
      class="mt-5 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm leading-6"
    >
      <p>{{ error }}</p>
      <Button variant="outline" size="sm" class="mt-3" :disabled="loading || busy" @click="load"
        >重试加载配置</Button
      >
    </div>
    <p v-if="notice" role="status" class="mt-4 text-sm text-muted-foreground">{{ notice }}</p>
    <p v-if="loading" role="status" class="py-8 text-sm text-muted-foreground">正在读取模型配置…</p>
    <div
      v-else-if="!catalog.providers.length && !error"
      class="mt-7 flex flex-col items-center rounded-2xl border border-dashed bg-card/50 px-6 py-14 text-center"
    >
      <div class="mb-5 rounded-xl bg-accent p-3 text-primary">
        <CpuIcon class="size-6" aria-hidden="true" />
      </div>
      <h3 class="font-medium">添加你的模型服务</h3>
      <p class="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        填写供应商的 API 地址和凭据，再添加需要使用的模型。
      </p>
      <Button class="mt-6" :disabled="busy" @click="edit({ kind: 'provider', value: null })"
        ><PlusIcon class="size-4" aria-hidden="true" />添加供应商</Button
      >
    </div>
    <div class="mt-6 space-y-5">
      <section
        v-for="provider in catalog.providers"
        :key="provider.id"
        :aria-label="provider.name"
        class="min-w-0 rounded-2xl border bg-card"
      >
        <div class="flex flex-wrap items-start gap-3 p-5">
          <div class="mt-0.5 rounded-lg bg-accent p-2 text-primary">
            <CpuIcon class="size-4" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="break-words text-sm font-semibold">{{ provider.name }}</h3>
            <p class="mt-1 break-all text-xs leading-5 text-muted-foreground">
              {{ provider.baseUrl }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ provider.hasApiKey ? '已设置 API Key' : '未设置 API Key' }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon"
              class="size-8"
              :disabled="busy || loading"
              :aria-label="'编辑供应商 ' + provider.name"
              @click="edit({ kind: 'provider', value: provider })"
              ><PencilIcon class="size-3.5" aria-hidden="true" /></Button
            ><Button
              variant="ghost"
              size="icon"
              class="size-8 text-muted-foreground hover:text-destructive"
              :disabled="busy || loading || !!modelsFor(provider.id).length"
              :aria-label="'删除供应商 ' + provider.name"
              :title="modelsFor(provider.id).length ? '请先删除关联模型' : '删除供应商'"
              @click="requestDeletion({ kind: 'provider', id: provider.id, name: provider.name })"
              ><Trash2Icon class="size-3.5" aria-hidden="true"
            /></Button>
          </div>
        </div>
        <div class="border-t px-5">
          <div
            v-for="model in modelsFor(provider.id)"
            :key="model.id"
            role="group"
            :aria-label="model.name"
            class="flex min-w-0 items-center gap-3 border-b py-4 last:border-b-0"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium" :title="model.name">{{ model.name }}</p>
              <p class="mt-1 break-all text-xs text-muted-foreground">{{ model.remoteModelId }}</p>
            </div>
            <button
              role="switch"
              :aria-checked="model.enabled"
              :aria-label="'启用模型 ' + model.name"
              :disabled="busy || loading"
              class="relative h-5 w-9 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              :class="model.enabled ? 'bg-primary' : 'bg-muted-foreground/30'"
              @click="toggle(model)"
            >
              <span
                class="absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform"
                :class="model.enabled ? 'left-0.5 translate-x-4' : 'left-0.5'"
              />
            </button>
            <Button
              variant="ghost"
              size="icon"
              class="size-8 shrink-0"
              :disabled="busy || loading"
              :aria-label="'编辑模型 ' + model.name"
              @click="edit({ kind: 'model', value: model, providerId: provider.id })"
              ><PencilIcon class="size-3.5" aria-hidden="true" /></Button
            ><Button
              variant="ghost"
              size="icon"
              class="size-8 shrink-0 text-muted-foreground hover:text-destructive"
              :disabled="busy || loading"
              :aria-label="'删除模型 ' + model.name"
              @click="requestDeletion({ kind: 'model', id: model.id, name: model.name })"
              ><Trash2Icon class="size-3.5" aria-hidden="true"
            /></Button>
          </div>
          <p v-if="!modelsFor(provider.id).length" class="py-5 text-xs text-muted-foreground">
            尚未添加模型
          </p>
        </div>
        <div class="border-t px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            class="text-xs"
            :disabled="busy || loading"
            :aria-label="'为 ' + provider.name + ' 添加模型'"
            @click="edit({ kind: 'model', value: null, providerId: provider.id })"
            ><PlusIcon class="size-3.5" aria-hidden="true" />添加模型</Button
          >
        </div>
      </section>
    </div>
    <ProviderEditor
      v-if="editor?.kind === 'provider'"
      :provider="editor.value"
      :busy="busy"
      :error="error"
      @close="close"
      @save="saveProvider"
    />
    <ModelEditor
      v-if="editor?.kind === 'model'"
      :model="editor.value"
      :provider-id="editor.providerId"
      :providers="catalog.providers"
      :busy="busy"
      :error="error"
      @close="close"
      @save="saveModel"
    />
    <SettingsDialog
      v-if="deletion"
      :title="deletion.kind === 'provider' ? '删除供应商？' : '删除模型？'"
      :description="
        deletion.kind === 'provider'
          ? `将删除“${deletion.name}”的连接配置，此操作无法撤销。`
          : `将删除“${deletion.name}”的模型配置。已有对话和消息会保留，继续对话时需选择其他可用模型。`
      "
      :busy="busy"
      @close="close"
    >
      <p v-if="error" role="alert" class="mb-4 text-sm leading-6 text-destructive">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" :disabled="busy" @click="close">取消</Button
        ><Button variant="destructive" :disabled="busy" @click="remove">{{
          busy ? '正在删除…' : deletion.kind === 'provider' ? '删除供应商' : '删除模型'
        }}</Button>
      </div>
    </SettingsDialog>
  </section>
</template>
