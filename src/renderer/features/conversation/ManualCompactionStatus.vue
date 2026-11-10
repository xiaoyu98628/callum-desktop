<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import type { ChatRun } from '@shared/chat'
import { compactionOutcome, manualCompactionStatus } from '@shared/manual-compaction'
import type { CompactionOutcome } from '@shared/manual-compaction'
import { getDesktopApi } from '@/lib/desktop'
import CompactionStatus from './CompactionStatus.vue'

const props = defineProps<{ run: ChatRun; connected: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const outcome = ref<CompactionOutcome>('unknown')
const reading = ref(false)
const error = ref('')
let generation = 0
let disposed = false
const status = computed(() =>
  manualCompactionStatus(props.run, props.connected, outcome.value, reading.value, error.value),
)

async function readResult(force = false): Promise<void> {
  const token = ++generation
  const run = props.run
  error.value = ''
  if (run.status !== 'completed' || !run.compaction) {
    reading.value = false
    return
  }
  if (!force && run.compaction.outcome !== null) {
    outcome.value = run.compaction.outcome
    error.value = run.compaction.error ?? ''
    reading.value = false
    return
  }
  if (!props.connected) {
    reading.value = false
    return
  }
  reading.value = true
  try {
    const result = await getDesktopApi().getStepDetails(
      run.conversationId,
      run.id,
      run.compaction.stepId,
    )
    if (!result.ok) throw new Error(result.error)
    if (
      result.value.id !== run.compaction.stepId ||
      result.value.runId !== run.id ||
      result.value.conversationId !== run.conversationId
    )
      throw new Error('压缩结果归属不匹配。')
    const value = compactionOutcome(result.value)
    if (!disposed && token === generation) outcome.value = value
  } catch (failure) {
    if (!disposed && token === generation)
      error.value = failure instanceof Error ? failure.message : '无法读取压缩结果。'
  } finally {
    if (!disposed && token === generation) {
      reading.value = false
      emit('changed')
    }
  }
}
watch(
  () => [props.run.id, props.run.status, props.run.compaction, props.connected] as const,
  (_, previous) => {
    if (!previous || props.run.id !== previous[0]) outcome.value = 'unknown'
    void readResult()
  },
  { immediate: true },
)
onScopeDispose(() => {
  disposed = true
  generation++
})
</script>

<template>
  <div data-manual-compaction :data-run-id="run.id" class="py-1">
    <CompactionStatus :status="status" />
    <button
      v-if="error"
      type="button"
      class="ml-5 text-xs underline text-muted-foreground"
      :disabled="!connected || reading"
      @click="readResult(true)"
    >
      重新读取结果
    </button>
  </div>
</template>
