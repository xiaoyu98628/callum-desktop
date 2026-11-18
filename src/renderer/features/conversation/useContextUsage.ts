import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ContextUsage, ContextUsageInput } from '@shared/context-usage'
import { getDesktopApi } from '@/lib/desktop'

/** 合并草稿与执行通知的刷新；同一组件最多一个请求和一个待执行计时器。 */
export function useContextUsage(
  input: Readonly<Ref<ContextUsageInput | null>>,
  event: Readonly<Ref<ContextUsage | null>>,
  activity: Readonly<Ref<number>>,
  serviceError: Readonly<Ref<string>>,
  visible: Readonly<Ref<boolean>>,
) {
  const value = ref<ContextUsage | null>(null)
  const error = ref('')
  const loading = ref(false)
  let generation = 0,
    disposed = false,
    inFlight = false,
    dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const key = (request: ContextUsageInput | null) => (request ? JSON.stringify(request) : '')

  function refresh(): void {
    if (disposed || !input.value || serviceError.value) return
    loading.value = true
    if (inFlight) {
      dirty = true
      return
    }
    timer ??= setTimeout(() => {
      timer = undefined
      void read()
    }, 150)
  }
  async function read(): Promise<void> {
    const request = input.value
    if (!request || disposed || serviceError.value) return
    const token = generation
    inFlight = true
    dirty = false
    error.value = ''
    try {
      const result = await getDesktopApi().getContextUsage(request)
      if (disposed || token !== generation) return
      if (!result.ok) throw new Error(result.error)
      const next = result.value
      if (next.conversationId !== request.conversationId || next.modelId !== request.modelId)
        throw new Error('上下文统计归属不匹配。')
      if (!value.value || next.snapshotRevision >= value.value.snapshotRevision) value.value = next
      if (next.state === 'refresh_required') dirty = true
    } catch (failure) {
      if (!disposed && token === generation) {
        value.value = null
        error.value = failure instanceof Error ? failure.message : '无法读取上下文用量。'
      }
    } finally {
      inFlight = false
      if (!disposed) {
        if (token === generation) loading.value = false
        if (dirty) refresh()
      }
    }
  }
  watch(
    [() => key(input.value), serviceError],
    (_, previous) => {
      generation++
      clearTimeout(timer)
      timer = undefined
      error.value = serviceError.value
      const oldRequest: ContextUsageInput | null = previous?.[0]
        ? (JSON.parse(previous[0]) as ContextUsageInput)
        : null
      if (
        !input.value ||
        serviceError.value ||
        input.value.conversationId !== oldRequest?.conversationId ||
        input.value.modelId !== oldRequest?.modelId ||
        input.value.workspaceId !== oldRequest?.workspaceId
      )
        value.value = null
      loading.value = false
      dirty = false
      if (input.value && !serviceError.value) refresh()
    },
    { immediate: true },
  )
  watch(activity, refresh)
  watch(event, (next) => {
    const request = input.value
    if (
      !next ||
      !request ||
      serviceError.value ||
      next.conversationId !== request.conversationId ||
      next.modelId !== request.modelId
    )
      return
    if (next.state !== 'refresh_required' && !request.draft.trim() && !request.draftImages) {
      if (!value.value || next.snapshotRevision >= value.value.snapshotRevision) {
        value.value = next
        error.value = ''
      }
    }
    if (next.state === 'refresh_required' || request.draft.trim() || request.draftImages) refresh()
  })
  // 悬停提示与命令候选共用一个可见期计时器，不为两个入口重复查询。
  let polling: ReturnType<typeof setInterval> | undefined
  watch(visible, (shown) => {
    clearInterval(polling)
    polling = undefined
    if (shown) {
      refresh()
      polling = setInterval(refresh, 1000)
    }
  })
  onScopeDispose(() => {
    disposed = true
    generation++
    clearTimeout(timer)
    clearInterval(polling)
  })
  return { value, error, loading, refresh }
}
