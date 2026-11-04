<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import type { ModelProvider, ProviderInput } from '@shared/models'
import { parseProviderInput, PROVIDER_SERVICES } from '@shared/models'
import { Button } from '@/components/ui/button'
import SettingsDialog from './SettingsDialog.vue'

const props = defineProps<{ provider: ModelProvider | null; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; save: [input: ProviderInput] }>()
const protocol = ref(props.provider?.protocol ?? PROVIDER_SERVICES[0].value)
const supportedProtocol = computed(() =>
  PROVIDER_SERVICES.some((service) => service.value === protocol.value),
)
const name = ref(props.provider?.name ?? '')
const baseUrl = ref(props.provider?.baseUrl ?? '')
const apiKey = ref('')
const clearKey = ref(false)
const validationError = ref('')
const inputClass =
  'mt-2 block w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
function save(): void {
  validationError.value = ''
  try {
    const secret = apiKey.value.trim()
    emit(
      'save',
      parseProviderInput({
        id: props.provider?.id ?? null,
        protocol: protocol.value,
        name: name.value,
        baseUrl: baseUrl.value,
        keyMode: clearKey.value ? 'clear' : secret ? 'replace' : 'keep',
        ...(secret && !clearKey.value ? { apiKey: secret } : {}),
      }),
    )
  } catch (error) {
    validationError.value = error instanceof Error ? error.message : '请检查配置'
  }
}
onScopeDispose(() => {
  apiKey.value = ''
})
</script>

<template>
  <SettingsDialog
    :title="provider ? '编辑供应商' : '添加供应商'"
    description="选择模型服务类型并填写连接信息。一个供应商可以配置多个模型。"
    :busy="busy"
    @close="emit('close')"
  >
    <form class="space-y-5" @submit.prevent="save">
      <div>
        <label for="provider-service" class="text-sm font-medium">服务类型</label>
        <select
          id="provider-service"
          v-model="protocol"
          :class="inputClass"
          :disabled="busy"
          required
        >
          <option v-if="!supportedProtocol" :value="protocol" disabled>暂不支持的服务类型</option>
          <option v-for="service in PROVIDER_SERVICES" :key="service.value" :value="service.value">
            {{ service.label }}
          </option>
        </select>
      </div>
      <div>
        <label for="provider-name" class="text-sm font-medium">供应商名称</label
        ><input
          id="provider-name"
          v-model="name"
          :class="inputClass"
          :disabled="busy"
          maxlength="120"
          required
          placeholder="例如：我的模型服务"
        />
      </div>
      <div>
        <label for="provider-url" class="text-sm font-medium">API 地址</label
        ><input
          id="provider-url"
          v-model="baseUrl"
          :class="inputClass"
          :disabled="busy"
          maxlength="2048"
          type="url"
          required
          placeholder="https://api.example.com/v1"
          spellcheck="false"
        />
        <p class="mt-2 text-xs leading-5 text-muted-foreground">
          填写服务的 API 根地址，通常以 /v1 结尾。
        </p>
      </div>
      <div>
        <label for="provider-key" class="text-sm font-medium"
          >API Key <span class="font-normal text-muted-foreground">（可选）</span></label
        ><input
          id="provider-key"
          v-model="apiKey"
          :class="inputClass"
          :disabled="busy || clearKey"
          maxlength="8192"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :placeholder="provider?.hasApiKey ? '已设置，留空保留原密钥' : '输入服务提供的 API Key'"
        />
        <p class="mt-2 text-xs leading-5 text-muted-foreground">
          凭据保存在本机，不会在列表中显示。{{
            provider?.hasApiKey ? '填写新值可替换原密钥。' : '无需认证的本地服务可以留空。'
          }}
        </p>
      </div>
      <label v-if="provider?.hasApiKey" class="flex items-center gap-2 text-sm"
        ><input
          v-model="clearKey"
          type="checkbox"
          :disabled="busy"
          class="size-4 accent-primary"
          @change="apiKey = ''"
        />清除已保存的 API Key</label
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
        ><Button type="submit" :disabled="busy || !supportedProtocol">{{
          busy ? '正在保存…' : '保存供应商'
        }}</Button>
      </div>
    </form>
  </SettingsDialog>
</template>
