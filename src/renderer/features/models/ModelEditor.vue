<script setup lang="ts">
import { ref } from 'vue'
import type { ConfiguredModel, ModelProvider, ModelInput } from '@shared/models'
import { parseModelInput } from '@shared/models'
import { Button } from '@/components/ui/button'
import SettingsDialog from './SettingsDialog.vue'

const props = defineProps<{
  model: ConfiguredModel | null
  providerId: string
  providers: ModelProvider[]
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ close: []; save: [input: ModelInput] }>()
const providerId = ref(props.model?.providerId ?? props.providerId)
const name = ref(props.model?.name ?? '')
const remoteModelId = ref(props.model?.remoteModelId ?? '')
const enabled = ref(props.model?.enabled ?? true)
const contextWindow = ref<number | string>(props.model?.contextWindow ?? '')
const validationError = ref('')
const inputClass =
  'mt-2 block w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
function save(): void {
  validationError.value = ''
  try {
    emit(
      'save',
      parseModelInput({
        id: props.model?.id ?? null,
        providerId: providerId.value,
        name: name.value,
        remoteModelId: remoteModelId.value,
        enabled: enabled.value,
        contextWindow: Number(contextWindow.value),
      }),
    )
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : '请检查配置'
  }
}
</script>

<template>
  <SettingsDialog
    :title="model ? '编辑模型' : '添加模型'"
    description="设置对话中显示的名称，以及供应商实际提供的模型 ID。"
    :busy="busy"
    @close="emit('close')"
  >
    <form class="space-y-5" @submit.prevent="save">
      <div>
        <label for="model-provider" class="text-sm font-medium">供应商</label
        ><select
          id="model-provider"
          v-model="providerId"
          :class="inputClass"
          :disabled="busy"
          required
        >
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">
            {{ provider.name }}
          </option>
        </select>
      </div>
      <div>
        <label for="model-name" class="text-sm font-medium">模型名称</label
        ><input
          id="model-name"
          v-model="name"
          :class="inputClass"
          :disabled="busy"
          maxlength="120"
          required
          placeholder="对话中显示的名称"
        />
      </div>
      <div>
        <label for="model-remote-id" class="text-sm font-medium">模型 ID</label
        ><input
          id="model-remote-id"
          v-model="remoteModelId"
          :class="inputClass"
          :disabled="busy"
          maxlength="256"
          required
          placeholder="供应商提供的模型标识"
          spellcheck="false"
        />
      </div>
      <div>
        <label for="model-context-window" class="text-sm font-medium">上下文容量（Token）</label>
        <input
          id="model-context-window"
          v-model="contextWindow"
          :class="inputClass"
          type="number"
          inputmode="numeric"
          min="1"
          max="1000000000"
          step="1"
          :disabled="busy"
          required
          placeholder="填写供应商声明的上下文容量"
        />
        <p class="mt-2 text-xs leading-5 text-muted-foreground">
          填写模型实际支持的 Token 数，服务据此计算上下文预算。已有模型未配置时请补充。
        </p>
      </div>
      <label class="flex items-center gap-2 text-sm"
        ><input
          v-model="enabled"
          type="checkbox"
          :disabled="busy"
          class="size-4 accent-primary"
        />启用此模型</label
      >
      <p
        v-if="validationError || error"
        role="alert"
        class="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm leading-6"
      >
        {{ validationError || error }}
      </p>
      <div class="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" :disabled="busy" @click="emit('close')">取消</Button
        ><Button type="submit" :disabled="busy">{{ busy ? '正在保存…' : '保存模型' }}</Button>
      </div>
    </form>
  </SettingsDialog>
</template>
