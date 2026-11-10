<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CircleAlertIcon, RotateCwIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{ error: string; retryError: string }>()
defineEmits<{ retry: [] }>()
const retryButton = ref<InstanceType<typeof Button> | null>(null)
onMounted(() => retryButton.value?.$el.focus())
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-background">
    <header class="window-drag flex h-14 shrink-0 items-center justify-center">
      <span class="text-xs font-medium text-muted-foreground">Callum</span>
    </header>
    <main class="min-h-0 flex-1 overflow-y-auto px-6 py-12">
      <div
        class="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center pb-14 text-center"
      >
        <div
          class="mb-6 flex size-14 shrink-0 items-center justify-center rounded-2xl border border-destructive/15 bg-destructive/10 text-destructive"
        >
          <CircleAlertIcon class="size-7" aria-hidden="true" />
        </div>
        <h1 class="text-xl font-semibold tracking-tight">Callum 启动失败</h1>
        <p class="mt-3 text-sm text-muted-foreground">对话服务未能启动，请检查以下原因后重试。</p>
        <div
          role="alert"
          class="mt-6 w-full rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-left text-sm leading-6 break-words whitespace-pre-wrap"
        >
          {{ error }}
        </div>
        <p
          v-if="retryError"
          role="alert"
          class="mt-3 w-full text-left text-sm break-words text-destructive"
        >
          {{ retryError }}
        </p>
        <Button ref="retryButton" class="mt-6 gap-2" @click="$emit('retry')">
          <RotateCwIcon class="size-4" aria-hidden="true" />重试启动
        </Button>
      </div>
    </main>
  </div>
</template>
