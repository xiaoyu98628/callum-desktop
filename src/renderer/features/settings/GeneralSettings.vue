<script setup lang="ts">
import { onMounted } from 'vue'
import type { AppInfo } from '@shared/desktop-api'
import { useFollowUpPreference } from './useFollowUpPreference'

defineProps<{ platform?: AppInfo['platform'] | undefined }>()
const { mode, loaded, busy, error, refresh, setMode } = useFollowUpPreference()
onMounted(() => void refresh())
</script>

<template>
  <section aria-labelledby="general-heading" class="min-w-0 space-y-5">
    <h2 id="general-heading" class="text-lg font-semibold">常规</h2>
    <fieldset
      class="rounded-xl border bg-card px-4 py-3"
      aria-labelledby="follow-up-heading"
      :aria-busy="busy"
    >
      <div class="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div>
          <p id="follow-up-heading" class="text-sm font-medium">后续消息处理方式</p>
          <p id="follow-up-help" class="mt-1 text-xs leading-5 text-muted-foreground">
            任务运行时，后续消息可以排队等待，也可以引导当前任务。 用
            <kbd>{{ platform === 'darwin' ? '⌘ Enter' : 'Ctrl + Enter' }}</kbd> 对单条消息切换方式。
          </p>
        </div>
        <div class="inline-flex gap-1 rounded-lg bg-muted p-1" aria-describedby="follow-up-help">
          <label
            v-for="option in [
              { value: 'queue', label: '排队' },
              { value: 'steer', label: '引导' },
            ] as const"
            :key="option.value"
            class="cursor-pointer rounded-md px-3 py-1 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-default has-[:disabled]:opacity-60"
            :class="
              loaded && mode === option.value
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            "
          >
            <input
              type="radio"
              name="follow-up-mode"
              class="sr-only"
              :checked="loaded && mode === option.value"
              :disabled="busy || !loaded"
              @click.prevent="setMode(option.value)"
            />
            {{ option.label }}
          </label>
        </div>
      </div>
      <div v-if="error" class="mt-2 flex items-center gap-3 text-xs text-destructive">
        <p role="status">{{ error }}</p>
        <button type="button" class="underline" :disabled="busy" @click="refresh">重新读取</button>
      </div>
    </fieldset>
  </section>
</template>
