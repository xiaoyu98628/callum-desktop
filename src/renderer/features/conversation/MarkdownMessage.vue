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
const texts = computed(() =>
  props.content.map((block) => (block.type === 'text' ? block.text : '')),
)
let client: ReturnType<typeof renderer.register> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false,
  previous: string[] = []
function render(): void {
  clearTimeout(timer)
  timer = undefined
  client?.render(texts.value)
}
function update(): void {
  // 立即废弃旧任务，即使下一次解析因流式节流而延后，迟到结果也不能恢复被替换的正文。
  client?.invalidate()
  const current = texts.value
  // 内容回滚、工具轮次替换或块结构变化时立即清除旧排版，不能把旧回答当成新内容。
  if (
    current.length !== previous.length ||
    current.some((text, index) => !text.startsWith(previous[index] ?? ''))
  )
    rendered.value = null
  previous = [...current]
  notice.value = ''
  if (!props.streaming) render()
  else if (timer === undefined) timer = setTimeout(render, 100)
}
onMounted(() => {
  try {
    client = renderer.register((result) => {
      if (disposed) return
      try {
        if ('error' in result) {
          rendered.value = null
          notice.value = result.error
        } else {
          rendered.value = {
            html: result.document.html.map(sanitizeMarkdown),
            codes: result.document.codes,
          }
          notice.value = ''
        }
      } catch {
        rendered.value = null
        notice.value = '消息排版失败，已按文本显示。'
      }
      void nextTick(() => {
        if (!disposed) emit('rendered')
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
    button.disabled = true
    actionError.value = ''
    try {
      const result = await getDesktopApi().copyCode(code)
      if (!result.ok) throw new Error(result.error)
      if (disposed) return
      if (!disposed && button.isConnected) {
        button.textContent = '已复制'
        button.setAttribute('aria-label', '代码已复制')
      }
      clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => {
        if (disposed || !root.value) return
        for (const current of root.value.querySelectorAll('button[data-copy-code]')) {
          current.textContent = '复制'
          current.setAttribute('aria-label', '复制代码')
        }
      }, 1800)
    } catch {
      if (!disposed) actionError.value = '代码复制失败，请重试。'
    } finally {
      busyCopies.delete(index)
      if (!disposed && button.isConnected) button.disabled = false
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
  clearTimeout(timer)
  clearTimeout(copiedTimer)
  client?.dispose()
  busyCopies.clear()
})
</script>

<template>
  <div ref="root" class="min-w-0" @click="act" @auxclick.prevent>
    <template v-for="(block, index) in content" :key="index">
      <!-- HTML 已经过严格允许列表清理；原始模型 HTML 在解析阶段也被禁用。 -->
      <!-- eslint-disable vue/no-v-html -->
      <div
        v-if="block.type === 'text' && rendered?.html[index]"
        class="message-markdown"
        v-html="rendered.html[index]"
      />
      <!-- eslint-enable vue/no-v-html -->
      <p
        v-else-if="block.type === 'text'"
        class="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]"
      >
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
