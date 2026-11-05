import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'
import type { ChatEvent, ChatApproval } from '../../src/shared/chat.ts'
import { stepFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { StepOutput, readStepDetails } from '../../src/main/backend/step-data.ts'
import { parseChatEvent, parseStepPage, record } from '../../src/shared/chat.ts'
import {
  boundSteps,
  stepLabel,
  stepTarget,
  STEP_OUTPUT_LIMIT,
  stepParameters,
  stepResult,
  truncateStepText,
} from '../../src/shared/steps.ts'
import type { ChatStep } from '../../src/shared/chat.ts'

const uuid = (n = 1): string => `019a4f39-0000-7000-8000-${String(n).padStart(12, '0')}`
function step(): ChatStep {
  return stepFromRpc({
    id: uuid(),
    conversation_id: uuid(2),
    run_id: uuid(3),
    sequence: 1,
    type: 'tool_call',
    name: 'run_command',
    status: 'running',
    input: { arguments: { command: ['/bin/echo', 'hello world'], cwd: '/fixed' } },
    updated_at: 1,
  })
}
const chunk = (sequence: number, stream: string, data: Buffer) => ({
  sequence,
  stream,
  encoding: 'base64',
  data: data.toString('base64'),
})

test('步骤保留归属、固定参数和状态，不把取消解释为未执行', () => {
  const value = step()
  assert.equal(stepTarget(value), '/bin/echo "hello world"')
  assert.equal(stepLabel({ ...value, status: 'cancelled' }), '运行命令已取消')
  assert.deepEqual(parseChatEvent({ revision: 1, change: { kind: 'step', value } }).change, {
    kind: 'step',
    value,
  })
  assert.throws(() =>
    parseChatEvent({ revision: 1, change: { kind: 'step', value: { ...value, sequence: -1 } } }),
  )
  assert.throws(() => stepFromRpc({}))
  assert.equal(
    stepFromRpc({
      id: uuid(),
      conversation_id: uuid(2),
      run_id: uuid(3),
      sequence: 1,
      type: 'model_call',
      name: '生成回答',
      status: 'completed',
      input: {},
      updated_at: 1,
    }).purpose,
    'answer',
  )
  assert.equal(stepTarget({ ...value, input: '{bad' }), '')
  assert.equal(
    stepTarget({
      ...value,
      input: JSON.stringify({
        arguments: {
          patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** Add File: b.txt\n+x',
        },
      }),
    }),
    'a.txt、b.txt',
  )
})

test('工具流按步骤独立解码跨片 UTF-8，保留 stderr 标识，重复通知不重复追加', () => {
  const decoder = new StepOutput(),
    other = new StepOutput(),
    bytes = Buffer.from('中文')
  let value = decoder.append(step(), chunk(1, 'stdout', bytes.subarray(0, 2)))
  value = decoder.append(value, chunk(2, 'stderr', Buffer.from('错误')))
  value = decoder.append(value, chunk(3, 'stdout', bytes.subarray(2)))
  assert.ok(value.output.includes('中文'))
  assert.ok(value.output.includes('[stderr]\n错误'))
  assert.equal(value.outputTruncated, false)
  assert.equal(decoder.append(value, chunk(3, 'stdout', Buffer.from('duplicate'))), value)
  const isolated = other.append(step(), chunk(1, 'stdout', Buffer.from('other')))
  assert.equal(isolated.output, '[stdout]\nother')
  assert.ok(!isolated.output.includes('中文'))
})

test('工具流截断和缺片明确标记，非法编码被拒绝', () => {
  const decoder = new StepOutput()
  let value = decoder.append(step(), chunk(1, 'stdout', Buffer.alloc(60_000, 120)))
  value = decoder.append(value, chunk(3, 'stdout', Buffer.alloc(60_000, 121)))
  assert.equal(value.output.length, STEP_OUTPUT_LIMIT)
  assert.equal(value.outputTruncated, true)
  assert.throws(() =>
    decoder.append(value, { sequence: 4, stream: 'stdout', encoding: 'base64', data: 'invalid!' }),
  )
})

test('步骤缓存淘汰只约束展示窗口，保留最新步骤且不修改原始快照', () => {
  const values = Array.from({ length: 250 }, (_, n) => ({
    ...step(),
    id: uuid(n + 1),
    sequence: n + 1,
  }))
  const retained = boundSteps(values)
  assert.equal(retained.length, 200)
  assert.equal(retained[0]?.sequence, 51)
  assert.equal(values.length, 250)
})

test('步骤结果按服务端字节偏移拼接，只从统一消息恢复文字并限制展示体积', async () => {
  const raw = Buffer.from(
    JSON.stringify({
      context_message: { role: 'assistant', content: '过程文字。'.repeat(20_000) },
      result: 'x'.repeat(400_000),
    }),
  )
  const offsets: number[] = []
  const details = await readStepDetails(
    async (method, params) => {
      assert.equal(method, 'step.data')
      const p = record(params),
        offset = Number(p.offset)
      offsets.push(offset)
      let end = Math.min(raw.length, offset + 65536)
      while (end < raw.length && (raw[end]! & 0xc0) === 0x80) end--
      return {
        step_id: uuid(),
        field: 'output',
        present: true,
        offset,
        next_offset: end,
        total_bytes: raw.length,
        done: end === raw.length,
        fragment: raw.subarray(offset, end).toString(),
      }
    },
    { ...step(), type: 'model_call' },
  )
  assert.ok(offsets.length > 1)
  assert.equal(details.text, '过程文字。'.repeat(20_000))
  assert.equal(details.output.length, 256 * 1024)
  assert.equal(details.outputTruncated, true)
})

test('结果查询拒绝错误归属和无进展分页，不绕过数据边界', async () => {
  const result = {
    step_id: uuid(),
    field: 'output',
    present: true,
    offset: 0,
    next_offset: 0,
    total_bytes: 1,
    done: false,
    fragment: '',
  }
  await assert.rejects(
    readStepDetails(async () => result, step()),
    /分页/,
  )
  await assert.rejects(
    readStepDetails(async () => ({ ...result, step_id: uuid(9) }), step()),
    /归属/,
  )
})

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('未收到预期步骤通知')
    await setTimeout(20)
  }
}
test(
  '真实 Go 步骤：命令输出、非零退出、取消及超过一页的调用记录',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-steps-integration-'))
    let service: ChatService | undefined
    const upstream = await startModelServer(join(profile, 'fixture.txt')).catch(
      async (error: unknown) => {
        await rm(profile, { recursive: true, force: true })
        throw error
      },
    )
    const events: ChatEvent[] = []
    try {
      await writeFile(join(profile, 'fixture.txt'), 'controlled-file')
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      service.subscribe((event) => events.push(event))
      for (const text of ['命令正常步骤', '命令非零步骤', '命令取消步骤']) {
        const run = await service.send({ conversationId: null, modelId, text })
        await until(() =>
          events.some(
            ({ change }) => change.kind === 'approval' && change.value.runId === run.runId,
          ),
        )
        const approval: ChatApproval | undefined = (await service.detail(run.conversationId))
          .approvals[0]
        assert.ok(approval)
        await service.decide(approval.id, 'approved')
        await until(() =>
          events.some(
            ({ change }) =>
              change.kind === 'step' &&
              change.value.runId === run.runId &&
              change.value.output.includes(
                text.includes('取消') ? 'command-started' : 'command-out',
              ),
          ),
        )
        if (text.includes('取消')) await service.cancel(run.runId)
        await until(() =>
          events.some(
            ({ change }) =>
              change.kind === 'run' &&
              change.value.id === run.runId &&
              change.value.status === (text.includes('取消') ? 'cancelled' : 'completed'),
          ),
        )
        const page = await service.listSteps(run.conversationId, run.runId, 0)
        const command = page.steps.find((step) => step.name === 'run_command')
        assert.ok(command)
        const details = await service.stepDetails(run.conversationId, run.runId, command.id)
        const report = record(record(JSON.parse(details.output) as unknown).result)
        if (text.includes('取消')) {
          assert.equal(command.status, 'cancelled')
          assert.equal(report.cancelled, true)
          assert.equal(report.started, true)
          assert.equal(report.cleanup_complete, true)
        } else {
          assert.equal(report.exit_code, text.includes('非零') ? 3 : 0)
          assert.ok(command.output.includes('[stdout]'))
          assert.ok(command.output.includes('[stderr]'))
          assert.ok(details.output.includes('command-out'))
          assert.ok(details.output.includes('command-err'))
        }
      }
      for (const text of ['只读文件', '只读目录', '只读搜索']) {
        const run = await service.send({ conversationId: null, modelId, text })
        await until(() =>
          events.some(
            ({ change }) =>
              change.kind === 'run' &&
              change.value.id === run.runId &&
              change.value.status === 'completed',
          ),
        )
        assert.ok(
          !events.some(
            ({ change }) => change.kind === 'approval' && change.value.runId === run.runId,
          ),
        )
        const page = await service.listSteps(run.conversationId, run.runId, 0)
        assert.ok(
          page.steps.some((step) => step.type === 'tool_call' && step.status === 'completed'),
        )
      }
      const pagedRun = await service.send({ conversationId: null, modelId, text: '需要分页审批' })
      await until(() =>
        events.some(
          ({ change }) =>
            change.kind === 'run' &&
            change.value.id === pagedRun.runId &&
            change.value.status === 'completed',
        ),
      )
      assert.ok(
        !events.some(
          ({ change }) => change.kind === 'approval' && change.value.runId === pagedRun.runId,
        ),
        '默认只读批次不产生审批',
      )
      const first = await service.listSteps(pagedRun.conversationId, pagedRun.runId, 0)
      assert.equal(first.steps.length, 50)
      assert.equal(first.hasMore, true)
      const second = await service.listSteps(
        pagedRun.conversationId,
        pagedRun.runId,
        first.nextSequence,
      )
      assert.equal(second.hasMore, false)
      const all = [...first.steps, ...second.steps]
      assert.equal(all.filter((step) => step.name === 'read_file').length, 51)
      assert.equal(new Set(all.map((step) => step.id)).size, all.length)
      assert.ok(all.every((step, index) => step.sequence > (all[index - 1]?.sequence ?? 0)))
    } finally {
      try {
        await service?.close()
      } finally {
        await upstream.close()
        await rm(profile, { recursive: true, force: true })
      }
    }
  },
)

test('步骤页拒绝重复顺序和错误游标，参数结果展示不混入上下文副本', () => {
  const value = step()
  const page = { steps: [value], afterSequence: 0, nextSequence: 1, hasMore: false, revision: 1 }
  assert.equal(parseStepPage(page).steps.length, 1)
  assert.throws(() => parseStepPage({ ...page, steps: [value, value] }))
  assert.throws(() => parseStepPage({ ...page, nextSequence: 2 }))
  const input = JSON.stringify({
    arguments: { path: 'relative.txt' },
    authorization: { action: 'allow' },
    request: {
      tool: { name: 'read_file' },
      arguments: { path: 'relative.txt' },
      target: { path: '/actual/relative.txt' },
    },
  })
  const parameters = stepParameters(input)
  assert.ok(parameters.includes('/actual/relative.txt'))
  assert.ok(!parameters.includes('authorization'))
  const result = stepResult(
    JSON.stringify({
      context_message: { content: 'duplicate' },
      result: { exit_code: 3, stdout: 'actual' },
      operation: { outcome: 'applied' },
    }),
  )
  assert.equal(result.exitCode, 3)
  assert.equal(result.outcome, '操作已执行')
  assert.ok(result.text.includes('actual'))
  assert.ok(!result.text.includes('duplicate'))
  assert.equal(stepResult('unfinished-json').text, 'unfinished-json')
})

test('较大的步骤元数据截取后仍可接收，Unicode 展示边界不拆开代理对', () => {
  const value = stepFromRpc({
    id: uuid(),
    conversation_id: uuid(2),
    run_id: uuid(3),
    sequence: 1,
    type: 'model_call',
    name: '生成回答',
    status: 'completed',
    input: { messages: 'x'.repeat(200_000) },
    updated_at: 1,
  })
  assert.equal(value.inputTruncated, true)
  assert.ok(value.input.length <= 128 * 1024)
  assert.equal(truncateStepText('a😀b', 2), 'a')
  assert.equal(truncateStepText('a😀b', 3), 'a😀')
})
