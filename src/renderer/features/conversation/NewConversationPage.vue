<script setup lang="ts">
import { ArrowUpIcon, SparklesIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
</script>

<template>
  <section
    class="mx-auto flex min-h-full max-w-4xl flex-col items-center justify-center px-8 py-12 lg:px-14"
    aria-labelledby="new-conversation-title"
  >
    <div
      class="mb-7 flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-accent text-primary"
    >
      <SparklesIcon class="size-7" aria-hidden="true" />
    </div>
    <h1 id="new-conversation-title" class="text-center text-3xl font-semibold tracking-tight">
      开始一段新对话
    </h1>
    <p class="mt-4 text-center text-sm leading-7 text-muted-foreground">每个想法，都从这里开始。</p>

    <div
      class="mt-9 w-full rounded-2xl border bg-card p-4 shadow-[0_8px_40px_-24px_rgba(30,25,60,0.2)]"
    >
      <label for="new-message" class="sr-only">消息</label>
      <textarea
        id="new-message"
        rows="3"
        disabled
        aria-describedby="conversation-availability"
        placeholder="你想聊些什么？"
        class="block min-h-28 w-full resize-none border-0 bg-transparent px-1 py-2 text-sm leading-7 text-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
      ></textarea>
      <div class="mt-3 flex justify-end border-t pt-3">
        <Button
          size="icon"
          class="size-8 rounded-lg"
          disabled
          aria-label="发送消息"
          aria-describedby="conversation-availability"
        >
          <ArrowUpIcon class="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
    <p
      id="conversation-availability"
      class="mt-4 text-center text-xs leading-6 text-muted-foreground"
    >
      对话功能尚未开放，暂不可发送消息。
    </p>
  </section>
</template>
