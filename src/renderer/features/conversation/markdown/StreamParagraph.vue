<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { acceptsStreamMotion, streamFragments, type StreamFragment } from './stream-fade'

const props = defineProps<{ text: string; streaming: boolean }>()
const settled = ref('')
const fragments = shallowRef<StreamFragment[]>([])

watch(
  [() => props.text, () => props.streaming],
  ([text, streaming], [previous]) => {
    const before = previous ?? ''
    if (!streaming || !acceptsStreamMotion() || !text.startsWith(before)) {
      settled.value = text
      fragments.value = []
      return
    }
    if (text === before) return

    const incoming = streamFragments(text, before.length)
    const start = incoming[0]?.start ?? text.length
    const active = start === before.length ? fragments.value.slice(-21) : []
    settled.value = text.slice(0, active[0]?.start ?? start)
    fragments.value = [...active, ...incoming]
  },
  { immediate: true },
)

function settle(end: number): void {
  if (end <= settled.value.length) return
  settled.value = props.text.slice(0, end)
  fragments.value = fragments.value.filter((fragment) => fragment.end > end)
}
</script>

<template>
  <p class="markdown-stream-paragraph">
    {{ settled
    }}<span
      v-for="fragment in fragments"
      :key="fragment.start"
      class="markdown-stream-fragment"
      :style="{ animationDelay: `${fragment.delay}ms` }"
      @animationend="settle(fragment.end)"
      @animationcancel="settle(fragment.end)"
      >{{ text.slice(fragment.start, fragment.end) }}</span
    >
  </p>
</template>
