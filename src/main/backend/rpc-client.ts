import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { record, string } from '../../shared/chat.ts'

const MAX_FRAME = 8 * 1024 * 1024
const MAX_REQUEST = 1024 * 1024
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
/** 仅由传输实现构造安全提示，调用方可以展示 message，不转发原始诊断。 */
export class RpcConnectionError extends Error {}

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** 独占一个 stdio 连接；持续消费输出，窗口关闭不影响连接与执行。 */
export class RpcClient {
  readonly ready: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly closed: Promise<void>
  private readonly pending = new Map<string, Pending>()
  private readonly frame = Buffer.alloc(MAX_FRAME)
  private length = 0
  private serial = 0
  private usable = false
  private startupDiagnostic = Buffer.alloc(0)
  private failure: Error | null = null
  private closing = false
  private closeTask: Promise<void> | null = null
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly readyTimer: ReturnType<typeof setTimeout>
  private failureTimer: ReturnType<typeof setTimeout> | undefined
  private readonly notify: (method: string, params: unknown) => void
  private readonly disconnected: (error: RpcConnectionError) => void

  constructor(
    executable: string,
    args: string[],
    notify: (method: string, params: unknown) => void,
    disconnected: (error: RpcConnectionError) => void,
  ) {
    this.notify = notify
    this.disconnected = disconnected
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // 启动失败也可能早于调用方 await；保留原 Promise 的失败，同时避免未处理拒绝。
    void this.ready.catch(() => undefined)
    this.readyTimer = setTimeout(
      () => this.fail(new RpcConnectionError('对话服务启动超时，请重试启动。')),
      15_000,
    )
    this.child = spawn(executable, args, { stdio: 'pipe', windowsHide: true, shell: false })
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        if (!this.closing)
          this.fail(
            new RpcConnectionError(
              this.usable ? '对话服务已停止，请重新打开应用。' : this.startupFailure(),
            ),
          )
        this.rejectPending(new Error('对话服务已停止。'))
        clearTimeout(this.readyTimer)
        clearTimeout(this.failureTimer)
        resolve()
      }),
    )
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'EACCES' || error.code === 'EPERM'
          ? '没有执行对话服务程序的权限，请检查文件权限。'
          : '无法启动对话服务，请检查客户端服务程序是否完整。'
      this.fail(new RpcConnectionError(message, { cause: error }))
    })
    this.child.stdin.on('error', () => this.fail(new Error('对话服务连接已中断。')))
    this.child.stdout.on('error', () => this.fail(new Error('对话服务输出已中断。')))
    this.child.stderr.on('error', () => this.fail(new Error('对话服务诊断通道已中断。')))
    // 仅在握手前有界保留诊断以识别已知原因；不向界面或日志转发原文，运行后只消费。
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (!this.usable && !this.failure && this.startupDiagnostic.length < 16 * 1024)
        this.startupDiagnostic = Buffer.concat([
          this.startupDiagnostic,
          chunk.subarray(0, 16 * 1024 - this.startupDiagnostic.length),
        ])
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    this.child.stdout.on('end', () => {
      // 启动退出时等 close，确保 stderr 已排空；未退出的进程仍受就绪超时约束。
      if (!this.usable && !this.length) return
      if (!this.closing)
        this.fail(
          new RpcConnectionError(
            this.length
              ? '对话服务输出不完整。'
              : this.usable
                ? '对话服务连接已中断。'
                : '对话服务在就绪前退出，未完成启动握手。',
          ),
        )
    })
  }

  private startupFailure(): string {
    for (const line of this.startupDiagnostic.toString('utf8').split('\n')) {
      try {
        const value = record(JSON.parse(line) as unknown)
        if (value.level !== 'ERROR' || value.module !== 'main' || typeof value.error !== 'string')
          continue
        if (value.error.split(/\r?\n/).includes('该数据目录已有运行中的 Callum 服务'))
          return '该数据目录已有运行中的 Callum 服务，请关闭占用该目录的服务后重试。'
      } catch {
        /* 非结构化或超出边界的诊断不用于生成对外原因。 */
      }
    }
    return '对话服务在就绪前退出，未完成启动握手。'
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    await this.ready
    if (this.failure) throw this.failure
    if (this.closing && method !== 'system.shutdown') throw new Error('应用正在退出。')
    if (this.pending.size >= 64) throw new Error('请求过多，请稍后重试。')
    const id = `desktop-${++this.serial}`
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    if (bytes.length > MAX_REQUEST) throw new Error('请求内容过长，请缩短消息。')
    if (this.child.stdin.writableLength + bytes.length > 2 * MAX_REQUEST)
      throw new Error('对话服务繁忙，请稍后重试。')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 受理结果未知时禁止自动重试写操作，断开连接让服务取消所属执行并在重启后恢复持久化状态。
        const error = new Error('请求超时，受理结果未知。请重新打开应用核对历史，避免重复发送。')
        reject(error)
        this.fail(error)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(bytes, (error) => {
        if (error) this.fail(new Error('对话服务连接已中断。'))
      })
    })
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return
    try {
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline === -1 ? chunk.length : newline
        const size = end - offset
        if (this.length + size > MAX_FRAME) throw new Error('对话服务返回内容超出限制。')
        chunk.copy(this.frame, this.length, offset, end)
        this.length += size
        if (newline === -1) break
        const json = new TextDecoder('utf-8', { fatal: true }).decode(
          this.frame.subarray(0, this.length),
        )
        this.length = 0
        this.receive(JSON.parse(json) as unknown)
        offset = newline + 1
      }
    } catch {
      this.fail(
        new RpcConnectionError(
          this.usable
            ? '对话服务协议异常，连接已关闭。'
            : '对话服务启动握手失败，协议不兼容或响应无效。',
        ),
      )
    }
  }

  private receive(value: unknown): void {
    const message = record(value)
    if (message.jsonrpc !== '2.0') throw new Error('协议版本无效')
    if ('id' in message) {
      const pending = this.pending.get(string(message.id))
      if (!pending) return
      if ('error' in message) {
        const error = record(message.error)
        if (typeof error.code !== 'number') throw new Error('错误格式无效')
        pending.reject(new RpcError(error.code, string(error.message)))
      } else if ('result' in message) pending.resolve(message.result)
      else pending.reject(new Error('对话服务响应不完整。'))
      this.pending.delete(string(message.id))
      clearTimeout(pending.timer)
      return
    }
    const method = string(message.method)
    if (method === 'system.ready') {
      const info = record(message.params)
      if (
        this.usable ||
        info.service !== 'callum' ||
        info.protocol_version !== 1 ||
        info.max_request_bytes !== MAX_REQUEST ||
        info.max_response_bytes !== MAX_FRAME
      )
        throw new Error('不兼容的服务协议')
      this.usable = true
      this.startupDiagnostic = Buffer.alloc(0)
      clearTimeout(this.readyTimer)
      this.readyResolve()
    } else {
      if (!this.usable) throw new Error('服务尚未就绪')
      this.notify(method, message.params)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  private fail(error: RpcConnectionError): void {
    if (this.failure) return
    this.failure = error
    this.startupDiagnostic = Buffer.alloc(0)
    clearTimeout(this.readyTimer)
    this.readyReject(error)
    this.rejectPending(error)
    if (!this.closing) this.disconnected(error)
    this.failureTimer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    this.child.kill('SIGTERM')
  }
  close(): Promise<void> {
    this.closeTask ??= this.shutdown()
    return this.closeTask
  }
  private async shutdown(): Promise<void> {
    this.closing = true
    this.startupDiagnostic = Buffer.alloc(0)
    clearTimeout(this.readyTimer)
    if (this.usable && !this.failure) {
      try {
        await this.request('system.shutdown', {}, 3000)
      } catch {
        /* 下方仍会等待退出并执行有界终止。 */
      }
    } else this.readyReject(new Error('应用正在退出。'))
    this.child.stdin.end()
    if (await this.waitClosed(3000)) return
    this.child.kill('SIGTERM')
    if (await this.waitClosed(2000)) return
    this.child.kill('SIGKILL')
    if (!(await this.waitClosed(2000))) throw new Error('对话服务未能退出。')
  }
  private async waitClosed(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
