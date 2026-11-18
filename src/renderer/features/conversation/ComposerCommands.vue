<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpenIcon } from '@lucide/vue'
import { contextPercent, contextRatio } from '@shared/context-usage'
import type { ContextUsage } from '@shared/context-usage'
import ContextUsageRing from './ContextUsageRing.vue'
import { compactCommandId } from './useComposerCommands'
import type { SkillOption } from './useComposerCommands'

const props = defineProps<{
  activeId: string | null
  showCompact: boolean
  disabledReason: string
  busy: boolean
  usage: ContextUsage | null
  skills: SkillOption[]
  skillsLoading: boolean
  skillsFailed: boolean
}>()
const ratio = computed(() => contextRatio(props.usage))
const percent = computed(() => contextPercent(ratio.value))
const description = computed(() =>
  props.busy
    ? '正在受理压缩…'
    : props.disabledReason ||
      `压缩此聊天的上下文（${ratio.value === null ? '用量未知' : `已使用 ${percent.value}`}）`,
)
const skillsStatus = computed(() =>
  props.skillsLoading
    ? '正在读取技能…'
    : props.skillsFailed
      ? '无法读取技能，重新打开菜单可重试。'
      : props.skills.length
        ? ''
        : '没有匹配的已安装技能。',
)
const list = ref<HTMLElement | null>(null)
watch(
  () => props.activeId,
  (id) => {
    if (!list.value || !id) return
    const option = document.getElementById(id)
    if (!option || !list.value.contains(option)) return
    const menu = list.value.getBoundingClientRect()
    const row = option.getBoundingClientRect()
    if (row.top < menu.top) list.value.scrollTop += row.top - menu.top
    else if (row.bottom > menu.bottom) list.value.scrollTop += row.bottom - menu.bottom
  },
  { flush: 'post' },
)
defineEmits<{ select: [id: string] }>()
</script>

<template>
  <div
    ref="list"
    class="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-[min(16rem,40vh)] overflow-y-auto overscroll-contain rounded-lg border border-foreground/10 bg-card p-1 text-card-foreground shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
  >
    <div id="composer-commands" role="listbox" aria-label="命令和技能">
      <button
        v-if="showCompact"
        :id="compactCommandId"
        type="button"
        role="option"
        :aria-selected="activeId === compactCommandId"
        :aria-disabled="!!disabledReason"
        :aria-busy="busy"
        :data-context-percent="ratio === null ? 'unknown' : percent"
        :title="disabledReason || undefined"
        tabindex="-1"
        class="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 outline-none hover:bg-accent/60 aria-disabled:cursor-not-allowed aria-selected:bg-accent/60"
        @mousedown.prevent
        @click="!disabledReason && $emit('select', compactCommandId)"
      >
        <ContextUsageRing :ratio="ratio" class="text-muted-foreground" />
        <span class="shrink-0 text-foreground/75">压缩</span>
        <span data-context-description class="min-w-0 truncate text-muted-foreground/75">{{
          description
        }}</span>
      </button>
      <div role="group" aria-labelledby="composer-skill-label">
        <div
          id="composer-skill-label"
          class="px-2 pt-1 pb-0.5 text-xs leading-4 text-muted-foreground"
        >
          技能
        </div>
        <button
          v-for="skill in skills"
          :id="skill.id"
          :key="skill.path"
          type="button"
          role="option"
          :aria-selected="activeId === skill.id"
          :title="skill.sharedName ? `${skill.description}\n${skill.path}` : skill.description"
          tabindex="-1"
          class="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 outline-none hover:bg-accent/60 aria-selected:bg-accent/60"
          @mousedown.prevent
          @click="$emit('select', skill.id)"
        >
          <BookOpenIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="max-w-[45%] truncate text-foreground">{{ skill.name }}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{{
            skill.sharedName ? `${skill.path} · ${skill.description}` : skill.description
          }}</span>
        </button>
      </div>
    </div>
    <p v-if="skillsStatus" role="status" class="px-2 py-1 text-xs text-muted-foreground">
      {{ skillsStatus }}
    </p>
    <p class="sr-only">方向键选择 · Enter 选择 · Tab 补全 · Esc 关闭</p>
  </div>
</template>
