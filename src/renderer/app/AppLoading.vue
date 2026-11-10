<script setup lang="ts">
import { LoaderCircleIcon, SparklesIcon } from '@lucide/vue'

defineProps<{ closing: boolean }>()
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-background">
    <header class="window-drag flex h-14 shrink-0 items-center justify-center">
      <span class="text-xs font-medium text-muted-foreground">Callum</span>
    </header>
    <main class="flex min-h-0 flex-1 items-center justify-center px-6 pb-14">
      <div role="status" aria-live="polite" class="flex flex-col items-center text-center">
        <div
          class="mb-6 flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary"
        >
          <SparklesIcon class="size-7" aria-hidden="true" />
        </div>
        <h1 class="text-xl font-semibold tracking-tight">
          {{ closing ? '正在关闭…' : '正在加载 Callum…' }}
        </h1>
        <div class="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon class="size-4 motion-safe:animate-spin" aria-hidden="true" />
          <p>
            {{ closing ? '正在结束任务并关闭服务，请稍候。' : '正在准备你的工作空间，请稍候。' }}
          </p>
        </div>
      </div>
    </main>
  </div>
</template>
