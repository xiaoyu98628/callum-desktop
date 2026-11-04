import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { array, id, isActiveRun, PAGE_SIZE, record, string } from '../../shared/chat.ts'
import type {
  ChatChange,
  ChatEvent,
  ChatMessage,
  ChatOverview,
  ChatRun,
  ConversationDetail,
  SendMessageInput,
  SendMessageResult,
} from '../../shared/chat.ts'
import {
  appendDelta,
  approvalFromRpc,
  conversationFromRpc,
  messageFromRpc,
  runFromRpc,
} from './protocol-mapper.ts'
import { RpcClient, RpcError } from './rpc-client.ts'
import { ModelCatalog } from './model-catalog.ts'

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
}

/** 应用持有服务；RPC 细节、增量装配、快照一致性均止于此处。 */
export class ChatService {
  readonly catalog = new ModelCatalog((method, params) => this.request(method, params))
  private client: RpcClient | null = null
  private readonly ready: Promise<void>
  private error: string | null = null
  private revision = 0
  private readonly listeners = new Set<(event: ChatEvent) => void>()
  private readonly messages = new Map<string, ChatMessage>()
  private readonly runs = new Map<string, ChatRun>()
  private readonly dirty = new Map<string, ChatMessage>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly history: { event: ChatEvent; bytes: number }[] = []
  private historyBytes = 0
  private droppedRevision = 0
  private readonly persistenceFailures = new Set<string>()
  private closing = false
  private closeTask: Promise<void> | null = null

  constructor(dataDirectory: string, resourceRoot: string) {
    this.ready = this.initialize(dataDirectory, resourceRoot)
    void this.ready.catch(() => undefined)
  }
  private async initialize(dataDirectory: string, resourceRoot: string): Promise<void> {
    try {
      if (!isAbsolute(dataDirectory)) throw new Error('服务数据目录必须是绝对路径')
      const executable = resolveBackendExecutable(resourceRoot)
      await access(executable, constants.X_OK)
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
      if (this.closing) return
      this.client = new RpcClient(
        executable,
        ['--data-dir', dataDirectory],
        (method, params) => this.receive(method, params),
        () => {
          this.error =
            '对话服务连接已中断，未完成请求的结果可能未知。请重新打开应用核对历史，避免重复发送。'
          this.flush()
          this.publish({ kind: 'service', error: this.error })
        },
      )
      await this.client.ready
    } catch {
      this.error ??= '无法启动对话服务，请检查客户端是否包含适用于本机的服务程序。'
      if (this.client) await this.client.close()
      throw new Error(this.error)
    }
  }
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ready
    if (this.error) throw new Error(this.error)
    if (this.closing || !this.client) throw new Error('对话服务正在关闭。')
    return this.client.request(method, params)
  }
  async overview(offset: number): Promise<ChatOverview> {
    const start = this.revision
    const [models, rows] = await Promise.all([
      this.request('model.list', { selectable_only: true }),
      this.request('conversation.list', { unbound: true, limit: PAGE_SIZE, offset }),
    ])
    let conversations = array(rows ?? [], conversationFromRpc)
    const hasMore = conversations.length === PAGE_SIZE
    for (const event of this.since(start)) {
      if (event.change.kind === 'service') throw new Error(event.change.error)
      if (
        event.change.kind === 'conversation' &&
        (offset === 0 ||
          conversations.some(
            (item) => event.change.kind === 'conversation' && item.id === event.change.value.id,
          ))
      )
        conversations = upsert(conversations, event.change.value)
    }
    return {
      models: array(models ?? [], (item) => {
        const v = record(item)
        return { id: id(v.id), name: string(v.display_name) }
      }),
      conversations: conversations.sort((a, b) => b.updatedAt - a.updatedAt),
      hasMore,
      revision: this.revision,
    }
  }
  async detail(conversationId: string): Promise<ConversationDetail> {
    const start = this.revision
    const [conversation, messages, runs] = await Promise.all([
      this.request('conversation.get', { id: conversationId }),
      this.request('conversation.messages', { conversation_id: conversationId, limit: PAGE_SIZE }),
      this.request('run.list', { conversation_id: conversationId, limit: 200 }),
    ])
    const parsedRuns = array(runs ?? [], runFromRpc)
    const pending = await Promise.all(
      parsedRuns
        .filter(isActiveRun)
        .map((run) =>
          this.request('approval.list', { run_id: run.id, status: 'pending', limit: 200 }),
        ),
    )
    const result: ConversationDetail = {
      conversation: conversationFromRpc(conversation),
      messages: array(messages ?? [], messageFromRpc),
      runs: parsedRuns,
      approvals: pending.flatMap((rows) =>
        array(rows ?? [], (row) => approvalFromRpc(row, conversationId)),
      ),
      revision: 0,
      warning: this.persistenceFailures.has(conversationId)
        ? '本次执行状态未能完整保存，请重新打开应用后核对历史。'
        : null,
    }
    for (const event of this.since(start)) this.mergeDetail(result, event.change)
    // 活动回答可能尚未落库；完整的内存消息优先于数据库及事件中的中间快照。
    for (const message of this.messages.values())
      if (message.conversationId === conversationId)
        result.messages = upsert(result.messages, message)
    result.messages.sort((a, b) => a.sequence - b.sequence)
    result.runs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    result.revision = this.revision
    return result
  }
  async earlier(conversationId: string, beforeSequence: number): Promise<ChatMessage[]> {
    return array(
      (await this.request('conversation.messages', {
        conversation_id: conversationId,
        before_sequence: beforeSequence,
        limit: PAGE_SIZE,
      })) ?? [],
      messageFromRpc,
    )
  }
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const value = record(
      await this.request('conversation.send', {
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
        model_id: input.modelId,
        stream: true,
        content: [{ type: 'text', text: input.text }],
      }),
    )
    return { conversationId: id(value.conversation_id), runId: id(value.run_id) }
  }
  async cancel(runId: string): Promise<boolean> {
    const value = record(await this.request('run.cancel', { run_id: runId }))
    if (typeof value.cancel_requested !== 'boolean') throw new Error('取消响应无效')
    return value.cancel_requested
  }
  async decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<boolean> {
    await this.request('approval.decide', { approval_id: approvalId, decision })
    return true
  }
  private receive(method: string, value: unknown): void {
    const p = record(value)
    if (method === 'conversation.created' || method === 'conversation.updated') {
      if (record(p.conversation).workspace_id === null)
        this.publish({ kind: 'conversation', value: conversationFromRpc(p.conversation) })
    } else if (method === 'message.created' || method === 'message.updated') {
      const message = messageFromRpc(p.message)
      this.checkOwner(p, message)
      this.messages.set(message.id, message)
      this.dirty.delete(message.id)
      this.publish({ kind: 'message', value: message })
    } else if (method === 'message.delta') {
      const messageId = id(p.message_id),
        previous = this.messages.get(messageId)
      if (!previous) throw new Error('消息增量缺少初始消息')
      const message = appendDelta(previous, p)
      this.messages.set(message.id, message)
      this.dirty.set(message.id, message)
      this.flushTimer ??= setTimeout(() => this.flush(), 40)
    } else if (method.startsWith('run.') && p.run !== undefined) {
      const run = runFromRpc(p.run)
      if (id(p.conversation_id) !== run.conversationId || id(p.run_id) !== run.id)
        throw new Error('执行归属不匹配')
      this.runs.set(run.id, run)
      if (p.persisted === false) {
        this.persistenceFailures.add(run.conversationId)
        if (this.persistenceFailures.size > 128) throw new Error('执行状态持续保存失败')
      }
      this.flush()
      this.publish({ kind: 'run', value: run, persisted: p.persisted !== false })
      if (!isActiveRun(run)) {
        for (const [key, message] of this.messages)
          if (message.runId === run.id) this.messages.delete(key)
        this.runs.delete(run.id)
      }
    } else if (method === 'approval.requested' || method === 'approval.updated') {
      const approval = approvalFromRpc(p.approval, id(p.conversation_id))
      if (approval.runId !== id(p.run_id) || approval.id !== id(p.approval_id))
        throw new Error('审批归属不匹配')
      this.publish({ kind: 'approval', value: approval })
    }
    if (this.messages.size > 32 || this.runs.size > 64) throw new Error('活动消息超出限制')
  }
  private checkOwner(params: Record<string, unknown>, message: ChatMessage): void {
    if (
      id(params.conversation_id) !== message.conversationId ||
      id(params.run_id) !== message.runId ||
      id(params.message_id) !== message.id
    )
      throw new Error('消息归属不匹配')
  }
  private flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const message of this.dirty.values()) this.publish({ kind: 'message', value: message })
    this.dirty.clear()
  }
  private publish(change: ChatChange): void {
    const event = { revision: ++this.revision, change }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.history.push({ event, bytes })
    this.historyBytes += bytes
    while (this.history.length > 512 || this.historyBytes > 16 * 1024 * 1024) {
      const oldest = this.history.shift()
      if (!oldest) break
      this.historyBytes -= oldest.bytes
      this.droppedRevision = oldest.event.revision
    }
    for (const listener of this.listeners) listener(event)
  }
  private since(revision: number): ChatEvent[] {
    if (revision < this.droppedRevision) throw new Error('对话内容变化较快，请重新加载。')
    return this.history
      .filter((entry) => entry.event.revision > revision)
      .map((entry) => entry.event)
  }
  private mergeDetail(detail: ConversationDetail, change: ChatChange): void {
    if (change.kind === 'service') throw new Error(change.error)
    if (change.kind === 'conversation') {
      if (change.value.id === detail.conversation.id) detail.conversation = change.value
      return
    }
    if (change.value.conversationId !== detail.conversation.id) return
    if (change.kind === 'message') detail.messages = upsert(detail.messages, change.value)
    if (change.kind === 'run') {
      detail.runs = upsert(detail.runs, change.value)
      if (!change.persisted) detail.warning = '本次执行状态未能完整保存，请重新打开应用后核对历史。'
    }
    if (change.kind === 'approval') detail.approvals = upsert(detail.approvals, change.value)
  }
  close(): Promise<void> {
    this.closeTask ??= this.shutdown()
    return this.closeTask
  }
  private async shutdown(): Promise<void> {
    this.closing = true
    // 退出可能发生在握手期间，先关闭已创建的进程，不能等待就绪超时后才取消启动。
    const closeClient = this.client?.close() ?? Promise.resolve()
    void closeClient.catch(() => undefined)
    try {
      await this.ready
    } catch {
      /* 初始化错误已记录，仍需清理已创建的子进程。 */
    }
    try {
      await closeClient
    } finally {
      clearTimeout(this.flushTimer)
      this.dirty.clear()
      this.messages.clear()
      this.runs.clear()
      this.persistenceFailures.clear()
      this.history.length = 0
      this.listeners.clear()
    }
  }
}

export function resolveBackendExecutable(resourceRoot: string): string {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('当前仅提供 macOS Apple Silicon 服务程序。')
  return join(resourceRoot, 'backend', `${process.platform}-${process.arch}`, 'callum')
}
export function publicChatError(error: unknown): string {
  if (error instanceof RpcError) return error.message
  if (error instanceof Error && !/ENOENT|EACCES|JSON|格式|无效|不匹配/.test(error.message))
    return error.message
  return '无法完成对话操作，请重试。'
}
