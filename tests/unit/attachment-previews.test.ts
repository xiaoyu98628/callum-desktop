import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AttachmentPreviews } from '../../src/renderer/features/conversation/attachment-previews.ts'
import type { AttachmentItem } from '../../src/renderer/features/conversation/attachment-files.ts'
import type { AttachmentPreview } from '../../src/shared/attachments.ts'

function item(name: string, version = 'run-1'): AttachmentItem {
  return {
    key: `${name}/${version}`,
    label: name,
    source: { conversationId: 'conversation', messageId: name, index: 0 },
  }
}
function preview(data: string): AttachmentPreview {
  return { mime: 'image/png', data }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('图片读取合并重复请求、限制并发，取消单个消费者不影响其他消费者', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<AttachmentPreview>>>()
  const reads: string[] = []
  const store = new AttachmentPreviews(
    async (image) => {
      reads.push(image.label)
      const gate = deferred<AttachmentPreview>()
      gates.set(image.label, gate)
      return gate.promise
    },
    async (value) => `small:${value.data}`,
  )
  const active = new AbortController(),
    cancelled = new AbortController(),
    queued = new AbortController()
  const first = assert.rejects(store.thumbnail(item('first'), cancelled.signal), {
    name: 'AbortError',
  })
  const full = store.full(item('first'), active.signal)
  const second = store.thumbnail(item('second'), active.signal)
  const removed = assert.rejects(store.thumbnail(item('removed'), queued.signal), {
    name: 'AbortError',
  })
  assert.deepEqual(reads, ['first', 'second'])
  cancelled.abort()
  queued.abort()
  gates.get('first')!.resolve(preview('first'))
  gates.get('second')!.resolve(preview('second'))
  assert.deepEqual(await full, preview('first'))
  assert.equal(await second, 'small:second')
  await Promise.all([first, removed])
  assert.equal(await store.thumbnail(item('first'), active.signal), 'small:first')
  assert.deepEqual(reads, ['first', 'second'])
  store.close()
})

test('切换会话丢弃迟到结果，关闭可重复调用且不会继续受理', async () => {
  const gates = [deferred<AttachmentPreview>(), deferred<AttachmentPreview>()]
  const rendered: string[] = []
  let calls = 0
  const store = new AttachmentPreviews(
    () => gates[calls++]!.promise,
    async (value) => {
      rendered.push(value.data)
      return `small:${value.data}`
    },
  )
  const signal = new AbortController().signal
  const old = assert.rejects(store.thumbnail(item('image'), signal), { name: 'AbortError' })
  store.clear()
  const current = store.thumbnail(item('image'), signal)
  gates[0]!.resolve(preview('old'))
  gates[1]!.resolve(preview('current'))
  await old
  assert.equal(await current, 'small:current')
  assert.deepEqual(rendered, ['current'])
  assert.equal(await store.thumbnail(item('image'), signal), 'small:current')
  store.close()
  store.close()
  await assert.rejects(store.full(item('image'), signal), { name: 'AbortError' })
})

test('读取失败可重试，缩略图处理失败仍允许查看完整预览', async () => {
  let reads = 0,
    renders = 0
  const store = new AttachmentPreviews(
    async () => {
      if (++reads === 1) throw new Error('临时读取失败')
      return preview('original')
    },
    async () => {
      if (++renders === 1) throw new Error('缩略图处理失败')
      return 'small:original'
    },
  )
  const signal = new AbortController().signal
  await assert.rejects(store.thumbnail(item('image'), signal), /临时读取失败/)
  assert.deepEqual(await store.full(item('image'), signal), preview('original'))
  assert.equal(await store.thumbnail(item('image'), signal), 'small:original')
  assert.equal(reads, 2)
  store.close()
})

test('大图缓存按字节淘汰，缩略图独立复用，重发版本使用不同缓存', async () => {
  let reads = 0
  const data = 'A'.repeat(5 * 1024 * 1024)
  const store = new AttachmentPreviews(
    async () => {
      reads++
      return preview(data)
    },
    async () => 'small',
  )
  const signal = new AbortController().signal
  await store.full(item('first'), signal)
  await store.full(item('second'), signal)
  assert.equal(reads, 2)
  await store.thumbnail(item('first'), signal)
  assert.equal(reads, 2)
  await store.full(item('first'), signal)
  assert.equal(reads, 3)
  await store.thumbnail(item('first', 'run-2'), signal)
  assert.equal(reads, 4)
  store.close()
})

test('快速滚动产生的请求队列有界，关闭清空排队任务', async () => {
  const gates: ReturnType<typeof deferred<AttachmentPreview>>[] = []
  const store = new AttachmentPreviews(
    async () => {
      const gate = deferred<AttachmentPreview>()
      gates.push(gate)
      return gate.promise
    },
    async () => 'small',
  )
  const signal = new AbortController().signal
  const pending = Array.from({ length: 100 }, (_, index) =>
    store.thumbnail(item(String(index)), signal).catch((error: unknown) => error),
  )
  assert.equal(gates.length, 2)
  store.close()
  for (const gate of gates) gate.resolve(preview('late'))
  const results = await Promise.all(pending)
  assert.ok(results.every((result) => result instanceof Error))
  assert.ok(results.some((result) => result instanceof Error && /繁忙/.test(result.message)))
})

test('草稿预览只占一个文件传输名额，历史图片仍可并行读取', async () => {
  const gates: ReturnType<typeof deferred<AttachmentPreview>>[] = []
  const reads: string[] = []
  const store = new AttachmentPreviews(
    async (image) => {
      reads.push(image.label)
      const gate = deferred<AttachmentPreview>()
      gates.push(gate)
      return gate.promise
    },
    async () => 'small',
  )
  const controller = new AbortController()
  const first: AttachmentItem = { label: 'first-file', source: new File(['a'], 'a.png') }
  const second: AttachmentItem = { label: 'second-file', source: new File(['b'], 'b.png') }
  const pending = [first, second, item('history')].map((image) =>
    store.thumbnail(image, controller.signal).catch((error: unknown) => error),
  )
  assert.deepEqual(reads, ['first-file', 'history'])
  controller.abort()
  for (const gate of gates) gate.resolve(preview('late'))
  await Promise.all(pending)
  assert.deepEqual(reads, ['first-file', 'history'])
  store.close()
})
