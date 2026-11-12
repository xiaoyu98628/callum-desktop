import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { array, record, string } from '../../src/shared/chat.ts'
import { MARKDOWN_START, MARKDOWN_END, MARKDOWN_UNSAFE } from './markdown-fixture.ts'

/** 响应形状取自 Go 仓库 internal/app/agent_test.go；只验证客户端对受控端点的行为。 */
export async function startModelServer(fixturePath: string, expectedApiKey?: string) {
  const requests: {
    stream: boolean
    lastRole: string
    text: string
    expectedAuthorization: boolean
    processInstructions: boolean
    reasoningReturned: boolean
    summaryRequest: boolean
    contextSummary: boolean
    messageCount: number
    images?: string[]
  }[] = []
  let compactionRound = 0
  let pauseCompaction = false
  let pauseCompactionAnswer = false
  const compactionContinuations = new Set<(success: boolean) => void>()
  const compactionAnswerContinuations = new Set<() => void>()
  let cancelled = 0
  let writeSequence = 0
  const markdownContinuations = new Set<() => void>()
  const approvalContinuations = new Set<() => void>()
  const processContinuations = new Set<() => void>()
  const streamingResponses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(501).end()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) throw new Error('请求过长')
        chunks.push(Buffer.from(chunk))
      }
      const input = record(JSON.parse(Buffer.concat(chunks).toString()) as unknown)
      const messages = array(input.messages, record),
        last = messages.at(-1)
      if (!last) throw new Error('消息为空')
      const role = string(last.role),
        parts = Array.isArray(last.content) ? array(last.content, record) : [],
        text =
          typeof last.content === 'string'
            ? last.content
            : parts
                .filter((part) => part.type === 'text')
                .map((part) => string(part.text))
                .join('')
      const images = parts
        .filter((part) => part.type === 'image_url')
        .map((part) => string(record(part.image_url).url))
      const summaryRequest =
        typeof messages[0]?.content === 'string' &&
        messages[0].content.startsWith('你负责压缩对话历史')
      requests.push({
        summaryRequest,
        contextSummary: messages.some(
          (message) =>
            typeof message.content === 'string' &&
            (message.content.includes('execution_context_summary') ||
              message.content.includes('conversation_context_summary')),
        ),
        messageCount: messages.length,
        ...(images.length ? { images } : {}),
        reasoningReturned: messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.reasoning_content === '核对调用结果，再决定下一步。',
        ),
        stream: input.stream === true,
        lastRole: role,
        text,
        processInstructions:
          messages[0]?.role === 'system' &&
          typeof messages[0]?.content === 'string' &&
          messages[0].content.includes('正文 content'),
        expectedAuthorization:
          expectedApiKey !== undefined &&
          request.headers.authorization === `Bearer ${expectedApiKey}`,
      })
      if (summaryRequest) {
        const complete = (success: boolean): void => {
          compactionContinuations.delete(complete)
          if (!success) {
            response.setHeader('Content-Type', 'application/json')
            response.end(
              JSON.stringify({
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: '结构不合法的摘要' },
                    finish_reason: 'stop',
                  },
                ],
              }),
            )
            return
          }
          response.setHeader('Content-Type', 'application/json')
          response.end(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      goals: ['完成长任务'],
                      constraints: ['保留当前要求'],
                      decisions: [],
                      facts: ['早期读取批次已完成，原始结果保存在步骤中'],
                      open_questions: [],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { total_tokens: 17 },
            }),
          )
        }
        if (pauseCompaction) {
          compactionContinuations.add(complete)
          response.once('close', () => compactionContinuations.delete(complete))
        } else complete(true)
        return
      }
      if (input.stream !== true) {
        const isReview =
          typeof messages[0]?.content === 'string' && messages[0].content.startsWith('你独立审核')
        const handoff = isReview && text.includes('AI 审批转人工')
        const content = isReview
          ? JSON.stringify({
              decision: handoff ? 'handoff' : 'approved',
              reason: handoff ? '受控审核需要用户确认。' : '用户明确要求查看当前目录。',
            })
          : ''
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }),
        )
        return
      }
      if (text.includes('失败')) {
        response
          .writeHead(503, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: '受控服务暂不可用' } }))
        return
      }
      response.setHeader('Content-Type', 'text/event-stream')
      response.setHeader('Cache-Control', 'no-cache')
      response.flushHeaders()
      if (role === 'user' && (text === 'AI 审批目录' || text === 'AI 审批转人工')) {
        emit(response, {
          tool_calls: [
            {
              index: 0,
              id: 'call-review-command',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  command: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
                  cwd: dirname(fixturePath),
                }),
              },
            },
          ],
        })
        finish(response, 'tool_calls')
        return
      }
      if (text === '思考等待' || text === '思考长内容') {
        emit(response, { reasoning_content: '这是独立推理，' })
        emit(response, {
          reasoning_content:
            text === '思考长内容'
              ? '\n\n' +
                Array.from(
                  { length: 40 },
                  (_, index) =>
                    `检查步骤 ${index + 1}：核对当前输入与操作约束，然后验证已获得的结果。`,
                ).join('\n\n')
              : '等待后续结果。',
        })
        streamingResponses.add(response)
        response.once('close', () => streamingResponses.delete(response))
        return
      }
      if (text === '连续流渲染') {
        emit(response, {
          content:
            '# 连续流渲染\n\n' +
            Array.from(
              { length: 12 },
              (_, index) =>
                `稳定段落 ${index}。\n\n\`\`\`typescript\nconst fixed${index} = ${index};\n\`\`\`\n\n`,
            ).join('') +
            '连续正文：',
        })
        streamingResponses.add(response)
        response.once('close', () => streamingResponses.delete(response))
        return
      }
      if (
        messages.some((message) => message.role === 'user' && message.content === '自动压缩长任务')
      ) {
        const complete = (): void => {
          compactionAnswerContinuations.delete(complete)
          if (compactionRound >= 140) {
            emit(response, { content: '长任务自动压缩完成。' })
            finish(response)
          } else {
            compactionRound++
            for (let index = 0; index < 2; index++)
              emit(response, {
                tool_calls: [
                  {
                    index,
                    id: `compact-${compactionRound}-${index}`,
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: fixturePath }),
                    },
                  },
                ],
              })
            finish(response, 'tool_calls')
          }
        }
        // 在压缩后首个主模型请求暂停，让回归观察已提交状态；放行后完整执行剩余工具。
        if (
          pauseCompactionAnswer &&
          messages.some(
            (message) =>
              typeof message.content === 'string' &&
              message.content.includes('execution_context_summary'),
          )
        ) {
          pauseCompactionAnswer = false
          compactionAnswerContinuations.add(complete)
          response.once('close', () => compactionAnswerContinuations.delete(complete))
        } else complete()
        return
      }
      const lastUser = messages.findLast((message) => message.role === 'user')
      const prompt = typeof lastUser?.content === 'string' ? lastUser.content : ''
      if (prompt === '长过程折叠') {
        if (role === 'tool') {
          emit(response, { content: '长过程检查已完成。' })
          finish(response)
        } else {
          emit(response, { content: '我会核对这些测试文件，完成后汇总结果。' })
          for (let index = 0; index < 220; index++)
            emit(response, {
              tool_calls: [
                {
                  index,
                  id: `call-long-${index}`,
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: fixturePath }) },
                },
              ],
            })
          finish(response, 'tool_calls')
        }
        return
      }
      if (prompt === '操作分组') {
        const afterUser = messages.findLastIndex((message) => message.role === 'user') + 1
        const completed = messages
          .slice(afterUser)
          .filter((message) => message.role === 'tool').length
        if (completed >= 7) {
          emit(response, { content: '操作分组检查已完成。' })
          finish(response)
          return
        }
        emit(response, {
          content:
            completed === 0
              ? '我会先核对目录和文件，再检查命令输出。'
              : '第一组检查已完成，接下来验证后续文件。',
        })
        const continueProcess = (): void => {
          processContinuations.delete(continueProcess)
          const calls =
            completed === 0
              ? [
                  { name: 'list_directory', arguments: { path: dirname(fixturePath) } },
                  { name: 'read_file', arguments: { path: fixturePath } },
                  {
                    name: 'search_text',
                    arguments: { path: dirname(fixturePath), query: 'controlled-file', limit: 10 },
                  },
                  {
                    name: 'run_command',
                    arguments: {
                      command: [
                        process.execPath,
                        '-e',
                        "process.stdout.write('controlled-group-output'); // " +
                          'long-command-'.repeat(40) +
                          'long-command-tail',
                      ],
                      cwd: dirname(fixturePath),
                    },
                  },
                  {
                    name: 'run_command',
                    arguments: {
                      command: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'],
                      cwd: dirname(fixturePath),
                    },
                  },
                ]
              : [
                  {
                    name: 'read_file',
                    arguments: { path: join(dirname(fixturePath), 'missing-group-file.txt') },
                  },
                  {
                    name: 'run_command',
                    arguments: {
                      command: [
                        process.execPath,
                        '-e',
                        "process.stdout.write('controlled-group-approval')",
                      ],
                      cwd: dirname(fixturePath),
                      sandbox_permissions: 'require_escalated',
                      justification: '验证操作分组的审批状态',
                    },
                  },
                ]
          emit(response, {
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call-group-${completed}-${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          })
          finish(response, 'tool_calls')
        }
        processContinuations.add(continueProcess)
        response.once('close', () => processContinuations.delete(continueProcess))
        return
      }
      if (prompt.startsWith('分阶段过程')) {
        emit(response, { reasoning_content: '核对调用结果，' })
        emit(response, { reasoning_content: '再决定下一步。' })
        const afterUser = messages.findLastIndex((message) => message.role === 'user') + 1
        const completed = messages
          .slice(afterUser)
          .filter((message) => message.role === 'tool').length
        if (completed >= 2) {
          emit(response, { content: '已完成项目检查，文件内容已核实。' })
          finish(response)
          return
        }
        emit(response, {
          content: prompt.includes('命令')
            ? completed === 0
              ? '我会先运行检查命令，拿到结果后再核对文件。'
              : '命令检查已完成，接下来读取文件核实具体内容。'
            : completed === 0
              ? '我会先查看项目目录，确认结构后再读取相关文件。'
              : '目录结构已确认，接下来读取文件核实具体内容。',
        })
        const continueProcess = (): void => {
          processContinuations.delete(continueProcess)
          emit(response, {
            tool_calls: [
              {
                index: 0,
                id: `call-process-${completed}`,
                type: 'function',
                function: {
                  name:
                    completed === 0 && prompt.includes('命令')
                      ? 'run_command'
                      : completed === 0
                        ? 'list_directory'
                        : 'read_file',
                  arguments: JSON.stringify(
                    completed === 0 && prompt.includes('命令')
                      ? {
                          command: [
                            process.execPath,
                            '-e',
                            "process.stdout.write('controlled-fold-output')",
                          ],
                          cwd: dirname(fixturePath),
                        }
                      : { path: completed === 0 ? dirname(fixturePath) : fixturePath },
                  ),
                },
              },
            ],
          })
          finish(response, 'tool_calls')
        }
        processContinuations.add(continueProcess)
        response.once('close', () => processContinuations.delete(continueProcess))
        return
      }
      if (role === 'tool') {
        if (text.includes('"question"')) {
          const answer = record(JSON.parse(text) as unknown)
          emit(response, {
            content:
              answer.skipped === true
                ? '用户已跳过问题。'
                : `已收到你的回复：${String(answer.selected_option || answer.text)}`,
          })
          finish(response)
          return
        }
        let content = '已读取测试文件。'
        if (prompt.startsWith('只读')) content = '已完成只读检查。'
        else if (prompt.startsWith('AI 审批')) content = '已查看当前目录。'
        else if (prompt.includes('目录') && prompt.includes('审批')) content = '已修改测试文件。'
        else if (prompt.startsWith('命令')) content = '已完成命令检查。'
        if (text.includes('permission_denied')) content = '操作已拒绝。'
        emit(response, { content })
        finish(response)
        return
      }
      if (text.startsWith('Markdown 流式')) {
        emit(response, { content: MARKDOWN_START })
        const continueResponse = (): void => {
          emit(response, { content: MARKDOWN_END })
          finish(response)
          markdownContinuations.delete(continueResponse)
        }
        markdownContinuations.add(continueResponse)
        response.once('close', () => markdownContinuations.delete(continueResponse))
        return
      }
      if (text === 'Markdown 安全') {
        emit(response, { content: MARKDOWN_UNSAFE })
        finish(response)
        return
      }
      if (text === 'Markdown 长内容') {
        emit(response, { content: '完整长内容-' + 'x'.repeat(256 * 1024) })
        finish(response)
        return
      }
      if (text.startsWith('只读')) {
        const name = text.includes('目录')
          ? 'list_directory'
          : text.includes('搜索')
            ? 'search_text'
            : 'read_file'
        const args =
          name === 'read_file'
            ? { path: fixturePath }
            : name === 'list_directory'
              ? { path: dirname(fixturePath) }
              : { path: dirname(fixturePath), query: 'controlled-file' }
        emit(response, {
          tool_calls: [
            {
              index: 0,
              id: 'call-readonly',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        })
        finish(response, 'tool_calls')
        return
      }
      if (text.includes('目录') && text.includes('审批')) {
        emit(response, { content: '准备修改文件。' })
        const path = join(
          dirname(fixturePath),
          'directory-writes',
          String(++writeSequence) + '.txt',
        )
        emit(response, {
          tool_calls: [
            {
              index: 0,
              id: 'call-write',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({
                  patch: `*** Begin Patch\n*** Add File: ${path}\n+controlled directory write\n*** End Patch`,
                  base_versions: [],
                }),
              },
            },
          ],
        })
        finish(response, 'tool_calls')
        return
      }
      if (text.startsWith('沙箱')) {
        const path =
          text.includes('项目外') || text.includes('提权')
            ? join(dirname(fixturePath), '..', 'outside.txt')
            : join(dirname(fixturePath), 'sandbox-write.txt')
        const command =
          text.includes('写入') || text.includes('提权')
            ? [
                process.execPath,
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(path)},'controlled')`,
              ]
            : [process.execPath, '-e', 'process.stdout.write(process.cwd())']
        emit(response, {
          tool_calls: [
            {
              index: 0,
              id: 'call-sandbox',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  command,
                  cwd: dirname(fixturePath),
                  ...(text.includes('提权')
                    ? {
                        sandbox_permissions: 'require_escalated',
                        justification: '验证本次受控沙箱外写入审批',
                      }
                    : text.includes('申请项目写入')
                      ? {
                          sandbox_permissions: 'workspace_write',
                          justification: '验证本次沙箱内项目写入审批',
                        }
                      : {}),
                }),
              },
            },
          ],
        })
        finish(response, 'tool_calls')
        return
      }
      if (text.startsWith('命令') && text.endsWith('步骤')) {
        emit(response, { content: '准备运行命令并检查结果。' })
        const script = text.includes('取消')
          ? "process.stdout.write('command-started\\n'); setInterval(() => {}, 1000)"
          : `process.stdout.write('command-out\\n'); process.stderr.write('command-err\\n'); process.exit(${text.includes('非零') ? 3 : 0})`
        emit(response, {
          tool_calls: [
            {
              index: 0,
              id: 'call-command',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  command: [process.execPath, '-e', script],
                  cwd: dirname(fixturePath),
                  sandbox_permissions: 'require_escalated',
                  justification: '在受控临时目录验证命令审批、输出和取消',
                }),
              },
            },
          ],
        })
        finish(response, 'tool_calls')
        return
      }
      if (text.includes('审批')) {
        emit(response, { content: '准备检查文件。' })
        const requestApproval = (): void => {
          const toolCalls = [
            {
              index: 0,
              id: 'call-read',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: fixturePath }) },
            },
          ]
          if (text.includes('分页审批')) {
            toolCalls.splice(
              0,
              toolCalls.length,
              ...Array.from({ length: 51 }, (_, index) => ({
                index,
                id: `call-page-${index}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: fixturePath }) },
              })),
            )
          }
          if (text.includes('连续审批'))
            toolCalls.push({
              index: 1,
              id: 'call-read-second',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: fixturePath + '.second' }),
              },
            })
          emit(response, { tool_calls: toolCalls })
          finish(response, 'tool_calls')
          approvalContinuations.delete(requestApproval)
        }
        if (text.includes('延迟审批')) {
          approvalContinuations.add(requestApproval)
          response.once('close', () => approvalContinuations.delete(requestApproval))
        } else requestApproval()
        return
      }
      if (text.startsWith('提问')) {
        emit(response, {
          tool_calls: [
            {
              index: 0,
              id: 'call-question',
              type: 'function',
              function: {
                name: 'request_user_input',
                arguments: JSON.stringify({
                  question: '另一个任务是否已经结束？这会影响接下来的验证。',
                  options: ['已结束，可以复验', '仍在进行'],
                }),
              },
            },
          ],
        })
        finish(response, 'tool_calls')
        return
      }
      if (text.includes('等待')) {
        emit(response, { content: `仅属于${text}的内容` })
        response.once('close', () => {
          cancelled++
        })
        return
      }
      if (text.startsWith('分页-')) {
        emit(response, { content: '分页回答。' })
        finish(response)
        return
      }
      emit(response, { content: '你好，' })
      const timer = setTimeout(() => {
        if (text.includes('中断')) response.destroy()
        else {
          emit(response, { content: '这是受控回答。' })
          finish(response)
        }
      }, 150)
      response.once('close', () => clearTimeout(timer))
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试端口不可用')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    pauseCompaction() {
      pauseCompaction = true
      pauseCompactionAnswer = true
    },
    finishCompaction(success = true) {
      for (const continuation of [...compactionContinuations]) continuation(success)
    },
    finishCompactionTask() {
      for (const continuation of [...compactionAnswerContinuations]) continuation()
    },
    get pendingCompaction() {
      return compactionContinuations.size
    },
    get pendingCompactionAnswer() {
      return compactionAnswerContinuations.size
    },
    appendStream(text: string) {
      for (const response of streamingResponses) emit(response, { content: text })
    },
    appendReasoning(text: string) {
      for (const response of streamingResponses) emit(response, { reasoning_content: text })
    },
    finishStream() {
      for (const response of streamingResponses) finish(response)
      streamingResponses.clear()
    },
    finishMarkdown() {
      for (const continuation of [...markdownContinuations]) continuation()
    },
    requestApproval() {
      for (const continuation of [...approvalContinuations]) continuation()
    },
    continueProcess() {
      for (const continuation of [...processContinuations]) continuation()
    },
    get pendingProcess() {
      return processContinuations.size
    },
    get cancelled() {
      return cancelled
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
function emit(response: ServerResponse, delta: unknown): void {
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  )
}
function finish(response: ServerResponse, reason = 'stop'): void {
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: {"choices":[],"usage":{"total_tokens":7,"fixture":true}}\n\ndata: [DONE]\n\n`,
  )
}
