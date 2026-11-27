import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AttachmentTransfer } from '../../src/main/backend/attachment-transfer.ts'
import {
  addAttachmentFiles,
  attachmentInputs,
  isImageAttachment,
  isImageFile,
} from '../../src/renderer/features/conversation/attachment-files.ts'
import { parseAttachments, parseAttachmentSaveInput } from '../../src/shared/attachments.ts'
import { record } from '../../src/shared/validation.ts'

test('普通附件保留文件名和类型，图片与文件采用各自输入方式', async () => {
  const document = new File(['fixture-docx'], '季度计划.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  const image = new File(['fixture-image'], '截图.png', { type: 'image/png' })
  const empty = new File([], 'empty.txt', { type: 'text/plain' })
  assert.equal(isImageFile(document), false)
  assert.equal(isImageFile(image), true)
  assert.equal(isImageAttachment({ label: document.name, source: document }), false)
  const files = addAttachmentFiles([], [document, image, empty])
  const inputs = parseAttachments(await attachmentInputs(files))
  assert.deepEqual(
    inputs.map(({ name, kind }) => ({ name, kind })),
    [
      { name: '季度计划.docx', kind: 'file' },
      { name: '截图.png', kind: 'image' },
      { name: 'empty.txt', kind: 'file' },
    ],
  )
  assert.equal(inputs[2]?.bytes.length, 0)
  assert.equal(
    isImageAttachment({
      label: '历史文档',
      source: { conversationId: 'a', messageId: 'b', index: 0 },
      kind: 'file',
    }),
    false,
  )
})

test('附件 IPC 拒绝越界名称、未知类型和额外字段，保留原有图片输入兼容', () => {
  const bytes = new Uint8Array([1])
  assert.deepEqual(parseAttachments([{ bytes }]), [{ bytes }])
  for (const name of ['../secret', 'a\\b.docx', '.', '..', 'bad\nname']) {
    assert.throws(() => parseAttachments([{ bytes, kind: 'file', name }]), /名称无效/)
  }
  assert.throws(() => parseAttachments([{ bytes, kind: 'executable' }]), /类型无效/)
  assert.throws(() => parseAttachments([{ bytes, path: '/private/data' }]), /数据无效/)
  assert.throws(
    () => parseAttachments([{ bytes: new Uint8Array(), kind: 'image' }]),
    /图片不能为空/,
  )
  assert.throws(
    () =>
      addAttachmentFiles(
        [],
        Array.from({ length: 9 }, () => new File(['x'], 'a.txt')),
      ),
    /8 个附件/,
  )
})

test('另存附件绑定界面选中的执行版本，拒绝混合分片或错误摘要', async () => {
  const input = {
    conversationId: '01964f15-1111-7111-8111-111111111111',
    messageId: '01964f15-2222-7222-8222-222222222222',
    runId: '01964f15-3333-7333-8333-333333333333',
    index: 2,
  }
  assert.deepEqual(parseAttachmentSaveInput(input), input)
  assert.throws(() => parseAttachmentSaveInput({ ...input, runId: undefined }), /无效/)
  assert.throws(() => parseAttachmentSaveInput({ ...input, path: '/private/data' }), /无效/)

  const chunkSize = 1024 * 1024
  const payload = Buffer.alloc(2 * chunkSize, 65)
  const replacement = Buffer.alloc(2 * chunkSize, 66)
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const read = async (change: 'none' | 'version' | 'digest' | 'bytes') => {
    const transfer = new AttachmentTransfer(
      async (method, raw) => {
        const params = record(raw)
        const offset = Number(params.offset)
        assert.equal(method, 'conversation.attachment_read')
        assert.equal(params.expected_run_id, input.runId)
        const nextOffset = offset + chunkSize
        const changed = offset !== 0
        const bytes = changed && change !== 'none' ? replacement : payload
        return {
          run_id: changed && change === 'version' ? 'replaced' : input.runId,
          sha256: changed && change === 'digest' ? digest(replacement) : digest(payload),
          name: 'same-name.txt',
          size: payload.length,
          offset,
          data: bytes.subarray(offset, nextOffset).toString('base64'),
          next_offset: nextOffset === payload.length ? null : nextOffset,
        }
      },
      async () => {},
    )
    try {
      return await transfer.readAttachmentFile(input)
    } finally {
      await transfer.close()
    }
  }
  assert.deepEqual(await read('none'), { name: 'same-name.txt', bytes: payload })
  await assert.rejects(read('version'), /附件在读取期间发生变化/)
  await assert.rejects(read('digest'), /附件在读取期间发生变化/)
  await assert.rejects(read('bytes'), /附件完整性校验失败/)
})
