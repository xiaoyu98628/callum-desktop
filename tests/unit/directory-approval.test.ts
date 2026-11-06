import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalFromRpc, directoryGrantFromRpc } from '../../src/main/backend/protocol-mapper.ts'
import { parseChatEvent } from '../../src/shared/chat.ts'
const uuid = '019a4f39-0000-7000-8000-000000000001'

test('目录授权选项来自服务端审批字段，不能从工具参数或原始快照推断', () => {
  const row = {
    id: uuid,
    run_id: uuid,
    status: 'pending',
    request: {
      tool: { name: 'read_file' },
      directory_scope: { root_path: '/fixed', access: 'read_write' },
    },
  }
  assert.equal(approvalFromRpc(row, uuid).directoryScope, null)
  assert.deepEqual(
    approvalFromRpc({ ...row, directory_scope: { root_path: '/fixed', access: 'read' } }, uuid)
      .directoryScope,
    { rootPath: '/fixed', access: 'read' },
  )
  assert.throws(() =>
    approvalFromRpc({ ...row, directory_scope: { root_path: '/fixed', access: 'all' } }, uuid),
  )
})
test('目录授权通知保留会话和审批来源，拒绝非法授权类别和撤销时间', () => {
  const row = {
    id: uuid,
    conversation_id: uuid,
    approval_id: uuid,
    scope: { root_path: '/fixed', access: 'read_write' },
    created_at: 1,
    revoked_at: null,
  }
  const grant = directoryGrantFromRpc(row)
  assert.equal(grant.conversationId, uuid)
  assert.equal(grant.approvalId, uuid)
  assert.deepEqual(
    parseChatEvent({ revision: 1, change: { kind: 'directory-grant', value: grant } }).change,
    { kind: 'directory-grant', value: grant },
  )
  assert.throws(() => directoryGrantFromRpc({ ...row, revoked_at: -1 }))
  assert.throws(() =>
    directoryGrantFromRpc({ ...row, scope: { root_path: '/fixed', access: 'external' } }),
  )
})
