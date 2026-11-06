<script setup lang="ts">
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from '@lucide/vue'
import { useAppearance } from './useAppearance'
import type { ThemePreference } from './useAppearance'

const { preference, setPreference, storageError } = useAppearance()
const options = [
  { value: 'system', label: '跟随系统', description: '随系统自动切换', icon: MonitorIcon },
  { value: 'light', label: '浅色', description: '明亮、轻盈的工作空间', icon: SunIcon },
  { value: 'dark', label: '深色', description: '适合暗光环境', icon: MoonIcon },
] as const satisfies ReadonlyArray<{
  value: ThemePreference
  label: string
  description: string
  icon: unknown
}>
</script>

<template>
  <section class="min-w-0" aria-labelledby="appearance-title">
    <h2 id="appearance-title" class="text-base font-semibold tracking-tight">外观</h2>
    <p class="mt-2 text-xs leading-6 text-muted-foreground">选择适合你的界面主题。</p>

    <div class="mt-6 rounded-2xl border bg-card p-6">
      <h3 class="text-sm font-semibold">界面主题</h3>
      <p class="mt-2 text-xs leading-6 text-muted-foreground">
        跟随系统，或为当前设备选择适合的外观。
      </p>

      <fieldset class="mt-6 grid grid-cols-3 gap-4">
        <legend class="sr-only">界面主题</legend>
        <label v-for="option in options" :key="option.value" class="group relative min-w-0">
          <input
            type="radio"
            name="appearance"
            class="peer sr-only"
            :value="option.value"
            :checked="preference === option.value"
            @change="setPreference(option.value)"
          />
          <div
            class="rounded-xl border-2 border-transparent bg-muted/35 p-2 transition-colors group-hover:bg-muted/60 peer-checked:border-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ring"
          >
            <div
              class="relative flex aspect-[1.4] overflow-hidden rounded-lg border border-black/10"
              :class="
                option.value === 'dark'
                  ? 'bg-[#202127]'
                  : option.value === 'light'
                    ? 'bg-[#fff]'
                    : 'bg-[linear-gradient(120deg,#fff_50%,#202127_50%)]'
              "
              aria-hidden="true"
            >
              <div class="w-1/4 border-r border-black/10 bg-black/5 p-2">
                <div class="mb-3 size-3 rounded bg-[#a595e8]"></div>
                <div class="mb-1.5 h-1 rounded bg-[#9a9aa4]/35"></div>
                <div class="h-1 rounded bg-[#9a9aa4]/25"></div>
              </div>
              <div class="flex-1 px-3 py-5">
                <div class="mb-3 h-1.5 w-2/3 rounded bg-[#9a9aa4]/45"></div>
                <div class="mb-1.5 h-1 w-full rounded bg-[#9a9aa4]/20"></div>
                <div class="h-1 w-3/4 rounded bg-[#9a9aa4]/20"></div>
                <div class="mt-4 h-3.5 w-9 rounded bg-[#a595e8]"></div>
              </div>
            </div>
          </div>
          <div class="mt-3 flex items-center gap-2">
            <component
              :is="option.icon"
              class="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span class="text-xs font-medium">{{ option.label }}</span>
            <CheckIcon
              v-if="preference === option.value"
              class="ml-auto size-3.5 text-primary"
              aria-hidden="true"
            />
          </div>
          <p class="mt-1.5 text-[11px] leading-5 text-muted-foreground">{{ option.description }}</p>
        </label>
      </fieldset>
    </div>

    <p
      class="mt-5 text-xs leading-6 text-muted-foreground"
      :role="storageError ? 'status' : undefined"
    >
      {{
        storageError
          ? '当前无法保存外观设置，变更仅应用于此窗口。'
          : '外观设置自动保存在这台设备上。'
      }}
    </p>
  </section>
</template>
