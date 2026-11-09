<script setup lang="ts">
import { CornerDownLeftIcon, LoaderCircleIcon } from '@lucide/vue'

defineProps<{ disabledReason: string; busy: boolean }>()
defineEmits<{ select: [] }>()
</script>

<template>
  <div
    id="composer-commands"
    role="listbox"
    aria-label="命令"
    class="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-foreground/10 bg-card p-1 text-card-foreground shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
  >
    <button
      id="composer-compact-command"
      type="button"
      role="option"
      aria-selected="true"
      :aria-disabled="!!disabledReason"
      tabindex="-1"
      class="flex min-h-12 w-full items-center gap-3 rounded-lg bg-foreground/[0.035] px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] aria-disabled:cursor-not-allowed"
      @mousedown.prevent
      @click="!disabledReason && $emit('select')"
    >
      <svg
        viewBox="0 0 20 20"
        fill="none"
        class="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      >
        <path
          d="M5 2.5H3v10a3 3 0 0 0 3 3h1M9 5h5M9 8h5M15 2.5h2V10M11 13.5l3 3 3-3M14 11v5.5"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="min-w-0 flex-1">
        <span class="block text-[13px] leading-5">/compact</span>
        <span class="block text-xs leading-4 text-muted-foreground">{{
          disabledReason || '压缩对话上下文'
        }}</span>
      </span>
      <LoaderCircleIcon
        v-if="busy"
        class="size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="正在受理"
      />
      <CornerDownLeftIcon
        v-else
        class="size-3.5 shrink-0 text-muted-foreground/60"
        aria-hidden="true"
      />
    </button>
    <p class="sr-only">Enter 执行 · Tab 补全 · Esc 关闭</p>
  </div>
</template>
