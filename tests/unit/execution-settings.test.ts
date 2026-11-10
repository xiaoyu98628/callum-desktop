import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import {
  parseExecutionSettings,
  executionSettingsFromRpc,
  withApprovalMode,
  approvalMode,
} from '../../src/shared/execution.ts'
import { approvalSummary } from '../../src/shared/approval-summary.ts'
import { ChatService } from '../../src/main/backend/chat-service.ts'
import { resourceRoot, seedModel, supportedBackend } from '../helpers/backend.ts'
import { startModelServer } from '../helpers/model-server.ts'

test('权限桥接拒绝未展示的权限、无效版本和审批人', () => {
  const valid = parseExecutionSettings({
    revision: 1,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  })
  assert.equal(approvalMode(valid), 'request')
  const assisted = withApprovalMode(valid, 'assist')
  assert.equal(approvalMode(parseExecutionSettings(assisted)), 'assist')
  const full = withApprovalMode(assisted, 'full')
  assert.equal(approvalMode(parseExecutionSettings(full)), 'full')
  assert.deepEqual(withApprovalMode(full, 'request'), valid)
  assert.equal(approvalMode({ ...valid, approvalPolicy: 'never' }), null)
  for (const value of [
    { ...valid, revision: 0 },
    { ...valid, sandboxMode: 'full-access' },
    { ...valid, approvalPolicy: 'allow-all' },
    { ...valid, approvalsReviewer: 'untrusted' },
    { ...valid, sandboxMode: 'danger-full-access' },
  ])
    assert.throws(() => parseExecutionSettings(value))
  assert.throws(() =>
    executionSettingsFromRpc({
      key: 'execution',
      revision: 1,
      value: {
        approval_policy: 'never',
        sandbox_mode: 'read-only',
        approvals_reviewer: 'auto_review',
      },
    }),
  )
})

test('审批展示区分只读、项目写入和沙箱外执行', () => {
  const summary = (sandboxed: boolean, escalated: boolean, mode = 'workspace-write') =>
    approvalSummary(
      JSON.stringify({
        details: {
          executable: '/bin/pwd',
          cwd: '/project',
          justification: '受控原因',
          execution_boundary: { sandboxed, escalated, sandbox_mode: mode },
          writable_roots: mode === 'workspace-write' ? ['/project'] : [],
        },
      }),
    )
  assert.match(summary(true, false, 'read-only').executionNotice ?? '', /只读沙箱/)
  const project = summary(true, false)
  assert.match(project.executionNotice ?? '', /可修改或删除项目内的文件/)
  assert.deepEqual(
    project.fields.find((field) => field.label === '可写项目'),
    {
      label: '可写项目',
      value: '/project',
    },
  )
  assert.match(summary(false, true).executionNotice ?? '', /本次请求在沙箱外运行/)
  assert.match(summary(false, true).executionNotice ?? '', /不会保存/)
  assert.match(summary(false, false).executionNotice ?? '', /未使用系统沙箱/)
})

test(
  '真实 Windows Go：只读自动执行、项目写入审批和完全访问按执行快照生效',
  { skip: !supportedBackend || process.platform !== 'win32' },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-windows-command-'))
    const upstream = await startModelServer(join(profile, 'fixture.txt'))
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const workspace = await service.createWorkspace({
        name: 'Windows 沙箱项目',
        rootPath: profile,
      })
      async function wait(
        conversationId: string,
        check: (detail: Awaited<ReturnType<ChatService['detail']>>) => boolean,
      ) {
        for (const deadline = Date.now() + 10_000; ;) {
          const detail = await service!.detail(conversationId)
          if (check(detail)) return detail
          if (Date.now() > deadline) throw new Error('等待 Windows 命令执行状态超时')
          await setTimeout(20)
        }
      }
      const reading = await service.send({ conversationId: null, modelId, text: '沙箱 pwd' })
      const readingDetail = await wait(reading.conversationId, (value) =>
        value.runs.some((run) => run.id === reading.runId && run.status === 'completed'),
      )
      assert.equal(readingDetail.approvals.length, 0)
      const pending = await service.send({
        conversationId: null,
        workspaceId: workspace.id,
        modelId,
        text: '沙箱申请项目写入',
      })
      const detail = await wait(pending.conversationId, (value) => value.approvals.length > 0)
      const approval = detail.approvals[0]!
      assert.equal(approval.status, 'pending')
      assert.match(approvalSummary(approval.snapshot).executionNotice ?? '', /系统沙箱内运行/)
      assert.ok(
        approvalSummary(approval.snapshot).fields.some((field) => field.label === '可读目录'),
      )
      const initial = await service.executionSettings()
      const blocked = await service.updateExecutionSettings({
        ...initial,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      })
      await service.decide(approval.id, 'approved')
      const completed = await wait(pending.conversationId, (value) =>
        value.runs.some((run) => run.id === pending.runId && run.status === 'completed'),
      )
      assert.equal(completed.approvals[0]?.status, 'approved')
      const steps = await service.listSteps(pending.conversationId, pending.runId, 0)
      const command = steps.steps.find((step) => step.name === 'run_command')!
      const raw = await service.stepDetails(pending.conversationId, pending.runId, command.id)
      assert.equal(JSON.parse(raw.output).result.exit_code, 0)
      const denied = await service.send({
        conversationId: null,
        workspaceId: workspace.id,
        modelId,
        text: '沙箱申请项目写入',
      })
      const deniedDetail = await wait(denied.conversationId, (value) =>
        value.runs.some((run) => run.id === denied.runId && run.status === 'completed'),
      )
      assert.equal(deniedDetail.approvals.length, 0)
      assert.ok(
        deniedDetail.messages.some((message) =>
          message.content.some((block) => block.text === '操作已拒绝。'),
        ),
      )
      const full = await service.updateExecutionSettings(withApprovalMode(blocked, 'full'))
      const accepted = await service.send({ conversationId: null, modelId, text: '命令成功步骤' })
      const fullDetail = await wait(accepted.conversationId, (value) =>
        value.runs.some((run) => run.id === accepted.runId && run.status === 'completed'),
      )
      assert.equal(fullDetail.approvals.length, 0)
      await service.close()
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      assert.deepEqual(await service.executionSettings(), full)
      assert.equal((await service.detail(pending.conversationId)).approvals[0]?.status, 'approved')
    } finally {
      await service?.close()
      await upstream.close()
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
)

test(
  '真实 Go：沙箱自动执行、越界拒绝、提权审批、权限版本和任务快照',
  { skip: !supportedBackend },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-sandbox-integration-'))
    await mkdir(join(profile, 'project'))
    const fixture = join(profile, 'project', 'fixture.txt')
    await writeFile(fixture, 'controlled-file')
    let service: ChatService | undefined
    const upstream = await startModelServer(fixture)
    try {
      const modelId = await seedModel(profile, upstream.baseUrl)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const workspace = await service.createWorkspace({
        name: '受控项目',
        rootPath: join(profile, 'project'),
      })
      async function wait(
        id: string,
        check: (detail: Awaited<ReturnType<ChatService['detail']>>) => boolean,
      ) {
        for (const deadline = Date.now() + 7000; ;) {
          const detail = await service!.detail(id)
          if (check(detail)) return detail
          if (Date.now() > deadline) throw new Error('等待沙箱执行状态超时')
          await setTimeout(20)
        }
      }
      async function send(text: string) {
        return service!.send({ conversationId: null, workspaceId: workspace.id, modelId, text })
      }
      async function report(text: string) {
        const run = await send(text)
        const detail = await wait(run.conversationId, (d) =>
          d.runs.some((r) => r.id === run.runId && r.status === 'completed'),
        )
        assert.equal(detail.approvals.length, 0)
        const step = (await service!.listSteps(run.conversationId, run.runId, 0)).steps.find(
          (s) => s.name === 'run_command',
        )!
        const raw = await service!.stepDetails(run.conversationId, run.runId, step.id)
        return (
          JSON.parse(raw.output) as {
            result: { exit_code: number; execution_boundary: { sandboxed: boolean } }
          }
        ).result
      }
      const initial = await service.executionSettings()
      assert.equal(initial.sandboxMode, 'workspace-write')
      assert.equal((await report('沙箱 pwd')).exit_code, 0)
      assert.notEqual((await report('沙箱项目写入')).exit_code, 0)
      const marker = join(profile, 'project', 'sandbox-write.txt')
      await assert.rejects(readFile(marker))
      const writing = await send('沙箱申请项目写入')
      const writingDetail = await wait(writing.conversationId, (d) => d.approvals.length > 0)
      const projectApproval = writingDetail.approvals[0]!
      const summary = approvalSummary(projectApproval.snapshot)
      assert.match(summary.executionNotice ?? '', /可修改或删除项目内的文件/)
      assert.equal(
        summary.fields.find((field) => field.label === '可写项目')?.value,
        workspace.rootPath,
      )
      await assert.rejects(readFile(marker))
      await service.decide(projectApproval.id, 'approved')
      await wait(writing.conversationId, (d) =>
        d.runs.some((r) => r.id === writing.runId && r.status === 'completed'),
      )
      assert.equal(
        await readFile(join(profile, 'project', 'sandbox-write.txt'), 'utf8'),
        'controlled',
      )
      const outside = await report('沙箱项目外写入')
      assert.equal(outside.execution_boundary.sandboxed, true)
      assert.notEqual(outside.exit_code, 0)
      await assert.rejects(readFile(join(profile, 'outside.txt')))
      const pending = await send('沙箱提权')
      const detail = await wait(pending.conversationId, (d) => d.approvals.length > 0)
      const approval = detail.approvals[0]!
      assert.match(approvalSummary(approval.snapshot).executionNotice ?? '', /本次请求在沙箱外运行/)
      const saved = await service.updateExecutionSettings({
        ...initial,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      })
      await assert.rejects(service.updateExecutionSettings(initial), /设置已被修改/)
      await service.decide(approval.id, 'approved')
      await wait(pending.conversationId, (d) =>
        d.runs.some((r) => r.id === pending.runId && r.status === 'completed'),
      )
      assert.equal(await readFile(join(profile, 'outside.txt'), 'utf8'), 'controlled')
      assert.notEqual((await report('沙箱项目写入')).exit_code, 0)
      assert.equal((await service.executionSettings()).revision, saved.revision)
      await service.close()
      service = undefined
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      assert.deepEqual(await service.executionSettings(), saved)
    } finally {
      await service?.close()
      await upstream.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
)
