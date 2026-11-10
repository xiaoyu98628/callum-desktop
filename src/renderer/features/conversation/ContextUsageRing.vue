<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ ratio: number | null }>()
const dash = computed(() => `${Math.min(1, Math.max(0, props.ratio ?? 0)) * 100} 100`)
</script>

<template>
  <svg
    viewBox="0 0 20 20"
    class="size-4 shrink-0"
    aria-hidden="true"
    data-context-ring
    :data-ratio="ratio ?? 'unknown'"
  >
    <circle
      cx="10"
      cy="10"
      r="7"
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      :stroke-dasharray="ratio === null ? '2.5 3.5' : undefined"
      class="opacity-30"
    />
    <circle
      v-if="ratio !== null && ratio > 0"
      cx="10"
      cy="10"
      r="7"
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      pathLength="100"
      :stroke-dasharray="dash"
      transform="rotate(-90 10 10)"
    />
  </svg>
</template>
