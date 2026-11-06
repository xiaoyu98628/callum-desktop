<script setup lang="ts">
import { CpuIcon, PaletteIcon } from '@lucide/vue'
import type { ChatModel } from '@shared/chat'
import type { SettingsSection } from '@/app/navigation'
import { Button } from '@/components/ui/button'
import AppearanceSettings from '@/features/appearance/AppearanceSettings.vue'
import ModelSettings from '@/features/models/ModelSettings.vue'
defineProps<{ section: SettingsSection }>()
defineEmits<{
  'update:section': [value: SettingsSection]
  modelsUpdated: [models: ChatModel[]]
  modelsInvalidated: []
}>()
</script>

<template>
  <section class="mx-auto max-w-6xl px-8 py-9 lg:px-12 lg:py-12" aria-labelledby="settings-title">
    <h1 id="settings-title" class="text-xl font-semibold tracking-tight">设置</h1>
    <p class="mt-3 text-sm leading-6 text-muted-foreground">管理外观偏好和模型服务。</p>

    <div class="mt-9 grid min-w-0 gap-7 lg:grid-cols-[8rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="设置分类" class="flex gap-2 lg:flex-col">
        <Button
          :variant="section === 'appearance' ? 'secondary' : 'ghost'"
          class="justify-start gap-2.5 lg:w-full"
          :aria-current="section === 'appearance' ? 'page' : undefined"
          aria-controls="appearance-settings"
          @click="$emit('update:section', 'appearance')"
        >
          <PaletteIcon class="size-4" aria-hidden="true" />
          外观
        </Button>
        <Button
          :variant="section === 'models' ? 'secondary' : 'ghost'"
          class="justify-start gap-2.5 lg:w-full"
          :aria-current="section === 'models' ? 'page' : undefined"
          aria-controls="models-settings"
          @click="$emit('update:section', 'models')"
          ><CpuIcon class="size-4" aria-hidden="true" />模型</Button
        >
      </nav>
      <AppearanceSettings v-if="section === 'appearance'" id="appearance-settings" />
      <ModelSettings
        v-else
        id="models-settings"
        @updated="$emit('modelsUpdated', $event)"
        @invalidated="$emit('modelsInvalidated')"
      />
    </div>
  </section>
</template>
