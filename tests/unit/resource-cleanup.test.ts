import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withCleanup } from '../../src/main/resource-cleanup.ts'

test('文件操作失败后仍关闭资源，清理错误保留原始原因', async () => {
  const original = new Error('write failed')
  const cleanup = new Error('close failed')
  let closed = false
  await assert.rejects(
    withCleanup(
      async () => {
        throw original
      },
      async () => {
        closed = true
        throw cleanup
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, original)
      assert.deepEqual(error.errors, [original, cleanup])
      return true
    },
  )
  assert.equal(closed, true)
  assert.equal(
    await withCleanup(
      async () => 42,
      async () => undefined,
    ),
    42,
  )
})
