import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtemp,
  mkdir,
  copyFile,
  chmod,
  readFile,
  realpath,
  writeFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { ChatService, resolveBackendExecutable } from '../../src/main/backend/chat-service.ts'
import { resolveRuntimeDirectory } from '../../src/main/backend/runtime-assets.ts'
import {
  backendExecutable,
  createRuntimeFixture,
  resourceRoot,
  seedModel,
  supportedBackend,
} from '../helpers/backend.ts'
import { array, record } from '../../src/shared/chat.ts'
import type { ChatEvent, SendMessageResult } from '../../src/shared/chat.ts'

test('解释器资源按四个平台的匹配架构选择离线解压目录', () => {
  const root = join(tmpdir(), 'resource root with spaces')
  for (const platform of ['darwin', 'win32'] as const) {
    for (const arch of ['x64', 'arm64']) {
      assert.equal(
        resolveRuntimeDirectory(root, platform, arch),
        join(root, 'runtimes', 'unpacked', `${platform}-${arch}`),
      )
    }
  }
  assert.throws(() => resolveRuntimeDirectory('relative'), /绝对路径/)
  assert.throws(() => resolveRuntimeDirectory(root, 'linux', 'x64'), /没有适用于/)
  assert.throws(() => resolveRuntimeDirectory(root, 'win32', 'ia32'), /没有适用于/)
})

test(
  '模型每轮收到内置解释器入口和直接调用示例，真实 Python/Node 沿 Go 沙箱执行',
  { skip: !supportedBackend },
  async () => {
    const results: string[] = []
    const instructions: string[] = []
    const runtimeRoot = await realpath(resolveRuntimeDirectory(resourceRoot))
    const manifest = record(JSON.parse(await readFile(join(runtimeRoot, 'manifest.json'), 'utf8')))
    const entries = [record(manifest.python), record(manifest.node)].map((entry) =>
      join(runtimeRoot, String(entry.path)),
    )
    const profile = await mkdtemp(join(tmpdir(), 'callum-bundled-runtime-'))
    const upstream = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const input = record(JSON.parse(Buffer.concat(chunks).toString()))
        if (Array.isArray(input.tools) && input.tools.length > 0) {
          const commandTool = array(input.tools, record)
            .map((tool) => record(tool.function))
            .find((tool) => tool.name === 'run_command')
          instructions.push(String(commandTool?.description ?? ''))
        }
        const messages = array(input.messages, record)
        const last = messages.at(-1)
        let message: Record<string, unknown> = { role: 'assistant', content: '运行时验证' }
        let reason = 'stop'
        if (last?.role === 'tool') {
          results.push(String(last.content))
          message.content = '内置解释器已完成'
        } else if (Array.isArray(input.tools) && input.tools.length > 0) {
          const text =
            typeof last?.content === 'string'
              ? last.content
              : array(last?.content, record)
                  .map((part) => part.text)
                  .join('')
          const python = text === 'python'
          message = {
            role: 'assistant',
            tool_calls: [
              {
                ...(input.stream === true ? { index: 0 } : {}),
                id: `runtime-${text}`,
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: JSON.stringify({
                    command: python
                      ? [
                          'python3',
                          '-c',
                          'import sys; assert "runtimes" in sys.executable; print(sys.version.split()[0])',
                        ]
                      : [
                          'node',
                          '-e',
                          'if(!process.execPath.includes("runtimes"))process.exit(2);console.log(process.version)',
                        ],
                    cwd: profile,
                  }),
                },
              },
            ],
          }
          reason = 'tool_calls'
        }
        if (input.stream === true) {
          response.setHeader('Content-Type', 'text/event-stream')
          response.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
          )
        } else {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: reason }] }))
        }
      })().catch(() => response.writeHead(500).end())
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    assert.ok(address && typeof address !== 'string')
    let service: ChatService | undefined
    try {
      const modelId = await seedModel(profile, `http://127.0.0.1:${address.port}/v1`)
      service = new ChatService(join(profile, 'backend'), resourceRoot)
      const events: ChatEvent[] = []
      service.subscribe((event) => events.push(event))
      for (const text of ['python', 'node']) {
        const accepted: SendMessageResult = await service.send({
          conversationId: null,
          modelId,
          text,
        })
        const deadline = Date.now() + 12_000
        while (
          !events.some(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === accepted.runId &&
              event.change.value.status === 'completed',
          )
        ) {
          const failure: ChatEvent | undefined = events.find(
            (event) =>
              event.change.kind === 'run' &&
              event.change.value.id === accepted.runId &&
              ['failed', 'cancelled'].includes(event.change.value.status),
          )
          assert.equal(failure, undefined, JSON.stringify(failure))
          assert.ok(Date.now() < deadline, JSON.stringify(events.slice(-8)))
          await setTimeout(20)
        }
      }
      assert.equal(results.length, 2)
      assert.ok(instructions.length >= 4, '两次执行的工具调用前后均应携带调用指引')
      for (const description of instructions) {
        for (const entry of entries) assert.ok(description.includes(JSON.stringify(entry)))
        assert.ok(description.includes('["python3","-c","print(1)"]'))
        assert.ok(description.includes('["node","-e","console.log(1)"]'))
      }
      assert.match(results[0] ?? '', /3\.14\.10/)
      assert.match(results[1] ?? '', /v26\.13\.0/)
      for (const result of results) {
        assert.match(result, /"exit_code":0/)
        assert.match(result, /"cleanup_complete":true/)
      }
    } finally {
      await service?.close()
      upstream.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(profile, { recursive: true, force: true })
    }
  },
)

test('运行时缺失、清单损坏均阻止服务就绪，修复后可重试', { skip: !supportedBackend }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'callum-runtime-startup-'))
  const resources = join(profile, 'resources with spaces')
  const executable = resolveBackendExecutable(resources)
  await mkdir(dirname(executable), { recursive: true })
  await copyFile(backendExecutable, executable)
  await chmod(executable, 0o755)
  const service = new ChatService(join(profile, 'private-data'), resources)
  try {
    await assert.rejects(service.overview(0), /内置 Python\/Node/)
    const runtimeRoot = await createRuntimeFixture(resources)
    await writeFile(join(runtimeRoot, 'node', 'extra-file'), 'unlisted')
    assert.equal((await service.retryStart()).status, 'startup-failed')
    assert.match(String(Reflect.get(service, 'error')), /内置 Python\/Node 资源校验失败/)
    await rm(join(runtimeRoot, 'node', 'extra-file'))
    assert.equal((await service.retryStart()).status, 'ready')
    assert.deepEqual(await service.catalog.list(), { providers: [], models: [] })
  } finally {
    await service.close()
    await rm(profile, { recursive: true, force: true })
  }
})
