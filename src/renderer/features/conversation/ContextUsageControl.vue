<script setup lang="ts">
import { computed } from 'vue'
import {
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui'
import { contextPercent, contextRatio, contextTokens } from '@shared/context-usage'
import type { ContextUsage } from '@shared/context-usage'
import ContextUsageRing from './ContextUsageRing.vue'

const props = defineProps<{
  usage: ContextUsage | null
  error: string
  loading: boolean
  configured: boolean
  serviceError: string
}>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const ratio = computed(() => contextRatio(props.usage))
const percent = computed(() => contextPercent(ratio.value))
const estimate = computed(() =>
  props.usage?.state === 'ready'
    ? `已用约 ${contextTokens(props.usage.estimatedTokens)} 标记，共 ${contextTokens(props.usage.inputLimit)}`
    : '',
)
const status = computed(() => {
  if (props.serviceError) return '连接已断开'
  if (props.error) return props.error
  if (!props.configured) return '选择模型后显示用量'
  if (!props.usage || props.usage.state === 'preparing' || props.usage.state === 'refresh_required')
    return '正在计算上下文…'
  if (props.usage.state === 'unavailable') return '暂无法统计，可压缩后重试'
  if (ratio.value === null)
    return props.usage.contextWindow === null ? '未配置上下文容量' : '可用输入预算不足'
  return ''
})
const description = computed(() =>
  ['背景信息窗口', `${percent.value} 已用`, estimate.value, status.value]
    .filter(Boolean)
    .join('，'),
)
</script>

<template>
  <TooltipProvider :delay-duration="250">
    <TooltipRoot ignore-non-keyboard-focus @update:open="emit('update:open', $event)">
      <TooltipTrigger as-child>
        <button
          type="button"
          aria-label="上下文使用情况"
          :aria-busy="loading"
          :data-context-percent="ratio === null ? 'unknown' : percent"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ContextUsageRing :ratio="ratio" />
        </button>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          side="top"
          align="center"
          :side-offset="8"
          :collision-padding="12"
          :aria-label="description"
          data-context-tooltip
          class="z-50 w-max max-w-[min(18rem,calc(100vw-1.5rem))] rounded-md bg-[#202123] px-2.5 py-1.5 text-center text-xs leading-5 text-white shadow-sm"
        >
          <p class="text-white/60">背景信息窗口：</p>
          <p class="break-words tabular-nums text-white/70" data-context-percentage>
            {{ ratio === null ? status : `${percent} 已用` }}
          </p>
          <p
            v-if="estimate"
            data-context-estimate
            :data-tokens="usage?.estimatedTokens"
            class="tabular-nums text-white/95"
          >
            {{ estimate }}
          </p>
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
