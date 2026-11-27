import type { ChatMessage, ChatRun, ChatStep } from '../../shared/chat.ts'
import { array, id, isActiveRun, MAX_REASONING_BYTES, record, string } from '../../shared/chat.ts'
import { isManualCompactionStep } from '../../shared/manual-compaction.ts'
import { boundSteps, STEP_TEXT_LIMIT, truncateStepText } from '../../shared/steps.ts'
import type { ChatEventHistory } from './chat-event-history.ts'
import {
  appendDelta,
  approvalFromRpc,
  contextUsageFromRpc,
  conversationFromRpc,
  directoryGrantFromRpc,
  messageFromRpc,
  runFromRpc,
  stepFromRpc,
  userInputFromRpc,
} from './protocol-mapper.ts'
import { StepOutput } from './step-data.ts'

/** 持有活动执行的增量状态；只发布业务快照，不管理 RPC 连接或窗口。 */
export class LiveExecutionState {
  readonly messages = new Map<string, ChatMessage>()
  readonly runs = new Map<string, ChatRun>()
  private readonly dirty = new Map<string, ChatMessage>()
  readonly steps = new Map<string, ChatStep>()
  private readonly dirtySteps = new Map<string, ChatStep>()
  private readonly stepOutputs = new Map<string, StepOutput>()
  readonly persistenceFailures = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly events: ChatEventHistory
  private readonly dispatchFollowUp: (run: ChatRun) => Promise<void>
  constructor(events: ChatEventHistory, dispatchFollowUp: (run: ChatRun) => Promise<void>) {
    this.events = events
    this.dispatchFollowUp = dispatchFollowUp
  }
  saveStep(step: ChatStep): void {
    this.steps.delete(step.id)
    this.steps.set(step.id, step)
    const retained = new Set(boundSteps([...this.steps.values()]).map((value) => value.id))
    for (const key of this.steps.keys())
      if (!retained.has(key)) {
        this.steps.delete(key)
        this.dirtySteps.delete(key)
        this.stepOutputs.delete(key)
      }
  }
  receive(method: string, value: unknown): void {
    const p = record(value)
    if (method === 'conversation.steering_requeued') {
      this.events.publish({
        kind: 'messages-removed',
        value: {
          id: id(p.run_id),
          conversationId: id(p.conversation_id),
          messageIds: array(p.removed_message_ids, id),
          steeringRequeued: true,
        },
      })
    } else if (method === 'conversation.follow_ups_updated') {
      const conversationId = id(p.conversation_id)
      this.events.publish({ kind: 'follow-ups', value: { id: conversationId, conversationId } })
    } else if (method === 'conversation.context_usage.updated') {
      const value = contextUsageFromRpc(p.context_usage)
      if (value.conversationId !== id(p.conversation_id) || value.runId !== id(p.run_id))
        throw new Error('上下文占用通知归属不匹配')
      this.events.publish({ kind: 'context-usage', value })
    } else if (method === 'conversation.created' || method === 'conversation.updated') {
      this.events.publish({ kind: 'conversation', value: conversationFromRpc(p.conversation) })
    } else if (method === 'message.created' || method === 'message.updated') {
      const message = messageFromRpc(p.message)
      this.checkOwner(p, message)
      if (message.steeringOrder === undefined) {
        this.messages.set(message.id, message)
        this.dirty.delete(message.id)
      }
      this.events.publish({ kind: 'message', value: message })
    } else if (method === 'step.created' || method === 'step.updated') {
      let step = stepFromRpc(p.step)
      if (
        step.id !== id(p.step_id) ||
        step.runId !== id(p.run_id) ||
        step.conversationId !== id(p.conversation_id)
      )
        throw new Error('步骤归属不匹配')
      const previous = this.steps.get(step.id)
      if (previous)
        step = {
          ...step,
          reasoning: previous.reasoning ?? '',
          reasoningTruncated: previous.reasoningTruncated ?? false,
          text: previous.text,
          commentary: previous.commentary,
          textTruncated: previous.textTruncated,
          output: previous.output,
          outputTruncated: previous.outputTruncated,
          outputSequence: previous.outputSequence,
        }
      this.saveStep(step)
      this.dirtySteps.delete(step.id)
      const run = this.runs.get(step.runId)
      if (run && !run.compaction && isManualCompactionStep(step)) {
        if (run.conversationId !== step.conversationId) throw new Error('压缩执行归属不匹配')
        const updated = { ...run, compaction: { stepId: step.id, outcome: null, error: null } }
        this.runs.set(run.id, updated)
        this.events.publish({ kind: 'run', value: updated, persisted: true })
      }
      this.events.publish({ kind: 'step', value: step })
      if (step.parentStepId && (step.type === 'tool_call' || step.type === 'user_input')) {
        const parent = this.steps.get(step.parentStepId)
        if (parent && !parent.commentary) {
          const commentary = { ...parent, commentary: true }
          this.saveStep(commentary)
          this.dirtySteps.delete(parent.id)
          this.events.publish({ kind: 'step', value: commentary })
        }
      }
      if (!['pending', 'running', 'awaiting_approval', 'awaiting_user_input'].includes(step.status))
        this.stepOutputs.delete(step.id)
    } else if (method === 'tool.output') {
      const stepId = id(p.step_id),
        previous = this.steps.get(stepId)
      // 已被缓存淘汰的输出不重建无归属步骤；持久化结果仍可按需查询。
      if (previous) {
        if (
          previous.conversationId !== id(p.conversation_id) ||
          previous.runId !== id(p.run_id) ||
          previous.type !== 'tool_call'
        )
          throw new Error('工具输出归属不匹配')
        const decoder = this.stepOutputs.get(stepId) ?? new StepOutput()
        this.stepOutputs.set(stepId, decoder)
        const step = decoder.append(previous, p.output)
        this.saveStep(step)
        this.dirtySteps.set(step.id, step)
        this.flushTimer ??= setTimeout(() => this.flush(), 16)
      }
    } else if (method === 'reasoning.delta') {
      const previous = this.steps.get(id(p.step_id))
      if (previous) {
        if (
          previous.type !== 'model_call' ||
          previous.runId !== id(p.run_id) ||
          previous.conversationId !== id(p.conversation_id)
        )
          throw new Error('思考内容归属不匹配')
        const text = string(p.text)
        if (Buffer.byteLength(text) > MAX_REASONING_BYTES) throw new Error('思考增量过长')
        const reasoning = (previous.reasoning ?? '') + text
        const tooLong = reasoning.length > MAX_REASONING_BYTES
        const step = {
          ...previous,
          reasoning: tooLong ? truncateStepText(reasoning, MAX_REASONING_BYTES) : reasoning,
          reasoningTruncated: previous.reasoningTruncated || tooLong,
        }
        this.saveStep(step)
        this.dirtySteps.set(step.id, step)
        this.flushTimer ??= setTimeout(() => this.flush(), 16)
      }
    } else if (method === 'message.delta') {
      const messageId = id(p.message_id),
        previous = this.messages.get(messageId)
      if (!previous) throw new Error('消息增量缺少初始消息')
      const message = appendDelta(previous, p)
      this.messages.set(message.id, message)
      this.dirty.set(message.id, message)
      if (p.step_id !== undefined) {
        const step = this.steps.get(id(p.step_id))
        if (step) {
          if (
            step.conversationId !== message.conversationId ||
            step.runId !== message.runId ||
            step.type !== 'model_call'
          )
            throw new Error('模型步骤归属不匹配')
          const text = step.text + string(record(p.delta).text)
          const updated = {
            ...step,
            text: truncateStepText(text, STEP_TEXT_LIMIT),
            textTruncated: step.textTruncated || text.length > STEP_TEXT_LIMIT,
          }
          this.saveStep(updated)
          this.dirtySteps.set(step.id, updated)
        }
      }
      this.flushTimer ??= setTimeout(() => this.flush(), 16)
    } else if (method.startsWith('run.') && p.run !== undefined) {
      let run = runFromRpc(p.run)
      if (id(p.conversation_id) !== run.conversationId || id(p.run_id) !== run.id)
        throw new Error('执行归属不匹配')
      const previous = this.runs.get(run.id)
      if (previous?.compaction) run = { ...run, compaction: previous.compaction }
      this.runs.set(run.id, run)
      if (p.persisted === false) {
        this.persistenceFailures.add(run.conversationId)
        if (this.persistenceFailures.size > 128) throw new Error('执行状态持续保存失败')
      }
      this.flush()
      this.events.publish({ kind: 'run', value: run, persisted: p.persisted !== false })
      if (!isActiveRun(run)) {
        this.events.publish({
          kind: 'follow-ups',
          value: { id: run.conversationId, conversationId: run.conversationId },
        })
        if (method === 'run.completed' && p.persisted !== false && run.status === 'completed')
          void this.dispatchFollowUp(run)
        for (const [key, message] of this.messages)
          if (message.runId === run.id) this.messages.delete(key)
        this.runs.delete(run.id)
      }
    } else if (method === 'approval.requested' || method === 'approval.updated') {
      const approval = approvalFromRpc(p.approval, id(p.conversation_id))
      if (approval.runId !== id(p.run_id) || approval.id !== id(p.approval_id))
        throw new Error('审批归属不匹配')
      this.events.publish({ kind: 'approval', value: approval })
    } else if (method === 'directory_grant.updated') {
      const grant = directoryGrantFromRpc(p.directory_grant)
      if (grant.conversationId !== id(p.conversation_id)) throw new Error('目录授权归属不匹配')
      this.events.publish({ kind: 'directory-grant', value: grant })
    } else if (method === 'user_input.requested' || method === 'user_input.updated') {
      const input = userInputFromRpc(p.user_input)
      if (
        input.id !== id(p.input_id) ||
        input.runId !== id(p.run_id) ||
        input.conversationId !== id(p.conversation_id) ||
        input.stepId !== id(p.step_id)
      )
        throw new Error('问题归属不匹配')
      this.events.publish({ kind: 'user-input', value: input })
    }
    if (this.messages.size > 32 || this.runs.size > 64) throw new Error('活动消息超出限制')
  }
  private checkOwner(params: Record<string, unknown>, message: ChatMessage): void {
    if (
      id(params.conversation_id) !== message.conversationId ||
      id(params.run_id) !== message.runId ||
      id(params.message_id) !== message.id
    )
      throw new Error('消息归属不匹配')
  }
  flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const message of this.dirty.values())
      this.events.publish({ kind: 'message', value: message })
    this.dirty.clear()
    for (const step of this.dirtySteps.values()) this.events.publish({ kind: 'step', value: step })
    this.dirtySteps.clear()
  }

  removeMessage(id: string): void {
    this.messages.delete(id)
    this.dirty.delete(id)
  }
  removeOutput(id: string): void {
    this.stepOutputs.delete(id)
  }
  close(): void {
    clearTimeout(this.flushTimer)
    this.dirty.clear()
    this.dirtySteps.clear()
    this.messages.clear()
    this.runs.clear()
    this.steps.clear()
    this.stepOutputs.clear()
    this.persistenceFailures.clear()
  }
}
