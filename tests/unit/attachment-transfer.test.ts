import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AttachmentTransfer } from '../../src/main/backend/attachment-transfer.ts'

const input = { conversationId: 'conversation', messageId: 'message', runId: 'run', index: 0 }
const bytes = Buffer.from('controlled attachment')
const result = {
  name: 'controlled.txt',
  size: bytes.length,
  run_id: input.runId,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  data: bytes.toString('base64'),
  offset: 0,
  next_offset: null,
}

test('附件下载和上传共用在途边界，关闭等待已有下载并拒绝新任务', async () => {
  const resolvers: ((value: unknown) => void)[] = []
  const transfer = new AttachmentTransfer(
    async () => new Promise((done) => resolvers.push(done)),
    async () => {},
  )
  const first = transfer.readAttachmentFile(input)
  const second = transfer.readAttachmentFile(input)
  await Promise.resolve()
  await assert.rejects(transfer.readAttachmentFile(input), /其他附件/)
  let closed = false
  const closing = transfer.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  await assert.rejects(transfer.readAttachmentFile(input), /退出/)
  for (const resolve of resolvers) resolve(result)
  assert.deepEqual((await first).bytes, bytes)
  assert.deepEqual((await second).bytes, bytes)
  await closing
  assert.equal(closed, true)
})

test('附件分片中的身份和摘要不符会失败，失败释放传输名额', async () => {
  let response: unknown = { ...result, sha256: '0'.repeat(64) }
  const transfer = new AttachmentTransfer(
    async () => response,
    async () => {},
  )
  await assert.rejects(transfer.readAttachmentFile(input), /完整性/)
  response = { ...result, run_id: 'other' }
  await assert.rejects(transfer.readAttachmentFile(input), /变化/)
  response = result
  assert.deepEqual((await transfer.readAttachmentFile(input)).bytes, bytes)
  await transfer.close()
})
