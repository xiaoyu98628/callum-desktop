import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MarkdownRenderer } from '../../src/renderer/features/conversation/markdown/renderer.ts'
import type {
  RenderResult,
  RenderWorker,
} from '../../src/renderer/features/conversation/markdown/renderer.ts'
import type { MarkdownRequest } from '../../src/renderer/features/conversation/markdown/contract.ts'

class ControlledWorker implements RenderWorker {
  onmessage: RenderWorker['onmessage'] = null
  onerror: RenderWorker['onerror'] = null
  onmessageerror: RenderWorker['onmessageerror'] = null
  sent: MarkdownRequest[] = []
  terminated = 0
  postMessage(request: MarkdownRequest): void {
    this.sent.push(request)
  }
  terminate(): void {
    this.terminated++
  }
  complete(index: number): void {
    const request = this.sent[index]
    assert.ok(request)
    this.onmessage?.(
      new MessageEvent('message', {
        data: {
          id: request.id,
          revision: request.revision,
          document: { html: request.texts.map((text) => [`<p>${text}</p>`]), codes: [] },
        },
      }),
    )
  }
}

test('持续分片不会饿死排版结果，繁忙期间只排队最新快照', () => {
  const worker = new ControlledWorker()
  const renderer = new MarkdownRenderer(() => worker)
  const received: RenderResult[] = []
  try {
    const client = renderer.register((result) => received.push(result))
    client.render(['一'])
    for (let index = 2; index <= 100; index++) client.render(['一'.repeat(index)])
    assert.equal(worker.sent.length, 1)
    worker.complete(0)
    assert.equal(received.length, 1)
    assert.deepEqual(received[0] && 'texts' in received[0] ? received[0].texts : null, ['一'])
    assert.equal(worker.sent.length, 2)
    assert.deepEqual(worker.sent[1]?.texts, ['一'.repeat(100)])
    worker.complete(1)
    assert.equal(received.length, 2)
  } finally {
    renderer.close()
  }
  assert.equal(worker.terminated, 1)
  renderer.close()
  assert.equal(worker.terminated, 1)
})

test('替换、切换与卸载会作废旧结果，其他消息仍能继续排版', () => {
  const worker = new ControlledWorker()
  const renderer = new MarkdownRenderer(() => worker)
  const old: RenderResult[] = [],
    current: RenderResult[] = []
  try {
    const first = renderer.register((result) => old.push(result))
    const second = renderer.register((result) => current.push(result))
    first.render(['旧工具轮次'])
    first.invalidate()
    first.render(['新工具轮次'])
    second.render(['另一会话'])
    worker.complete(0)
    assert.equal(old.length, 0)
    first.dispose()
    worker.complete(1)
    assert.equal(old.length, 0)
    worker.complete(2)
    assert.equal(current.length, 1)
    assert.deepEqual(current[0] && 'texts' in current[0] ? current[0].texts : null, ['另一会话'])
  } finally {
    renderer.close()
  }
})

test('排版超时会释放 Worker 并回退，关闭后不接受迟到结果', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const worker = new ControlledWorker()
  const renderer = new MarkdownRenderer(() => worker)
  const received: RenderResult[] = []
  const client = renderer.register((result) => received.push(result))
  client.render(['正文'])
  context.mock.timers.tick(3000)
  assert.equal(worker.terminated, 1)
  assert.ok(received[0] && 'error' in received[0])
  renderer.close()
  worker.complete(0)
  assert.equal(received.length, 1)
})
