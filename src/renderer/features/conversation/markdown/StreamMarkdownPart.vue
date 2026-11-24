<script setup lang="ts">
import { onBeforeUpdate, onMounted, ref, watch } from 'vue'
import StreamParagraph from './StreamParagraph.vue'
import { acceptsStreamMotion, streamFadeDuration, streamFragments } from './stream-fade'
import type { StreamFragment } from './stream-fade'
import type { MarkdownPart } from './stream-preview'

const props = defineProps<{ entry: MarkdownPart; animate: boolean }>()
const root = ref<HTMLElement | null>(null)
const fragmentClass = 'markdown-stream-fragment'
const blockSelector = '.markdown-code-block, .markdown-table-wrap, pre, table, button, svg'
let previousText = ''
let drawn = props.entry
let fading: (StreamFragment & { time: number })[] = []

function replacedMarkup(entry: MarkdownPart): boolean {
  return 'html' in entry && ('text' in drawn || entry.html !== drawn.html)
}

function prose(element: HTMLElement): { text: string; nodes: { node: Text; offset: number }[] } {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node instanceof Element)
          return node.matches(blockSelector) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
        // 保留词间空格。HTML 节点之间的排版换行不属于可见文本。
        return node.textContent && !/^\n+$/.test(node.textContent)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      },
    },
  )
  const nodes: { node: Text; offset: number }[] = []
  const chunks: string[] = []
  let offset = 0
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    nodes.push({ node, offset })
    chunks.push(node.data)
    offset += node.length
  }
  return { text: chunks.join(''), nodes }
}

function finish(event: AnimationEvent): void {
  const target = event.target
  if (target instanceof HTMLElement && target.classList.contains(fragmentClass))
    target.replaceWith(...target.childNodes)
}

function paint(replaced: boolean): void {
  const element = root.value
  if (!element || 'text' in props.entry) {
    fading = []
    return
  }
  if (!props.animate || !acceptsStreamMotion()) {
    fading = []
    if (!replaced)
      for (const fragment of element.querySelectorAll(`.${fragmentClass}`))
        fragment.replaceWith(...fragment.childNodes)
    return
  }
  if (!replaced) return

  const { text, nodes } = prose(element)
  const now = performance.now()
  // Worker 重建 HTML 时，保留仍处于渐变中的同一段文字的进度。
  const retained = fading.filter(
    ({ start, end, delay, time }) =>
      now - time - delay < streamFadeDuration &&
      text.slice(start, end) === previousText.slice(start, end),
  )
  // 格式闭合会改变已经显示的文字长度。仅把增长的可见尾部视为新增。
  const incoming = streamFragments(text, previousText.length)
  fading = [...retained.slice(-21), ...incoming.map((fragment) => ({ ...fragment, time: now }))]
  if (!fading.length) return

  // 从后往前切分文本节点，保留链接、强调和列表等元素。
  const ranges = fading.toReversed()
  for (const { node, offset } of nodes.toReversed()) {
    for (const fragment of ranges) {
      const start = Math.max(0, fragment.start - offset)
      const end = Math.min(node.length, fragment.end - offset)
      if (end <= start || !node.data.slice(start, end).trim()) continue
      if (end < node.length) node.splitText(end)
      const content = start > 0 ? node.splitText(start) : node
      const span = document.createElement('span')
      span.className = fragmentClass
      span.style.animationDelay = `${fragment.delay - (now - fragment.time)}ms`
      content.before(span)
      span.append(content)
    }
  }
}

onBeforeUpdate(() => {
  if (root.value && props.animate && replacedMarkup(props.entry))
    previousText = 'text' in drawn ? drawn.text.replaceAll('\n', '') : prose(root.value).text
})
onMounted(() => paint(true))
watch(
  [() => props.entry, () => props.animate],
  ([entry]) => {
    paint(replacedMarkup(entry))
    drawn = entry
  },
  { flush: 'post' },
)
</script>

<template>
  <div v-if="'text' in entry" ref="root" class="markdown-part">
    <StreamParagraph :text="entry.text" :streaming="animate" />
  </div>
  <!-- HTML 在进入此组件前已完成严格允许列表清理。 -->
  <!-- eslint-disable vue/no-v-html -->
  <div
    v-else
    ref="root"
    class="markdown-part"
    @animationend="finish"
    @animationcancel="finish"
    v-html="entry.html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>
