<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { ContentBlock } from '@shared/chat'
import { parseWebLink } from '@shared/message-actions'
import { getDesktopApi } from '@/lib/desktop'
import type { MarkdownDocument } from './markdown/contract'
import { markdownPart, previewParts, type MarkdownPart } from './markdown/stream-preview'
import { streamFadeDuration, streamFadeEasing } from './markdown/stream-fade'
import { useMarkdownRenderer } from './markdown/useMarkdownRenderer'
import StreamMarkdownPart from './markdown/StreamMarkdownPart.vue'
import './markdown/markdown.css'

const props = defineProps<{ content: ContentBlock[]; streaming: boolean; completed?: boolean }>()
const emit = defineEmits<{ rendered: [] }>()
const renderer = useMarkdownRenderer()
const root = ref<HTMLElement | null>(null)
const rendered = shallowRef<{ codes: string[]; texts: string[]; parts: MarkdownPart[][] } | null>(
  null,
)
const keepPreview = ref(props.streaming)
const streamedHere = ref(props.streaming)
const animateTail = computed(
  () => props.streaming || (streamedHere.value && props.completed === true),
)
const notice = ref(''),
  actionError = ref('')
const busyCopies = new Set<number>()
const copiedCodes = new Map<number, string>()
const texts = computed(() =>
  props.content.map((block) => (block.type === 'text' ? block.text : '')),
)
const initialTexts = texts.value
const displayed = computed(() =>
  texts.value.map((text, index) => {
    const parts = rendered.value?.parts[index] ?? []
    return keepPreview.value && !notice.value
      ? previewParts(parts, rendered.value?.texts[index] ?? '', text)
      : parts
  }),
)
let client: ReturnType<typeof renderer.register> | undefined
let renderFrame: number | undefined
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let rawDocument: MarkdownDocument | null = null
let disposed = false,
  previous = initialTexts
function captureView() {
  const focused = document.activeElement
  const scrolling = Array.from(
    root.value?.querySelectorAll('pre, .markdown-table-wrap') ?? [],
    (element) => ({
      text: element.textContent ?? '',
      left: element.scrollLeft,
      focused: element === focused,
    }),
  )
  const copyIndex =
    focused instanceof HTMLButtonElement && root.value?.contains(focused)
      ? Number(focused.dataset.copyCode)
      : NaN
  return { scrolling, focused, copyIndex, code: rendered.value?.codes[copyIndex] }
}
function restoreView(view: ReturnType<typeof captureView>): void {
  const lostFocus =
    view.focused && !view.focused.isConnected && document.activeElement === document.body
  root.value
    ?.querySelectorAll<HTMLElement>('pre, .markdown-table-wrap')
    .forEach((element, index) => {
      const previous = view.scrolling[index]
      // 只恢复同一内容的续写，避免工具轮次替换后把旧位置带入新的代码或表格。
      if (previous && element.textContent?.startsWith(previous.text)) {
        element.scrollLeft = previous.left
        if (lostFocus && previous.focused) element.focus({ preventScroll: true })
      }
    })
  // v-html 会替换按钮节点；只有焦点随旧节点丢失时才恢复，不能抢走输入区的焦点。
  if (
    view.focused &&
    !view.focused.isConnected &&
    document.activeElement === document.body &&
    Number.isSafeInteger(view.copyIndex) &&
    view.code !== undefined &&
    rendered.value?.codes[view.copyIndex]?.startsWith(view.code)
  )
    root.value
      ?.querySelector<HTMLButtonElement>(`button[data-copy-code="${view.copyIndex}"]`)
      ?.focus({ preventScroll: true })
}
function syncCodeButtons(): void {
  for (const [index, code] of copiedCodes)
    if (rendered.value?.codes[index] !== code) copiedCodes.delete(index)
  root.value?.querySelectorAll<HTMLButtonElement>('button[data-copy-code]').forEach((button) => {
    const index = Number(button.dataset.copyCode)
    const copied = copiedCodes.has(index)
    const disabled = String(busyCopies.has(index))
    const text = copied ? '已复制' : '复制'
    const label = copied ? '代码已复制' : '复制代码'
    if (button.getAttribute('aria-disabled') !== disabled)
      button.setAttribute('aria-disabled', disabled)
    if (button.textContent !== text) button.textContent = text
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
  })
}
function render(): void {
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame)
  renderFrame = undefined
  client?.render(texts.value)
}
function update(): void {
  const current = texts.value
  const extendsPrevious =
    current.length >= previous.length &&
    previous.every((text, index) => current[index]?.startsWith(text))
  // 内容回滚、工具轮次替换或块结构变化时立即清除旧排版，不能把旧回答当成新内容。
  if (current.length !== previous.length || !extendsPrevious) {
    client?.invalidate()
    rendered.value = null
    rawDocument = null
    notice.value = ''
  }
  previous = current
  if (!props.streaming) render()
  else {
    streamedHere.value = true
    keepPreview.value = true
    if (renderFrame === undefined) renderFrame = requestAnimationFrame(render)
  }
}
onMounted(() => {
  try {
    client = renderer.register((result) => {
      if (disposed) return
      const view = captureView()
      try {
        if ('error' in result) {
          rendered.value = null
          rawDocument = null
          notice.value = result.error
          keepPreview.value = false
        } else {
          if (
            result.texts.length !== texts.value.length ||
            result.texts.some((text, index) => !texts.value[index]?.startsWith(text))
          )
            return
          const previousParts = rendered.value?.parts
          rendered.value = {
            codes: result.document.codes,
            texts: result.texts,
            parts: result.document.html.map((parts, block) =>
              parts.map((html, part) => {
                const previous = previousParts?.[block]?.[part]
                return previous && rawDocument?.html[block]?.[part] === html
                  ? previous
                  : markdownPart(html)
              }),
            ),
          }
          rawDocument = result.document
          notice.value = ''
          if (!props.streaming && result.texts.every((text, index) => text === texts.value[index]))
            keepPreview.value = false
        }
      } catch {
        rendered.value = null
        rawDocument = null
        keepPreview.value = false
        notice.value = '消息排版失败，已按文本显示。'
      }
      void nextTick(() => {
        if (disposed) return
        syncCodeButtons()
        restoreView(view)
      })
    })
    update()
  } catch {
    notice.value = '消息较多，已按文本显示。'
  }
})
watch([texts, () => props.streaming], update)
watch(displayed, () => emit('rendered'), { flush: 'post' })
async function act(event: MouseEvent): Promise<void> {
  if (!(event.target instanceof Element) || !root.value) return
  const button = event.target.closest('button[data-copy-code]')
  if (button instanceof HTMLButtonElement && root.value.contains(button)) {
    event.preventDefault()
    const index = Number(button.dataset.copyCode)
    const code = rendered.value?.codes[index]
    if (!Number.isSafeInteger(index) || index < 0 || code === undefined || busyCopies.has(index))
      return
    busyCopies.add(index)
    button.setAttribute('aria-disabled', 'true')
    actionError.value = ''
    try {
      const result = await getDesktopApi().copyCode(code)
      if (!result.ok) throw new Error(result.error)
      if (disposed) return
      copiedCodes.set(index, code)
      syncCodeButtons()
      clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => {
        copiedCodes.clear()
        if (!disposed) syncCodeButtons()
      }, 1800)
    } catch {
      if (!disposed) actionError.value = '代码复制失败，请重试。'
    } finally {
      busyCopies.delete(index)
      if (!disposed) syncCodeButtons()
    }
    return
  }
  const link = event.target.closest('a')
  if (link instanceof HTMLAnchorElement && root.value.contains(link)) {
    event.preventDefault()
    actionError.value = ''
    try {
      const result = await getDesktopApi().openWebLink(parseWebLink(link.getAttribute('href')))
      if (!result.ok) throw new Error(result.error)
    } catch {
      if (!disposed) actionError.value = '网页链接无法打开，请检查地址后重试。'
    }
  }
}
onScopeDispose(() => {
  disposed = true
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame)
  clearTimeout(copiedTimer)
  client?.dispose()
  busyCopies.clear()
  copiedCodes.clear()
})
</script>

<template>
  <div
    ref="root"
    class="markdown-message"
    :data-streaming="streaming ? '' : undefined"
    :style="{
      '--markdown-stream-duration': `${streamFadeDuration}ms`,
      '--markdown-stream-easing': streamFadeEasing,
    }"
    @click="act"
    @auxclick.prevent
  >
    <template v-for="(block, index) in content" :key="index">
      <div v-if="block.type === 'text' && displayed[index]?.length" class="message-markdown">
        <StreamMarkdownPart
          v-for="(entry, part) in displayed[index]"
          :key="part"
          :entry="entry"
          :animate="animateTail && part >= displayed[index]!.length - 3"
        />
      </div>
      <template v-else-if="block.type === 'text'">
        <p
          v-if="!animateTail || notice || rendered?.texts[index] === block.text"
          class="markdown-plain-text"
        >
          {{ block.text }}
        </p>
      </template>
      <p v-else class="text-sm leading-7 text-muted-foreground">
        [{{ block.type === 'image' ? '图片' : '暂不支持展示的内容' }}] {{ block.path }}
      </p>
    </template>
    <p v-if="notice" class="mt-2 text-xs text-muted-foreground">{{ notice }}</p>
    <p v-if="actionError" role="alert" class="mt-2 text-xs text-destructive">{{ actionError }}</p>
  </div>
</template>
