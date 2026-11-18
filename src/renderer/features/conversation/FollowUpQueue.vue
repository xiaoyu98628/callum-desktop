<script setup lang="ts">
import { ref, watch } from 'vue'
import { ArrowDownIcon, ArrowUpIcon, CornerDownRightIcon, MoreHorizontalIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { FollowUpChange, FollowUpItem } from '@shared/follow-up'
import { MAX_MESSAGE_LENGTH } from '@shared/chat'

const props = defineProps<{
  items: FollowUpItem[]
  active: boolean
  canSteer: boolean
  busy: boolean
  error: string
}>()
const emit = defineEmits<{
  change: [item: FollowUpItem, action: FollowUpChange['action'], text?: string]
  start: [item: FollowUpItem]
}>()
const menu = ref<string | null>(null)
const edit = ref<FollowUpItem | null>(null)
const text = ref('')
const queued = () => props.items.filter((item) => item.state === 'queued')

watch(
  () => props.items,
  (items) => {
    if (
      edit.value &&
      !items.some((item) => item.id === edit.value?.id && item.revision === edit.value?.revision)
    )
      edit.value = null
  },
)

function act(item: FollowUpItem, action: FollowUpChange['action']): void {
  menu.value = null
  if (action === 'edit') {
    edit.value = item
    text.value = item.text
  } else emit('change', item, action)
}

function save(): void {
  if (edit.value) emit('change', edit.value, 'edit', text.value)
}
</script>

<template>
  <section
    v-if="items.length || error"
    class="mx-auto mb-1.5 max-w-3xl rounded-xl border bg-card px-2 py-1.5"
    aria-label="后续消息"
  >
    <ul v-if="items.length" class="max-h-48 space-y-1 overflow-y-auto" aria-label="后续消息队列">
      <li v-for="item in items" :key="item.id" class="rounded-md px-1.5 py-0.5 hover:bg-muted/70">
        <form v-if="edit?.id === item.id" class="space-y-2 py-2" @submit.prevent="save">
          <textarea
            v-model="text"
            aria-label="编辑排队消息"
            :maxlength="MAX_MESSAGE_LENGTH"
            class="w-full resize-y rounded-md border bg-background p-2 text-sm"
            :disabled="busy"
          />
          <div class="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="edit = null"
              >取消</Button
            >
            <Button
              type="submit"
              size="sm"
              :disabled="busy || (!text.trim() && !item.attachments.length)"
              >保存</Button
            >
          </div>
        </form>
        <div v-else class="flex items-center gap-2">
          <CornerDownRightIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm" :title="item.text || item.attachments.join('、')">
              {{
                [item.skill ? '$' + item.skill : '', item.text, ...item.attachments]
                  .filter(Boolean)
                  .join(' · ')
              }}
            </p>
          </div>
          <span
            v-if="item.state === 'steering'"
            class="shrink-0 text-xs text-muted-foreground"
            role="status"
            >等待引导</span
          >
          <template v-else>
            <Button
              v-if="active && canSteer"
              type="button"
              size="sm"
              variant="ghost"
              class="h-7"
              :disabled="busy"
              @click="act(item, 'steer')"
              >引导</Button
            >
            <Button
              v-if="!active && queued()[0]?.id === item.id"
              type="button"
              size="sm"
              variant="ghost"
              class="h-7"
              :disabled="busy"
              @click="$emit('start', item)"
              >发送队列</Button
            >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              class="size-7 shrink-0"
              aria-label="排队消息操作"
              :aria-expanded="menu === item.id"
              :disabled="busy"
              @click="menu = menu === item.id ? null : item.id"
            >
              <MoreHorizontalIcon class="size-4" aria-hidden="true" />
            </Button>
          </template>
        </div>
        <div v-if="menu === item.id" class="flex flex-wrap justify-end gap-1 pb-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="act(item, 'edit')"
            >编辑</Button
          >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            :disabled="busy || queued()[0]?.id === item.id"
            @click="act(item, 'up')"
            ><ArrowUpIcon class="size-3" aria-hidden="true" />上移</Button
          >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            :disabled="busy || queued().at(-1)?.id === item.id"
            @click="act(item, 'down')"
            ><ArrowDownIcon class="size-3" aria-hidden="true" />下移</Button
          >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="act(item, 'remove')"
            >移除</Button
          >
        </div>
      </li>
    </ul>
    <p v-if="error" class="px-2 py-1 text-xs text-destructive" role="alert">{{ error }}</p>
  </section>
</template>
