import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { userInputFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { parseUserInputAnswer } from '../../src/shared/chat.ts'
import type { ChatEvent, ChatUserInput } from '../../src/shared/chat.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'

const uuid = '019a4f39-0000-7000-8000-000000000001'
test('补充输入严格映射问题、选项和归属，回复不能携带权限字段或越界', () => {
  const source = {
    id: uuid,
    conversation_id: uuid,
    run_id: uuid,
    step_id: uuid,
    question: '问题',
    options: ['选项'],
    status: 'pending',
    answer: null,
    created_at: 1,
    updated_at: 1,
  }
  assert.equal(userInputFromRpc(source).options[0], '选项')
  for (const invalid of [
    { optionIndex: null, text: '', skipped: false },
    { optionIndex: 8, text: '', skipped: false },
    { optionIndex: -1, text: '', skipped: false },
    { optionIndex: null, text: '中'.repeat(1366), skipped: false },
    { optionIndex: 0, text: '', skipped: false, approved: true },
    { optionIndex: 0, text: '', skipped: true },
  ])
    assert.throws(() => parseUserInputAnswer(invalid))
  assert.throws(() => userInputFromRpc({ ...source, step_id: uuid.replace(/1$/, '2') }))
  assert.throws(() => userInputFromRpc({ ...source, status: 'answered' }))
  assert.throws(() => userInputFromRpc({ ...source, options: ['重复', '重复'] }))
  const answered = userInputFromRpc({
    ...source,
    status: 'answered',
    answer: { option_index: 0, text: '补充', skipped: false },
  })
  assert.deepEqual(answered.answer, { optionIndex: 0, text: '补充', skipped: false })
})

test(
  '真实 Go 补充输入：等待快照、选项/文字/跳过、重复回复和取消',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-user-input-test-'))
    let service: ChatService | undefined
    let upstream: Awaited<ReturnType<typeof startModelServer>> | undefined
    const events: ChatEvent[] = []
    const until = async (check: () => boolean) => {
      const end = Date.now() + 7000
      while (!check()) {
        if (Date.now() > end) throw new Error('未收到问题状态')
        await setTimeout(10)
      }
    }
    try {
      upstream = await startModelServer(join(profile, 'fixture.txt'))
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      service.subscribe((event) => events.push(event))
      for (const mode of ['选项', '文字', '跳过', '取消']) {
        const run = await service.send({ conversationId: null, modelId, text: `提问${mode}` })
        await until(() =>
          events.some(
            ({ change }) =>
              change.kind === 'user-input' &&
              change.value.runId === run.runId &&
              change.value.status === 'pending',
          ),
        )
        const input: ChatUserInput | undefined = (await service.detail(run.conversationId))
          .userInputs[0]
        assert.ok(input)
        assert.equal(input.runId, run.runId)
        if (mode === '取消') {
          await service.cancel(run.runId)
          await until(() =>
            events.some(
              ({ change }) =>
                change.kind === 'run' &&
                change.value.id === run.runId &&
                change.value.status === 'cancelled',
            ),
          )
          await assert.rejects(
            service.submitUserInput(input.id, run.runId, {
              optionIndex: 0,
              text: '',
              skipped: false,
            }),
          )
          continue
        }
        const answer = {
          optionIndex: mode === '选项' ? 0 : null,
          text: mode === '文字' ? '自己的文字回复' : '',
          skipped: mode === '跳过',
        }
        const result = await service.submitUserInput(input.id, run.runId, answer)
        assert.equal(result.status, mode === '跳过' ? 'skipped' : 'answered')
        assert.deepEqual(
          (await service.submitUserInput(input.id, run.runId, answer)).answer,
          answer,
        )
        await until(() =>
          events.some(
            ({ change }) =>
              change.kind === 'run' &&
              change.value.id === run.runId &&
              change.value.status === 'completed',
          ),
        )
        const detail = await service.detail(run.conversationId)
        assert.equal(detail.userInputs.length, 0)
        assert.ok(
          detail.messages[1]?.content[0]?.text.includes(
            mode === '跳过' ? '已跳过' : mode === '选项' ? '已结束，可以复验' : '自己的文字回复',
          ),
        )
      }
    } finally {
      await service?.close()
      await upstream?.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)
