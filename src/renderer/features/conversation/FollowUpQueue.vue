<script setup lang="ts">
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownRightIcon,
  MoreHorizontalIcon,
  Trash2Icon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import type { FollowUpChange, FollowUpItem } from '@shared/follow-up'

const props = defineProps<{
  items: FollowUpItem[]
  active: boolean
  canSteer: boolean
  busy: boolean
  error: string
  editing: boolean
}>()
defineEmits<{
  change: [item: FollowUpItem, action: FollowUpChange['action']]
  start: [item: FollowUpItem]
}>()
const queued = () => props.items
</script>

<template>
  <section
    v-if="items.length || error"
    class="rounded-t-2xl border-b border-border/70 bg-muted/35 px-2.5 py-1"
    aria-label="后续消息"
  >
    <ul
      v-if="items.length"
      class="max-h-36 divide-y divide-border/60 overflow-y-auto"
      aria-label="后续消息队列"
    >
      <li v-for="item in items" :key="item.id" class="px-1.5 py-0.5">
        <div class="flex min-h-8 min-w-0 items-center gap-1.5">
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
          <Button
            v-if="active && canSteer"
            type="button"
            size="sm"
            variant="ghost"
            class="h-7 shrink-0 gap-1.5 px-2 text-xs font-medium"
            :disabled="busy"
            @click="$emit('change', item, 'steer')"
          >
            <CornerDownRightIcon class="size-3.5" aria-hidden="true" />
            引导
          </Button>
          <Button
            v-if="!active && queued()[0]?.id === item.id"
            type="button"
            size="sm"
            variant="ghost"
            class="h-7 shrink-0 gap-1.5 px-2 text-xs font-medium"
            :disabled="busy"
            @click="$emit('start', item)"
            >发送队列</Button
          >
          <Button
            type="button"
            size="icon"
            variant="ghost"
            class="size-7 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label="删除排队消息"
            title="删除排队消息"
            :disabled="busy"
            @click="$emit('change', item, 'remove')"
          >
            <Trash2Icon class="size-3.5" aria-hidden="true" />
          </Button>
          <DropdownMenuRoot :modal="false">
            <DropdownMenuTrigger as-child>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                class="size-7 shrink-0 text-muted-foreground"
                aria-label="排队消息操作"
                :disabled="busy"
              >
                <MoreHorizontalIcon class="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent
                align="end"
                side="top"
                :side-offset="6"
                class="z-50 min-w-32 rounded-lg border bg-popover p-1 text-sm shadow-md"
              >
                <DropdownMenuItem
                  class="cursor-default rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
                  :disabled="editing"
                  @select="$emit('change', item, 'withdraw')"
                  >编辑</DropdownMenuItem
                >
                <DropdownMenuItem
                  class="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent"
                  :disabled="queued()[0]?.id === item.id"
                  @select="$emit('change', item, 'up')"
                  ><ArrowUpIcon class="size-3.5" aria-hidden="true" />上移</DropdownMenuItem
                >
                <DropdownMenuItem
                  class="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent"
                  :disabled="queued().at(-1)?.id === item.id"
                  @select="$emit('change', item, 'down')"
                  ><ArrowDownIcon class="size-3.5" aria-hidden="true" />下移</DropdownMenuItem
                >
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
        </div>
      </li>
    </ul>
    <p v-if="error" class="px-2 py-1 text-xs text-destructive" role="alert">{{ error }}</p>
  </section>
</template>
