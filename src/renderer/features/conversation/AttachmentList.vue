<script setup lang="ts">
import { inject, onScopeDispose, ref, watch } from 'vue'
import { XIcon, FileTextIcon, DownloadIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { AttachmentItem } from './attachment-files'
import { isImageAttachment } from './attachment-files'
import AttachmentThumbnail from './AttachmentThumbnail.vue'
import { attachmentPreviewsKey } from './attachment-previews'

const props = defineProps<{
  items: AttachmentItem[]
  removable?: boolean
  disabled?: boolean
  downloadable?: boolean
  saving?: boolean
}>()
const emit = defineEmits<{ remove: [index: number]; changed: []; save: [item: AttachmentItem] }>()
const previews = inject(attachmentPreviewsKey)
if (!previews) throw new Error('图片预览服务未初始化')
const modal = ref<HTMLDialogElement | null>(null)
const title = ref('')
const url = ref('')
const loading = ref(false)
const error = ref('')
let revision = 0
let controller: AbortController | undefined
let selected: AttachmentItem | null = null

function fileKilobytes(item: AttachmentItem): number {
  return Math.ceil((item.size ?? (item.source instanceof File ? item.source.size : 0)) / 1024)
}

async function preview(item: AttachmentItem): Promise<void> {
  if (!modal.value) return
  clear()
  const current = revision
  const request = new AbortController()
  controller = request
  selected = item
  title.value = item.label
  url.value = ''
  error.value = ''
  loading.value = true
  if (!modal.value.open) modal.value.showModal()
  try {
    const result = await previews!.full(item, request.signal)
    if (request.signal.aborted || current !== revision || !modal.value?.open) return
    url.value = `data:${result.mime};base64,${result.data}`
  } catch (failure) {
    if (!request.signal.aborted && current === revision)
      error.value = failure instanceof Error ? failure.message : '无法预览图片。'
  } finally {
    if (current === revision) loading.value = false
  }
}
function clear(): void {
  revision++
  controller?.abort()
  selected = null
  url.value = ''
  loading.value = false
  error.value = ''
}
watch(
  () => props.items.map((item) => previews.key(item)),
  (keys) => {
    if (selected && !keys.includes(previews.key(selected))) {
      modal.value?.close()
      clear()
    }
  },
)
onScopeDispose(() => {
  modal.value?.close()
  clear()
})
</script>

<template>
  <ul
    v-if="items.length"
    :aria-label="items.every(isImageAttachment) ? '图片附件' : '附件'"
    class="my-1 flex max-w-full flex-wrap items-start gap-2"
  >
    <li
      v-for="(item, index) in items"
      :key="`${previews.key(item)}:${index}`"
      class="group/attachment relative shrink-0"
    >
      <button
        v-if="isImageAttachment(item)"
        type="button"
        class="block overflow-hidden rounded-lg border-0 bg-transparent p-0 ring-1 ring-inset ring-border/50 transition-shadow hover:ring-foreground/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        :title="item.label"
        :aria-label="item.label"
        @click="preview(item)"
      >
        <AttachmentThumbnail :item="item" :compact="!removable" @changed="emit('changed')" />
      </button>
      <div
        v-else
        role="group"
        :aria-label="item.label"
        class="flex h-14 max-w-60 min-w-40 items-center gap-2 rounded-lg border bg-muted/30 px-3"
      >
        <FileTextIcon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="min-w-0">
          <p class="truncate text-xs" :title="item.label">{{ item.label }}</p>
          <p class="mt-0.5 text-[10px] text-muted-foreground">
            {{ fileKilobytes(item) }} KB · 文件
          </p>
        </div>
        <Button
          v-if="downloadable && !removable"
          type="button"
          variant="ghost"
          size="icon"
          class="ml-auto size-7 shrink-0"
          :aria-label="`另存为${item.label}`"
          :disabled="saving"
          @click="emit('save', item)"
        >
          <DownloadIcon class="size-4" aria-hidden="true" />
        </Button>
      </div>
      <Button
        v-if="removable"
        type="button"
        variant="ghost"
        size="icon"
        class="absolute -right-1 -top-1 z-10 size-5 rounded-full border bg-card p-0 opacity-0 shadow-sm group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 pointer-coarse:opacity-100"
        :aria-label="`移除${item.label}`"
        :disabled="disabled"
        @click="emit('remove', index)"
      >
        <XIcon class="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  </ul>
  <Teleport to="body">
    <dialog
      ref="modal"
      aria-label="图片预览"
      class="fixed inset-0 m-auto max-h-[90vh] w-max min-w-72 max-w-[92vw] rounded-xl border bg-card p-4 text-foreground shadow-xl backdrop:bg-black/60"
      @close="clear"
    >
      <div class="mb-3 flex items-center justify-between gap-3">
        <p class="max-w-[70vw] truncate text-sm font-medium">{{ title }}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-7 shrink-0"
          aria-label="关闭预览"
          @click="modal?.close()"
        >
          <XIcon class="size-4" aria-hidden="true" />
        </Button>
      </div>
      <p v-if="loading" role="status" class="text-sm text-muted-foreground">正在读取图片…</p>
      <div v-else-if="error" class="space-y-3">
        <p role="alert" class="text-sm text-destructive">{{ error }}</p>
        <Button v-if="selected" type="button" variant="outline" size="sm" @click="preview(selected)"
          >重试加载</Button
        >
      </div>
      <img
        v-else-if="url"
        :src="url"
        :alt="title"
        class="max-h-[75vh] max-w-full object-contain"
        @error="error = '图片无法显示。'"
      />
    </dialog>
  </Teleport>
</template>
