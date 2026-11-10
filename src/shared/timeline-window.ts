import type { ChatStep, StepPage } from './chat.ts'
import { STEP_PAGE_SIZE, stepTarget, truncateStepText } from './steps.ts'

const PAGE_CACHE_SIZE = 3
const CURSOR_CACHE_SIZE = 128
const OVERVIEW_TEXT_LIMIT = 16 * 1024
const TARGET_LABEL_LIMIT = 240

export interface TimelineStep extends ChatStep {
  targetLabel: string
  compactionTrigger?: 'automatic' | 'manual' | null
}

function compactionTrigger(step: ChatStep): 'automatic' | 'manual' | null {
  if (step.type !== 'context_compression') return null
  try {
    const input: unknown = JSON.parse(step.input)
    if (typeof input !== 'object' || input === null || !('trigger' in input)) return null
    const trigger = input.trigger
    if (typeof trigger !== 'object' || trigger === null || !('type' in trigger)) return null
    return trigger.type === 'automatic' || trigger.type === 'manual' ? trigger.type : null
  } catch {
    // 旧记录或截取的元数据不能被猜测为自动压缩。
    return null
  }
}

function overview(step: ChatStep): TimelineStep {
  const target = stepTarget(step).replace(/[\t\r\n]+/g, ' ')
  return {
    ...step,
    // 概述不持有参数和输出原文；二次展开时通过专用详情接口读取。
    input: '',
    output: '',
    compactionTrigger: compactionTrigger(step),
    targetLabel:
      target.length > TARGET_LABEL_LIMIT
        ? truncateStepText(target, TARGET_LABEL_LIMIT - 1) + '…'
        : target,
    reasoning: truncateStepText(step.reasoning ?? '', OVERVIEW_TEXT_LIMIT),
    reasoningTruncated:
      step.reasoningTruncated || (step.reasoning?.length ?? 0) > OVERVIEW_TEXT_LIMIT,
    text: truncateStepText(step.text, OVERVIEW_TEXT_LIMIT),
    textTruncated: step.textTruncated || step.text.length > OVERVIEW_TEXT_LIMIT,
  }
}

function mergeOverview(old: TimelineStep | undefined, next: TimelineStep): TimelineStep {
  if (!old) return next
  if (next.updatedAt < old.updatedAt) return old
  return {
    ...next,
    targetLabel: next.targetLabel || old.targetLabel,
    compactionTrigger: next.compactionTrigger ?? old.compactionTrigger ?? null,
    reasoning: next.reasoning || old.reasoning || '',
    reasoningTruncated: old.reasoningTruncated || next.reasoningTruncated || false,
    text: next.text || old.text,
    commentary: old.commentary || next.commentary,
    textTruncated: old.textTruncated || next.textTruncated,
  }
}

interface Page {
  after: number
  next: number
  more: boolean
  steps: TimelineStep[]
}

/** 滚动窗口最多保留三批概述，游标缓存有界；原始记录仍由 Go 持久化。 */
export class TimelineWindow {
  private pages: Page[] = []
  private readonly predecessors = new Map<number, number>()
  private readonly conversationId: string
  private readonly runId: string
  private readonly fetch: (after: number) => Promise<StepPage>

  constructor(conversationId: string, runId: string, fetch: (after: number) => Promise<StepPage>) {
    this.conversationId = conversationId
    this.runId = runId
    this.fetch = fetch
  }

  get steps(): TimelineStep[] {
    const all = this.pages.flatMap((page) => page.steps)
    const parents = new Set(all.map((step) => step.parentStepId))
    return all.map((step) => ({ ...step, commentary: step.commentary || parents.has(step.id) }))
  }

  get hasPrevious(): boolean {
    return (this.pages[0]?.after ?? 0) > 0
  }

  get hasMore(): boolean {
    return this.pages.at(-1)?.more ?? false
  }

  get nextSequence(): number {
    return this.pages.at(-1)?.next ?? 0
  }

  private async read(after: number): Promise<Page> {
    const page = await this.fetch(after)
    if (
      page.afterSequence !== after ||
      page.steps.length > STEP_PAGE_SIZE ||
      new Set(page.steps.map((step) => step.id)).size !== page.steps.length ||
      page.steps.some(
        (step, index) =>
          step.runId !== this.runId ||
          step.conversationId !== this.conversationId ||
          step.sequence <= (page.steps[index - 1]?.sequence ?? after),
      ) ||
      page.nextSequence !== (page.steps.at(-1)?.sequence ?? after) ||
      (page.hasMore && !page.steps.length)
    )
      throw new Error('调用记录的归属或读取游标无效')
    return {
      after,
      next: page.nextSequence,
      more: page.hasMore,
      steps: page.steps.map(overview),
    }
  }

  private remember(after: number, previous: number): void {
    this.predecessors.delete(after)
    this.predecessors.set(after, previous)
    if (this.predecessors.size > CURSOR_CACHE_SIZE)
      this.predecessors.delete(this.predecessors.keys().next().value!)
  }

  private retainCommentary(): void {
    const parents = new Set(
      this.pages.flatMap((page) => page.steps.map((step) => step.parentStepId)),
    )
    this.pages = this.pages.map((page) => ({
      ...page,
      steps: page.steps.map((step) => ({
        ...step,
        commentary: step.commentary || parents.has(step.id),
      })),
    }))
  }

  async start(after = 0): Promise<void> {
    const page = await this.read(after)
    this.pages = [page]
    this.retainCommentary()
    this.predecessors.clear()
  }

  async next(): Promise<void> {
    const cursor = this.nextSequence
    const previous = this.pages.at(-1)
    // 活动执行常常一次只新增一两条记录。先补满尾批，避免几个小批次
    // 就耗尽窗口并提前移除仍在阅读的概述；重新查询不清除已恢复的文字。
    const refill = previous && previous.steps.length < STEP_PAGE_SIZE
    const page = await this.read(refill ? previous.after : cursor)
    if (refill) {
      if (
        page.next < cursor ||
        previous.steps.some((step, index) => page.steps[index]?.id !== step.id)
      )
        throw new Error('调用记录的读取游标发生倒退')
      const cached = new Map(previous.steps.map((step) => [step.id, step]))
      page.steps = page.steps.map((step) => mergeOverview(cached.get(step.id), step))
      this.pages = [...this.pages.slice(0, -1), page]
      this.retainCommentary()
      return
    }
    if (!page.steps.length) {
      if (previous) previous.more = false
      return
    }
    if (previous?.steps.length) this.remember(page.after, previous.after)
    this.pages = [...this.pages.filter((entry) => entry.next > entry.after), page].slice(
      -PAGE_CACHE_SIZE,
    )
    this.retainCommentary()
  }

  async previous(): Promise<void> {
    const first = this.pages[0]
    if (!first || !this.hasPrevious) return
    const ceiling = first.steps[0]?.sequence ?? first.after + 1
    let cursor = this.predecessors.get(first.after) ?? 0
    let previous: Page | undefined
    // 查询接口使用正向游标。旧游标被淘汰或从运行尾部进入时，按需定位前一批；
    // 不假定 sequence 连续，不保存整条历史索引，调用方可在每批之间结束读取。
    for (;;) {
      const page = await this.read(cursor)
      const preceding = page.steps.filter((step) => step.sequence < ceiling)
      if (preceding.length)
        previous = { ...page, steps: preceding, next: preceding.at(-1)!.sequence, more: true }
      if (
        page.next >= first.after ||
        page.steps.some((step) => step.sequence >= ceiling) ||
        !page.more
      )
        break
      this.remember(page.next, page.after)
      cursor = page.next
    }
    if (!previous) throw new Error('无法定位调用记录，请重新展开过程')
    this.remember(first.after, previous.after)
    this.pages = [previous, ...this.pages].slice(0, PAGE_CACHE_SIZE)
    this.retainCommentary()
  }

  merge(snapshots: ChatStep[]): void {
    const live = new Map(
      snapshots
        .filter((step) => step.runId === this.runId && step.conversationId === this.conversationId)
        .map((step) => [step.id, step]),
    )
    const parents = new Set([...live.values()].map((step) => step.parentStepId))
    this.pages = this.pages.map((page) => ({
      ...page,
      steps: page.steps.map((old) => {
        const latest = live.get(old.id)
        if (!latest || latest.updatedAt < old.updatedAt)
          return { ...old, commentary: old.commentary || parents.has(old.id) }
        const next = overview(latest)
        return {
          ...mergeOverview(old, next),
          commentary: old.commentary || next.commentary || parents.has(old.id),
        }
      }),
    }))
  }

  setReasoning(id: string, reasoning: string, truncated: boolean): void {
    this.pages = this.pages.map((page) => ({
      ...page,
      steps: page.steps.map((step) =>
        step.id === id
          ? {
              ...step,
              reasoning: truncateStepText(reasoning, OVERVIEW_TEXT_LIMIT),
              reasoningTruncated: truncated || reasoning.length > OVERVIEW_TEXT_LIMIT,
            }
          : step,
      ),
    }))
  }

  setText(id: string, text: string, truncated: boolean): void {
    this.pages = this.pages.map((page) => ({
      ...page,
      steps: page.steps.map((step) =>
        step.id === id
          ? {
              ...step,
              text: truncateStepText(text, OVERVIEW_TEXT_LIMIT),
              textTruncated: truncated || text.length > OVERVIEW_TEXT_LIMIT,
            }
          : step,
      ),
    }))
  }
}
