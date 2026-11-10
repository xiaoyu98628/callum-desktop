import { array, id, record, isActiveRun, parseConversationHistory } from '../../shared/chat.ts'
import type { ChatRun, ChatStep, ConversationHistory } from '../../shared/chat.ts'
import { messageFromRpc, runFromRpc, stepFromRpc } from './protocol-mapper.ts'
import { compactionOutcome, isManualCompactionStep } from '../../shared/manual-compaction.ts'
import { readStepDetails } from './step-data.ts'

type Request = (method: string, params: unknown) => Promise<unknown>

/** 只读历史适配：执行和消息共用服务端游标，压缩分类不持有传输或活动任务。 */
export class ConversationHistoryReader {
  private readonly request: Request
  private readonly cachedRun: (id: string) => ChatRun | undefined
  private readonly firstStep: (id: string) => ChatStep | undefined
  constructor(
    request: Request,
    cachedRun: (id: string) => ChatRun | undefined,
    firstStep: (id: string) => ChatStep | undefined,
  ) {
    this.request = request
    this.cachedRun = cachedRun
    this.firstStep = firstStep
  }
  async page(conversationId: string, beforeRunId = ''): Promise<ConversationHistory> {
    const value = record(
      await this.request('conversation.history', {
        conversation_id: id(conversationId),
        before_run_id: beforeRunId || undefined,
        limit: 25,
      }),
    )
    const rows = array(value.runs, record)
    if (rows.length > 25) throw new Error('历史执行页超出限制')
    const runs = await this.compactionRuns(conversationId, rows)
    return parseConversationHistory({
      messages: array(value.messages, messageFromRpc),
      runs,
      beforeRunId: value.before_run_id,
      hasMore: value.has_more,
      revision: 0,
    })
  }
  async compactionRuns(
    conversationId: string,
    rows: Record<string, unknown>[],
  ): Promise<ChatRun[]> {
    const result: ChatRun[] = []
    // 手动压缩不创建消息且不使用流式回答。每批最多四次首步骤查询，避免历史读取无界并发。
    for (let offset = 0; offset < rows.length; offset += 4) {
      result.push(
        ...(await Promise.all(
          rows.slice(offset, offset + 4).map(async (value) => {
            const run = runFromRpc(value)
            if (run.conversationId !== conversationId) throw new Error('执行会话归属不匹配')
            const cached = this.cachedRun(run.id)
            if (cached?.compaction && isActiveRun(run))
              return { ...run, compaction: cached.compaction }
            if (value.stream !== false) return run
            let first = this.firstStep(run.id)
            if (!first) {
              const steps = array(
                await this.request('step.list', { run_id: run.id, after_sequence: 0, limit: 1 }),
                stepFromRpc,
              )
              first = steps[0]
            }
            if (first && (first.runId !== run.id || first.conversationId !== conversationId))
              throw new Error('压缩步骤归属不匹配')
            if (!first || !isManualCompactionStep(first)) return run
            const compaction: NonNullable<ChatRun['compaction']> = {
              stepId: first.id,
              outcome: null,
              error: null,
            }
            if (run.status === 'completed') {
              try {
                compaction.outcome = compactionOutcome(
                  await readStepDetails((method, params) => this.request(method, params), first),
                )
              } catch {
                compaction.outcome = 'unknown'
                compaction.error = '无法读取压缩结果，请重新读取。'
              }
            }
            return { ...run, compaction }
          }),
        )),
      )
    }
    return result
  }
}
