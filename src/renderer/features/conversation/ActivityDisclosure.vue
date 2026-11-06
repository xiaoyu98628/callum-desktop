<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import './activity.css'

const props = withDefaults(
  defineProps<{
    expanded: boolean
    label?: string
    ariaLabel?: string
    contentLabel?: string
    collapsible?: boolean
    showHeader?: boolean
    headerSeparator?: boolean
  }>(),
  {
    collapsible: true,
    showHeader: true,
    headerSeparator: false,
    label: '',
    ariaLabel: '',
    contentLabel: '',
  },
)
const emit = defineEmits<{ toggle: []; changed: []; collapsed: [] }>()
const panelId = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)

// 自动收起时仅恢复组件内部的键盘焦点，不激活原生窗口，也不滚动页面。
watch(
  () => props.expanded,
  (expanded) => {
    if (!expanded && panel.value?.contains(document.activeElement))
      void nextTick(() => trigger.value?.focus({ preventScroll: true }))
  },
)
function beforeEnter(element: Element): void {
  if (element instanceof HTMLElement) element.inert = false
}
function beforeLeave(element: Element): void {
  if (element instanceof HTMLElement) element.inert = true
}
function collapsed(): void {
  emit('collapsed')
  emit('changed')
}
</script>

<template>
  <div class="activity-disclosure" :data-expanded="expanded">
    <template v-if="showHeader">
      <button
        v-if="collapsible"
        ref="trigger"
        type="button"
        class="activity-heading activity-trigger"
        :aria-label="ariaLabel || undefined"
        :aria-expanded="expanded"
        :aria-controls="panelId"
        @click="emit('toggle')"
      >
        <span class="activity-label"
          ><slot name="label">{{ label }}</slot></span
        >
        <svg
          class="activity-chevron"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m8 4.25 5.75 5.75L8 15.75"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <div v-else class="activity-heading">
        <span class="activity-label"
          ><slot name="label">{{ label }}</slot></span
        >
      </div>
    </template>
    <div v-if="showHeader && headerSeparator" class="activity-separator" aria-hidden="true" />
    <Transition
      name="activity-reveal"
      @before-enter="beforeEnter"
      @before-leave="beforeLeave"
      @after-enter="emit('changed')"
      @after-leave="collapsed"
    >
      <div v-if="expanded" :id="panelId" ref="panel" class="activity-body">
        <div class="activity-body-clip">
          <div :role="contentLabel ? 'region' : undefined" :aria-label="contentLabel || undefined">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
