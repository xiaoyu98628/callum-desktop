<script setup lang="ts">
import { computed } from 'vue'
import type { RunStatus } from '@shared/chat'
import { compactionStatus } from '@shared/timeline-groups'
import type { CompactionGroup } from '@shared/timeline-groups'

const props = defineProps<{
  group: CompactionGroup
  connected: boolean
  runStatus: RunStatus | null
}>()
const status = computed(() => compactionStatus(props.group.steps, props.connected, props.runStatus))
</script>

<template>
  <div data-compaction-status class="activity-compaction" role="status" aria-live="polite">
    <div class="activity-compaction-line" :class="status.danger ? 'text-destructive' : ''">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M5 2.5H3v10a3 3 0 0 0 3 3h1M9 5h5M9 8h5M15 2.5h2V10M11 13.5l3 3 3-3M14 11v5.5"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span :class="status.pending ? 'activity-shimmer' : ''">{{ status.label }}</span>
    </div>
    <p v-if="status.error" class="activity-compaction-error text-destructive">{{ status.error }}</p>
  </div>
</template>
