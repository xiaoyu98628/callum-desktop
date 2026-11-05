import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalSummary } from '../../src/shared/approval-summary.ts'

test('审批摘要只读取固定的实际目标，保留符号链接解析前后的路径区别', () => {
  const snapshot = JSON.stringify({
    summary: '读取文件',
    target: { path: '/actual/file.txt', requested_path: '/linked/file.txt' },
    arguments: { path: '/untrusted/argument.txt' },
  })
  assert.deepEqual(approvalSummary(snapshot), {
    description: '读取文件',
    fields: [
      { label: '实际目标', value: '/actual/file.txt' },
      { label: '请求路径', value: '/linked/file.txt' },
    ],
    recognized: true,
  })
  assert.equal(JSON.parse(snapshot).arguments.path, '/untrusted/argument.txt')
})

test('命令摘要展示服务端可执行文件和工作目录，HTML 等内容保持普通文本', () => {
  const value = approvalSummary(
    JSON.stringify({
      summary: '<script>doNotExecute()</script>',
      details: { executable: '/usr/bin/example', cwd: '/tmp/work' },
      arguments: { command: ['example', 'argument with space', '"quoted"'] },
    }),
  )
  assert.equal(value.description, '<script>doNotExecute()</script>')
  assert.deepEqual(value.fields.slice(0, 2), [
    { label: '可执行文件', value: '/usr/bin/example' },
    { label: '工作目录', value: '/tmp/work' },
  ])
  assert.deepEqual(JSON.parse(value.fields[2]?.value ?? 'null') as unknown, [
    'example',
    'argument with space',
    '"quoted"',
  ])
  assert.equal(value.recognized, true)
})

test('无法识别、过长和多目标快照要求展示完整详情，不生成推测的目标', () => {
  for (const snapshot of [
    '{',
    'null',
    '[]',
    '"text"',
    '{}',
    'x'.repeat(256 * 1024 + 1),
    JSON.stringify({ target: { path: 1 } }),
  ])
    assert.equal(approvalSummary(snapshot).recognized, false)
  const multi = approvalSummary(
    JSON.stringify({ target: { path: '/one' }, plan: { targets: [{ path: '/two' }] } }),
  )
  assert.equal(multi.recognized, false)
})
