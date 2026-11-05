import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { array, record, string } from '../../src/shared/chat.ts'
import { MARKDOWN_START, MARKDOWN_END, MARKDOWN_UNSAFE } from './markdown-fixture.ts'

/** 响应形状取自 Go 仓库 internal/app/agent_test.go；只验证客户端对受控端点的行为。 */
export async function startModelServer(fixturePath: string, expectedApiKey?: string) {
  const requests: {
    stream: boolean
    lastRole: string
    text: string
    expectedAuthorization: boolean
  }[] = []
  let cancelled = 0
  const markdownContinuations = new Set<() => void>()
  const approvalContinuations = new Set<() => void>()
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
        text = typeof last.content === 'string' ? last.content : ''
      requests.push({
        stream: input.stream === true,
        lastRole: role,
        text,
        expectedAuthorization:
          expectedApiKey !== undefined &&
          request.headers.authorization === `Bearer ${expectedApiKey}`,
      })
      if (input.stream !== true) {
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
            ],
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
        emit(response, {
          content: text.includes('permission_denied') ? '操作已拒绝。' : '已读取测试文件。',
        })
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
    appendStream(text: string) {
      for (const response of streamingResponses) emit(response, { content: text })
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
