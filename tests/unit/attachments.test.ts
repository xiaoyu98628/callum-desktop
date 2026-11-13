import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAttachments } from '../../src/shared/attachments.ts'
import {
  addAttachmentFiles,
  attachmentInputs,
  isImageAttachment,
  isImageFile,
} from '../../src/renderer/features/conversation/attachment-files.ts'

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
