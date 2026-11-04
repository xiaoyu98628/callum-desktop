<script setup lang="ts">
import { PaletteIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import AppearanceSettings from '@/features/appearance/AppearanceSettings.vue'
</script>

<template>
  <section class="mx-auto max-w-6xl px-8 py-9 lg:px-12 lg:py-12" aria-labelledby="settings-title">
    <h1 id="settings-title" class="text-xl font-semibold tracking-tight">设置</h1>
    <p class="mt-3 text-sm leading-6 text-muted-foreground">管理 Callum 的个人偏好。</p>

    <div class="mt-9 grid min-w-0 gap-7 lg:grid-cols-[8rem_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="设置分类">
        <Button
          variant="secondary"
          class="justify-start gap-2.5 lg:w-full"
          aria-current="page"
          aria-controls="appearance-settings"
        >
          <PaletteIcon class="size-4" aria-hidden="true" />
          外观
        </Button>
      </nav>
      <AppearanceSettings id="appearance-settings" />
    </div>
  </section>
</template>
