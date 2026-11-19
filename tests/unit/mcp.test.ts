import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpService } from '../../src/main/backend/mcp-service.ts'
import { editableMcpConfig, mcpConfigForSave, parseMcpConfig } from '../../src/shared/mcp-config.ts'
import type { McpServerView } from '../../src/shared/mcp.ts'
import { parseMcpResponse } from '../../src/shared/mcp.ts'
import { approvalSummary } from '../../src/shared/approval-summary.ts'

const serverId = '01951234-0000-7000-8000-123456789abc'

test('MCP OAuth 浏览器地址只在主进程使用', async () => {
  const called: string[] = []
  const service = new McpService(async (method) => {
    called.push(method)
    return { status: 'pending', url: 'https://auth.example.com/authorize?state=private-state' }
  })
  const value = await service.run({ action: 'start', id: serverId }, async (url) => {
    assert.match(url, /^https:\/\/auth\.example\.com\//)
  })
  assert.deepEqual(value, { status: 'pending' })
  assert.deepEqual(called, ['mcp.oauth.start'])
})

test('MCP OAuth 打开失败后结束待授权状态', async () => {
  const called: string[] = []
  const service = new McpService(async (method) => {
    called.push(method)
    return { status: 'pending', url: 'file:///tmp/oauth' }
  })
  await assert.rejects(
    service.run({ action: 'start', id: serverId }, async () => assert.fail('打开了不支持的地址')),
    /无法打开 MCP 授权页面/,
  )
  assert.deepEqual(called, ['mcp.oauth.start', 'mcp.oauth.cancel'])
})

test('MCP 配置返回值只包含公开字段，审批展示固定的服务和工具参数', () => {
  const value = parseMcpResponse('list', {
    revision: 1,
    servers: [
      {
        id: serverId,
        name: '回显',
        enabled: true,
        transport: 'streamable_http',
        auth: 'oauth',
        url: 'https://mcp.example.com/mcp',
        allowed_tools: ['echo'],
        secret_env_keys: [],
        tools: [],
        connected: true,
        authorized: true,
        token: 'sensitive',
      },
    ],
  })
  assert.doesNotMatch(JSON.stringify(value), /sensitive/)
  const summary = approvalSummary(
    JSON.stringify({
      tool: { source: 'mcp', effects: ['unknown'] },
      arguments: { text: '示例' },
      details: {
        kind: 'mcp',
        server_name: '回显',
        tool_name: 'echo',
        target: 'https://mcp.example.com/mcp',
      },
    }),
  )
  assert.equal(summary.mcpTool, 'echo')
  assert(summary.fields.some((field) => field.label === '工具参数' && field.value.includes('示例')))
  assert(summary.fields.some((field) => field.label === 'MCP 服务' && field.value === '回显'))
})

test('MCP JSON 可以从多服务配置选择一项，只有被选中的配置会投影到保存接口', () => {
  const [local, remote, incompatible] = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        本地: {
          command: 'C:\\Program Files\\nodejs\\node.exe',
          args: ['fixture', '', '空格 参数'],
          cwd: 'C:\\project',
          env: { API_KEY: 'local-secret' },
        },
        远程: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { authorization: 'Bearer test-token' },
        },
        旧服务: { type: 'sse', url: 'https://mcp.example.com/sse' },
      },
    }),
  )
  assert(local && remote && incompatible)
  const stdio = mcpConfigForSave(local)
  assert.equal(stdio.server.name, '本地')
  assert.equal(stdio.server.enabled, false)
  assert.equal(stdio.server.directory, 'C:\\project')
  assert.deepEqual(stdio.server.args, ['fixture', '', '空格 参数'])
  assert.deepEqual(stdio.secrets.env, { API_KEY: 'local-secret' })
  assert.doesNotMatch(JSON.stringify(stdio.server), /local-secret/)
  const http = mcpConfigForSave(remote)
  assert.equal(http.server.transport, 'streamable_http')
  assert.equal(http.server.auth, 'token')
  assert.deepEqual(http.secrets, { token: 'test-token' })
  assert.doesNotMatch(JSON.stringify(http.server), /test-token/)
  assert.throws(() => mcpConfigForSave(incompatible), /type/)
})

test('MCP JSON 编辑回填公开配置，保存时保留已有凭据并支持重新填写', () => {
  const remote: McpServerView = {
    id: serverId,
    name: '远程',
    enabled: true,
    transport: 'streamable_http',
    auth: 'token',
    url: 'https://example.com/mcp',
    authorized: true,
    connected: true,
    secret_env_keys: [],
    tools: [],
    allowed_tools: ['echo'],
  }
  const [saved] = parseMcpConfig(editableMcpConfig(remote))
  assert(saved)
  const edit = mcpConfigForSave(saved, remote)
  assert.equal(edit.server.id, serverId)
  assert.equal(edit.server.auth, 'token')
  assert.deepEqual(edit.server.allowed_tools, ['echo'])
  assert.deepEqual(edit.secrets, {})
  const local: McpServerView = {
    ...remote,
    name: '本地',
    transport: 'stdio',
    auth: 'none',
    command: '/usr/bin/node',
    env: { LANG: 'zh_CN.UTF-8' },
    secret_env_keys: ['API_KEY'],
  }
  const json = editableMcpConfig(local)
  assert.doesNotMatch(json, /API_KEY/)
  const [entry] = parseMcpConfig(json)
  assert(entry)
  assert.deepEqual(mcpConfigForSave(entry, local).server.env, local.env)
  assert.deepEqual(mcpConfigForSave(entry, local).secrets, {})
  assert.deepEqual(
    mcpConfigForSave({ name: '本地', value: { command: '/usr/bin/node', env: {} } }, local).secrets
      .env,
    {},
  )
})

test('MCP JSON 校验格式、路径、HTTPS、OAuth 回调和无法映射的字段', () => {
  assert.throws(() => parseMcpConfig('{'), /JSON 格式/)
  assert.throws(() => parseMcpConfig('{"mcpServers":[]}'), /mcpServers/)
  const invalidCases: [Record<string, unknown>, RegExp][] = [
    [{ command: 'npx' }, /command.*绝对路径/],
    [{ type: null, command: '/usr/bin/node' }, /type/],
    [{ url: 'https://example.com/mcp', auth: null }, /auth/],
    [{ command: '/usr/bin/node', args: [3] }, /args/],
    [{ command: '/usr/bin/node', env: { KEY: 4 } }, /env/],
    [{ url: 'http://example.com/mcp' }, /HTTPS/],
    [{ url: 'https://name:pass@example.com/mcp' }, /凭据/],
    [{ url: 'https://example.com/mcp?key=secret' }, /查询参数/],
    [{ url: 'https://example.com/mcp', headers: { 'X-API-Key': 'secret' } }, /Authorization/],
    [
      { url: 'https://example.com/mcp', auth: 'oauth', redirectUri: 'http://127.0.0.1:0/callback' },
      /redirectUri/,
    ],
    [{ command: '/usr/bin/node', enabled: true }, /enabled/],
  ]
  for (const [value, error] of invalidCases)
    assert.throws(() => mcpConfigForSave({ name: '测试', value }), error)
  const oauth = mcpConfigForSave({
    name: 'OAuth',
    value: {
      url: 'https://example.com/mcp',
      auth: 'oauth',
      clientId: 'registered-client',
      redirectUri: 'http://127.0.0.1:8080/callback',
    },
  })
  assert.equal(oauth.server.auth, 'oauth')
  assert.equal(oauth.server.client_id, 'registered-client')
  assert.equal(oauth.server.redirect_uri, 'http://127.0.0.1:8080/callback')
})
