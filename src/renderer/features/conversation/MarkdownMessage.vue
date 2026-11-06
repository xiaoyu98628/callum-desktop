<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { ContentBlock } from '@shared/chat'
import { parseWebLink } from '@shared/message-actions'
import { getDesktopApi } from '@/lib/desktop'
import { sanitizeMarkdown } from './markdown/sanitize'
import type { MarkdownDocument } from './markdown/contract'
import { useMarkdownRenderer } from './markdown/useMarkdownRenderer'
import './markdown/markdown.css'

const props = defineProps<{ content: ContentBlock[]; streaming: boolean }>()
const emit = defineEmits<{ rendered: [] }>()
const renderer = useMarkdownRenderer()
const root = ref<HTMLElement | null>(null)
const rendered = shallowRef<MarkdownDocument | null>(null)
const notice = ref(''),
  actionError = ref('')
const busyCopies = new Set<number>()
const copiedCodes = new Map<number, string>()
const texts = computed(() =>
  props.content.map((block) => (block.type === 'text' ? block.text : '')),
)
let client: ReturnType<typeof renderer.register> | undefined
let renderFrame: number | undefined
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let rawDocument: MarkdownDocument | null = null
let disposed = false,
  previous: string[] = []
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
  // 内容回滚、工具轮次替换或块结构变化时立即清除旧排版，不能把旧回答当成新内容。
  if (
    current.length !== previous.length ||
    current.some((text, index) => !text.startsWith(previous[index] ?? ''))
  ) {
    client?.invalidate()
    rendered.value = null
    rawDocument = null
  }
  previous = [...current]
  notice.value = ''
  if (!props.streaming) render()
  else if (renderFrame === undefined) renderFrame = requestAnimationFrame(render)
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
        } else {
          if (
            result.texts.length !== texts.value.length ||
            result.texts.some((text, index) => !texts.value[index]?.startsWith(text))
          )
            return
          rendered.value = {
            html: result.document.html.map((parts, index) =>
              parts.map((html, part) =>
                rawDocument?.html[index]?.[part] === html
                  ? (rendered.value?.html[index]?.[part] ?? sanitizeMarkdown(html))
                  : sanitizeMarkdown(html),
              ),
            ),
            codes: result.document.codes,
          }
          rawDocument = result.document
          notice.value = ''
        }
      } catch {
        rendered.value = null
        notice.value = '消息排版失败，已按文本显示。'
      }
      void nextTick(() => {
        if (disposed) return
        syncCodeButtons()
        restoreView(view)
        emit('rendered')
      })
    })
    update()
  } catch {
    notice.value = '消息较多，已按文本显示。'
  }
})
watch([texts, () => props.streaming], update, { flush: 'post' })
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
  <div ref="root" class="markdown-message" @click="act" @auxclick.prevent>
    <template v-for="(block, index) in content" :key="index">
      <!-- HTML 已经过严格允许列表清理；原始模型 HTML 在解析阶段也被禁用。 -->
      <!-- eslint-disable vue/no-v-html -->
      <div v-if="block.type === 'text' && rendered?.html[index]?.length" class="message-markdown">
        <div
          v-for="(html, part) in rendered.html[index]"
          :key="part"
          class="markdown-part"
          v-html="html"
        />
      </div>
      <!-- eslint-enable vue/no-v-html -->
      <p v-else-if="block.type === 'text'" class="markdown-plain-text">
        {{ block.text }}
      </p>
      <p v-else class="text-sm leading-7 text-muted-foreground">
        [{{ block.type === 'image' ? '图片' : '暂不支持展示的内容' }}] {{ block.path }}
      </p>
    </template>
    <p v-if="notice" class="mt-2 text-xs text-muted-foreground">{{ notice }}</p>
    <p v-if="actionError" role="alert" class="mt-2 text-xs text-destructive">{{ actionError }}</p>
  </div>
</template>
