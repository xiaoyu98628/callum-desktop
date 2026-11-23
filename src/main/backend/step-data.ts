import { StringDecoder } from 'node:string_decoder'
import { id, integer, MAX_REASONING_BYTES, record, string } from '../../shared/chat.ts'
import type { ChatStep, StepDetails } from '../../shared/chat.ts'
import { STEP_OUTPUT_LIMIT, STEP_TEXT_LIMIT, truncateStepText } from '../../shared/steps.ts'

type Request = (method: string, params: unknown) => Promise<unknown>
const DATA_LIMIT = 8 * 1024 * 1024
const DISPLAY_LIMIT = 256 * 1024

/** 字节片段可能拆开 UTF-8 字符；每个工具步骤和输出流持有独立解码器。 */
export class StepOutput {
  private readonly stdout = new StringDecoder('utf8')
  private readonly stderr = new StringDecoder('utf8')
  private stream = ''
  append(step: ChatStep, value: unknown): ChatStep {
    const v = record(value)
    const sequence = integer(v.sequence, 1)
    if (v.encoding !== 'base64' || (v.stream !== 'stdout' && v.stream !== 'stderr'))
      throw new Error('工具输出格式无效')
    const data = string(v.data)
    if (
      data.length > 128 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    )
      throw new Error('工具输出编码无效')
    if (sequence <= step.outputSequence) return step
    const gap = sequence !== step.outputSequence + 1
    if (gap) {
      this.stdout.end()
      this.stderr.end()
    }
    const text = this[v.stream].write(Buffer.from(data, 'base64'))
    const prefix = this.stream === v.stream ? '' : `[${v.stream}]\n`
    this.stream = v.stream
    const output = step.output + prefix + text
    return {
      ...step,
      output: truncateStepText(output, STEP_OUTPUT_LIMIT),
      outputSequence: sequence,
      outputTruncated: step.outputTruncated || gap || output.length > STEP_OUTPUT_LIMIT,
    }
  }
}

async function readStepField(
  request: Request,
  stepId: string,
  field: 'output' | 'reasoning',
  maxBytes: number,
): Promise<{ raw: string; truncated: boolean }> {
  const fragments: string[] = []
  let offset = 0
  for (;;) {
    const limit = Math.min(65536, maxBytes - offset)
    if (limit < 4) return { raw: fragments.join(''), truncated: true }
    const v = record(await request('step.data', { step_id: stepId, field, offset, limit }))
    if (
      id(v.step_id) !== stepId ||
      v.field !== field ||
      integer(v.offset) !== offset ||
      typeof v.done !== 'boolean' ||
      typeof v.present !== 'boolean'
    )
      throw new Error('步骤数据归属无效')
    const fragment = string(v.fragment),
      next = integer(v.next_offset),
      total = integer(v.total_bytes)
    if (
      next < offset ||
      next > total ||
      next - offset > limit ||
      Buffer.byteLength(fragment) !== next - offset ||
      (v.done && next !== total) ||
      (!v.done && next === offset)
    )
      throw new Error('步骤数据分页无效')
    if (!v.present && (total !== 0 || fragment !== '' || !v.done))
      throw new Error('步骤数据缺失状态无效')
    fragments.push(fragment)
    offset = next
    if (v.done || offset >= maxBytes) return { raw: fragments.join(''), truncated: !v.done }
  }
}

/** 正文独立于原始模型响应分段读取，不受结果详情的展示预算影响。 */
export async function readStepReasoning(request: Request, stepId: string): Promise<string> {
  const result = await readStepField(request, stepId, 'reasoning', MAX_REASONING_BYTES)
  if (result.truncated) throw new Error('思考内容超出数据限制。')
  return result.raw
}

/** 查询仅使用统一 context_message，界面不解析供应商响应。原始结果展示保持有界。 */
export async function readStepDetails(request: Request, step: ChatStep): Promise<StepDetails> {
  const { raw, truncated } = await readStepField(request, step.id, 'output', DATA_LIMIT)
  let output = raw,
    text: string | null = null
  let reasoning = ''
  let reasoningTruncated = false
  if (!truncated && raw) {
    const v = record(JSON.parse(raw) as unknown)
    output = JSON.stringify(v, null, 2)
    if (step.type === 'model_call' && v.reasoning !== undefined) reasoning = string(v.reasoning)
    if (step.type === 'model_call' && v.context_message !== undefined) {
      const message = record(v.context_message)
      if (message.role === 'assistant' && typeof message.content === 'string')
        text = message.content
    }
  }
  if (step.type === 'model_call' && truncated) {
    // 原始响应过大时只探查是否有思考，完整正文由打开的思考面板读取。
    const preview = await readStepField(request, step.id, 'reasoning', 4)
    reasoning = preview.raw
    reasoningTruncated = preview.truncated
  }
  return {
    id: step.id,
    conversationId: step.conversationId,
    runId: step.runId,
    input: step.input,
    inputTruncated: step.inputTruncated,
    output: truncateStepText(output, DISPLAY_LIMIT),
    outputTruncated: truncated || output.length > DISPLAY_LIMIT,
    text: text === null ? null : truncateStepText(text, STEP_TEXT_LIMIT),
    textTruncated: truncated || (text?.length ?? 0) > STEP_TEXT_LIMIT,
    reasoning: truncateStepText(reasoning, STEP_TEXT_LIMIT),
    reasoningTruncated: reasoningTruncated || reasoning.length > STEP_TEXT_LIMIT,
  }
}
