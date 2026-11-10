import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalSummary } from '../../src/shared/approval-summary.ts'

test('Windows 原生沙箱审批展示固定可读目录并保留只读边界', () => {
  const details = {
    sandbox_backend: 'windows-appcontainer',
    execution_boundary: { sandboxed: true, sandbox_mode: 'read-only' },
    readable_roots: ['C:\\project', 'C:\\tools', 42, null],
  }
  const summary = approvalSummary(JSON.stringify({ details }))
  assert.deepEqual(
    summary.fields.filter((field) => field.label === '可读目录'),
    [
      { label: '可读目录', value: 'C:\\project' },
      { label: '可读目录', value: 'C:\\tools' },
    ],
  )
  assert.match(summary.executionNotice ?? '', /Windows 只读沙箱/)
  assert.ok(summary.fields.some((field) => field.label === '网络访问' && field.value === '关闭'))
  const mac = approvalSummary(
    JSON.stringify({ details: { ...details, sandbox_backend: 'macos-seatbelt' } }),
  )
  assert.equal(
    mac.fields.some((field) => field.label === '可读目录'),
    false,
  )
  assert.equal(mac.executionNotice, '此命令在只读沙箱内运行，仅本次私有临时目录可写，网络关闭。')
})

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

test('写入计划只展示服务端实际目标与操作影响，未知计划保留完整快照', () => {
  const summary = approvalSummary(
    JSON.stringify({
      plan: {
        targets: [
          {
            path: '/actual/new',
            requested_path: '/requested/new',
            kind: 'directory',
            action: 'create',
          },
          { path: '/actual/new/a.txt', kind: 'file', action: 'create' },
          { path: '/actual/b.txt', kind: 'file', action: 'update' },
        ],
      },
      tool: { effects: ['write', 'destructive'] },
      arguments: { path: '/do-not-display' },
    }),
  )
  assert.equal(summary.recognized, true)
  assert.ok(
    summary.fields.some((field) => field.label === '创建目录' && field.value === '/actual/new'),
  )
  assert.ok(
    summary.fields.some(
      (field) => field.label === '创建文件' && field.value === '/actual/new/a.txt',
    ),
  )
  assert.ok(
    summary.fields.some(
      (field) => field.label === '操作影响' && field.value === '删除或大范围覆盖',
    ),
  )
  assert.ok(!summary.fields.some((field) => field.value === '/do-not-display'))
  assert.equal(
    approvalSummary(
      JSON.stringify({
        plan: { targets: [{ path: '/a', kind: 'file', action: 'future-operation' }] },
      }),
    ).recognized,
    false,
  )
})
