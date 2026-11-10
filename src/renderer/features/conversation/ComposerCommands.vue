<script setup lang="ts">
import { computed } from 'vue'
import { contextPercent, contextRatio } from '@shared/context-usage'
import type { ContextUsage } from '@shared/context-usage'
import ContextUsageRing from './ContextUsageRing.vue'

const props = defineProps<{ disabledReason: string; busy: boolean; usage: ContextUsage | null }>()
const ratio = computed(() => contextRatio(props.usage))
const percent = computed(() => contextPercent(ratio.value))
const description = computed(() =>
  props.busy
    ? '正在受理压缩…'
    : props.disabledReason ||
      `压缩此聊天的上下文（${ratio.value === null ? '用量未知' : `已使用 ${percent.value}`}）`,
)
defineEmits<{ select: [] }>()
</script>

<template>
  <div
    id="composer-commands"
    role="listbox"
    aria-label="命令"
    class="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-lg border border-foreground/10 bg-card p-1 text-card-foreground shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
  >
    <button
      id="composer-compact-command"
      type="button"
      role="option"
      aria-selected="true"
      :aria-disabled="!!disabledReason"
      :aria-busy="busy"
      :data-context-percent="ratio === null ? 'unknown' : percent"
      :title="disabledReason || undefined"
      tabindex="-1"
      class="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:bg-foreground/[0.035] aria-disabled:cursor-not-allowed"
      @mousedown.prevent
      @click="!disabledReason && $emit('select')"
    >
      <ContextUsageRing :ratio="ratio" class="text-muted-foreground" />
      <span class="shrink-0 text-foreground/75">压缩</span>
      <span data-context-description class="min-w-0 truncate text-muted-foreground/75">{{
        description
      }}</span>
    </button>
    <p class="sr-only">Enter 执行 · Tab 补全 · Esc 关闭</p>
  </div>
</template>
