<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref, watch } from 'vue'
import { ImageIcon, ImageOffIcon, LoaderCircleIcon } from '@lucide/vue'
import type { AttachmentItem } from './attachment-files'
import { attachmentPreviewsKey } from './attachment-previews'

const props = defineProps<{ item: AttachmentItem; compact?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const previews = inject(attachmentPreviewsKey)
if (!previews) throw new Error('图片预览服务未初始化')
const root = ref<HTMLElement | null>(null)
const source = ref(''),
  loading = ref(false),
  error = ref('')
const key = computed(() => previews.key(props.item))
const dimensions = ref<{ width: number; height: number } | null>(null)
const frame = computed(() => {
  const maxWidth = props.compact ? 80 : 128
  const maxHeight = props.compact ? 80 : 96
  // 按最大范围占位，解码后只收缩，避免多图换行时把编辑按钮向下推走。
  if (!dimensions.value) return { width: `${maxWidth}px`, height: `${maxHeight}px` }
  const ratio = Math.min(maxWidth / dimensions.value.width, maxHeight / dimensions.value.height)
  // 极窄图片保留最小点击区域，正常横竖图的外框跟随原有比例。
  return {
    width: `${Math.max(32, Math.round(dimensions.value.width * ratio))}px`,
    height: `${Math.max(32, Math.round(dimensions.value.height * ratio))}px`,
  }
})
function measure(event: Event): void {
  const image = event.currentTarget
  if (
    !(image instanceof HTMLImageElement) ||
    !source.value ||
    image.src !== source.value ||
    !image.naturalWidth ||
    !image.naturalHeight
  )
    return
  if (
    dimensions.value?.width === image.naturalWidth &&
    dimensions.value.height === image.naturalHeight
  )
    return
  dimensions.value = { width: image.naturalWidth, height: image.naturalHeight }
  emit('changed')
}
let visible = false,
  revision = 0
let observer: IntersectionObserver | undefined
let controller: AbortController | undefined
function clear(): void {
  revision++
  controller?.abort()
  source.value = ''
  loading.value = false
  error.value = ''
}
async function load(): Promise<void> {
  clear()
  if (!visible) return
  const current = revision
  const request = new AbortController()
  controller = request
  loading.value = true
  try {
    const url = await previews!.thumbnail(props.item, request.signal)
    if (!request.signal.aborted && current === revision) source.value = url
  } catch (cause) {
    if (!request.signal.aborted && current === revision)
      error.value = cause instanceof Error ? cause.message : '无法加载缩略图。'
  } finally {
    if (current === revision) loading.value = false
  }
}
watch(key, () => {
  dimensions.value = null
  void load()
})
onMounted(() => {
  observer = new IntersectionObserver(
    ([entry]) => {
      const next = entry?.isIntersecting === true
      if (visible === next) return
      visible = next
      void load()
    },
    { rootMargin: '120px' },
  )
  if (root.value) observer.observe(root.value)
})
onScopeDispose(() => {
  observer?.disconnect()
  clear()
})
</script>

<template>
  <span
    ref="root"
    class="flex items-center justify-center overflow-hidden"
    :style="frame"
    :aria-busy="loading"
  >
    <img
      v-if="source && !error"
      :src="source"
      :alt="item.label"
      class="size-full object-contain"
      decoding="async"
      @load="measure"
      @error="error = '图片无法显示。'"
    />
    <span
      v-else-if="error"
      class="flex flex-col items-center gap-1 px-1 text-[10px] text-muted-foreground"
      :title="error"
    >
      <ImageOffIcon class="size-4" aria-hidden="true" />无法加载
    </span>
    <LoaderCircleIcon
      v-else-if="loading"
      class="size-4 animate-spin text-muted-foreground"
      aria-label="正在加载缩略图"
    />
    <ImageIcon v-else class="size-4 text-muted-foreground" aria-hidden="true" />
  </span>
</template>
