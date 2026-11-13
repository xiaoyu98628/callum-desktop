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
  '模型每轮收到命令选择规则，直接调用内置命令并独立使用目录工具',
  { skip: !supportedBackend },
  async () => {
    const results: string[] = []
    const instructions: string[] = []
    const rejections: string[] = []
    let correctionSeen = false
    const runtimeRoot = await realpath(resolveRuntimeDirectory(resourceRoot))
    const manifest = record(JSON.parse(await readFile(join(runtimeRoot, 'manifest.json'), 'utf8')))
    const profile = await mkdtemp(join(tmpdir(), 'callum-bundled-runtime-'))
    const installedRoot = join(await realpath(profile), 'backend', 'runtimes')
    const entries = [record(manifest.python), record(manifest.node), record(manifest.git)].map(
      (entry) => join(installedRoot, String(entry.path)),
    )
    const workspace = join(profile, 'workspace with spaces')
    await mkdir(workspace)
    await writeFile(join(workspace, 'marker.txt'), 'directory fixture')
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
        const correction = messages.some(
          (item) =>
            item.role === 'system' && String(item.content).includes('服务端工具参数校验反馈'),
        )
        if (correction) correctionSeen = true
        assert.ok(
          !JSON.stringify(messages).includes('runtime-invalid-json'),
          '坏批次不应进入后续上下文',
        )
        const user = messages.findLast((item) => item.role === 'user')
        const text =
          typeof user?.content === 'string'
            ? user.content
            : array(user?.content, record)
                .map((part) => part.text)
                .join('')
        const toolError =
          last?.role === 'tool' ? record(JSON.parse(String(last.content))).error : undefined
        const rejected = toolError === undefined ? undefined : record(toolError)
        let message: Record<string, unknown> = { role: 'assistant', content: '运行时验证' }
        let reason = 'stop'
        if (last?.role === 'tool' && rejected === undefined) {
          let firstTool = messages.length - 1
          while (firstTool > 0 && messages[firstTool - 1]?.role === 'tool') firstTool--
          results.push(...messages.slice(firstTool).map((item) => String(item.content)))
          message.content = '内置解释器已完成'
        } else if (Array.isArray(input.tools) && input.tools.length > 0) {
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
                    command:
                      text === 'git'
                        ? ['git', '--version']
                        : python
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
                    cwd: workspace,
                  }),
                },
              },
              ...(text === 'git'
                ? [
                    {
                      ...(input.stream === true ? { index: 1 } : {}),
                      id: 'runtime-git-directory',
                      type: 'function',
                      function: {
                        name: 'list_directory',
                        arguments: JSON.stringify({ path: workspace, limit: 40 }),
                      },
                    },
                  ]
                : []),
            ],
          }
          if (text === 'git' && rejected === undefined && !correction) {
            message.tool_calls = [
              {
                ...(input.stream === true ? { index: 0 } : {}),
                id: 'runtime-invalid-valid',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: JSON.stringify({ command: ['git', '--version'], cwd: workspace }),
                },
              },
              {
                ...(input.stream === true ? { index: 1 } : {}),
                id: 'runtime-invalid-json',
                type: 'function',
                function: { name: 'run_command', arguments: '{"["string""]</｜｜DSML｜｜: ' },
              },
            ]
          } else if (text === 'git' && correction) {
            message.tool_calls = [
              {
                ...(input.stream === true ? { index: 0 } : {}),
                id: 'runtime-simple-shell',
                type: 'function',
                function: {
                  name: 'run_command',
                  arguments: JSON.stringify({
                    command: ['sh', '-c', 'git --version; echo header; ls'],
                    cwd: workspace,
                  }),
                },
              },
            ]
          } else if (text === 'git' && rejected !== undefined) {
            assert.equal(rejected.kind, 'invalid_arguments')
            const error = String(rejected.message)
            rejections.push(error)
            if (error.includes('sh/bash -c')) {
              message.tool_calls = [
                {
                  ...(input.stream === true ? { index: 0 } : {}),
                  id: 'runtime-wrong-command-type',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({ command: '["git","--version"]', cwd: workspace }),
                  },
                },
              ]
            } else assert.ok(error.includes('字符串数组'))
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
      for (const text of ['python', 'node', 'git']) {
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
      assert.equal(results.length, 4)
      assert.equal(rejections.length, 2)
      assert.equal(correctionSeen, true)
      assert.ok(instructions.length >= 9, '三次执行的工具调用前后均应携带调用指引')
      for (const description of instructions) {
        for (const entry of entries) assert.ok(description.includes(JSON.stringify(entry)))
        assert.ok(description.includes('["python3","-c","print(1)"]'))
        assert.ok(description.includes('["node","-e","console.log(1)"]'))
        assert.ok(description.includes('["git","status","--short"]'))
        assert.ok(description.includes('多个独立操作分别发起工具调用'))
        assert.ok(description.includes('查看目录优先使用 list_directory'))
        assert.ok(description.includes('确需管道、重定向、条件控制等 Shell 语法'))
        assert.ok(description.includes('Shell 字符串里的程序不会经过裸命令固定映射'))
      }
      assert.match(results[0] ?? '', /3\.12\.14/)
      assert.match(results[1] ?? '', /v26\.13\.0/)
      assert.match(results[2] ?? '', /git version 2\.56\.1/)
      const directory = record(record(JSON.parse(results[3] ?? '{}')).result)
      assert.deepEqual(
        array(directory.entries, record).map((entry) => entry.name),
        ['marker.txt'],
      )
      assert.equal(directory.truncated, false)
      for (const result of results.slice(0, 3)) {
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
    await assert.rejects(service.overview(0), /内置 Python\/Node\/Git/)
    const runtimeRoot = await createRuntimeFixture(resources)
    await writeFile(join(runtimeRoot, 'node', 'extra-file'), 'unlisted')
    assert.equal((await service.retryStart()).status, 'startup-failed')
    assert.match(String(Reflect.get(service, 'error')), /无法安装内置运行时/)
    await rm(join(runtimeRoot, 'node', 'extra-file'))
    assert.equal((await service.retryStart()).status, 'ready')
    assert.deepEqual(await service.catalog.list(), { providers: [], models: [] })
  } finally {
    await service.close()
    await rm(profile, { recursive: true, force: true })
  }
})
