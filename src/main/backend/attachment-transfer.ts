import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AttachmentInput,
  AttachmentPreview,
  AttachmentPreviewInput,
  AttachmentSaveInput,
} from '../../shared/attachments.ts'
import {
  MAX_ATTACHMENT_BYTES,
  parseAttachmentPreview,
  parseAttachments,
} from '../../shared/attachments.ts'
import type { ResendMessageInput, SendMessageInput } from '../../shared/chat.ts'
import { record, string } from '../../shared/chat.ts'

/** 持有附件暂存和在途传输；依赖的后端连接由生命周期组件持有。 */
export class AttachmentTransfer {
  private stagingDirectory = ''
  private readonly transfers = new Set<Promise<unknown>>()
  private closing = false
  private readonly request: (method: string, params: unknown) => Promise<unknown>
  private readonly ensureReady: () => Promise<void>
  constructor(
    request: (method: string, params: unknown) => Promise<unknown>,
    ensureReady: () => Promise<void>,
  ) {
    this.request = request
    this.ensureReady = ensureReady
  }
  async reset(directory: string): Promise<void> {
    this.stagingDirectory = join(directory, '.attachment-staging')
    try {
      const info = await lstat(this.stagingDirectory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('附件暂存目录无效')
      await rm(this.stagingDirectory, { recursive: true })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await mkdir(this.stagingDirectory, { mode: 0o700 })
  }
  private async withStagedAttachments<T>(
    input: AttachmentInput[] | undefined,
    action: (paths: string[]) => Promise<T>,
  ): Promise<T> {
    if (!input?.length) return action([])
    const attachments = parseAttachments(input)
    await this.ensureReady()
    if (this.closing) throw new Error('应用正在退出。')
    if (this.transfers.size >= 2) throw new Error('正在处理其他附件，请稍后重试。')
    const task = (async () => {
      const dir = await mkdtemp(join(this.stagingDirectory, 'upload-'))
      try {
        const paths: string[] = []
        for (const { bytes } of attachments) {
          const path = join(dir, String(paths.length))
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
          paths.push(path)
        }
        return await action(paths)
      } finally {
        // 受理后的临时文件清理失败不能让客户端重发。下次启动在实例锁内回收。
        await rm(dir, { recursive: true, force: true }).catch(() => {
          console.error(
            JSON.stringify({ level: 'warn', module: 'attachments', message: '附件暂存文件待清理' }),
          )
        })
      }
    })()
    this.transfers.add(task)
    try {
      return await task
    } finally {
      this.transfers.delete(task)
    }
  }
  async previewAttachment(input: AttachmentPreviewInput): Promise<AttachmentPreview> {
    return parseAttachmentPreview(
      await this.request('conversation.attachment_preview', {
        conversation_id: input.conversationId,
        message_id: input.messageId,
        index: input.index,
      }),
    )
  }
  /** 分片绑定用户所选消息版本，完整性确认后才交给另存流程。 */
  async readAttachmentFile(input: AttachmentSaveInput): Promise<{ name: string; bytes: Buffer }> {
    await this.ensureReady()
    if (this.closing) throw new Error('应用正在退出。')
    if (this.transfers.size >= 2) throw new Error('正在处理其他附件，请稍后重试。')
    const task = this.readFile(input)
    this.transfers.add(task)
    try {
      return await task
    } finally {
      this.transfers.delete(task)
    }
  }
  private async readFile(input: AttachmentSaveInput): Promise<{ name: string; bytes: Buffer }> {
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    const chunkSize = 1024 * 1024
    let offset = 0
    let name = ''
    let size = -1
    let digest = ''
    for (;;) {
      const value = record(
        await this.request('conversation.attachment_read', {
          conversation_id: input.conversationId,
          message_id: input.messageId,
          expected_run_id: input.runId,
          index: input.index,
          offset,
        }),
      )
      const nextName = string(value.name)
      const nextSize = value.size
      const nextDigest = string(value.sha256)
      const encoded = string(value.data)
      if (
        typeof nextSize !== 'number' ||
        !Number.isSafeInteger(nextSize) ||
        nextSize < 0 ||
        nextSize > MAX_ATTACHMENT_BYTES ||
        !nextName ||
        nextName.length > 1024 ||
        /[\p{Cc}/\\]/u.test(nextName) ||
        value.offset !== offset ||
        !/^[a-f0-9]{64}$/.test(nextDigest) ||
        encoded.length > Math.ceil(chunkSize / 3) * 4 ||
        /[^A-Za-z0-9+/=]/.test(encoded)
      )
        throw new Error('附件读取结果无效')
      if (size < 0) {
        name = nextName
        size = nextSize
        digest = nextDigest
      }
      if (
        value.run_id !== input.runId ||
        name !== nextName ||
        size !== nextSize ||
        digest !== nextDigest
      )
        throw new Error('附件在读取期间发生变化，请从当前消息重新另存')
      const bytes = Buffer.from(encoded, 'base64')
      if (
        bytes.toString('base64') !== encoded ||
        bytes.length !== Math.min(chunkSize, size - offset)
      )
        throw new Error('附件片段无效')
      chunks.push(bytes)
      hash.update(bytes)
      offset += bytes.length
      if (value.next_offset === null) {
        if (offset !== size) throw new Error('附件读取不完整')
        if (hash.digest('hex') !== digest) throw new Error('附件完整性校验失败')
        return { name, bytes: Buffer.concat(chunks, size) }
      }
      if (value.next_offset !== offset || bytes.length === 0 || offset >= size)
        throw new Error('附件读取没有推进')
    }
  }
  async previewDraftAttachment(input: AttachmentInput): Promise<AttachmentPreview> {
    return this.withStagedAttachments([input], async ([path]) =>
      parseAttachmentPreview(await this.request('conversation.attachment_preview', { path })),
    )
  }
  withMessageContent<T>(
    input: SendMessageInput | ResendMessageInput,
    action: (
      content: { type: string; text?: string; path?: string; name?: string }[],
    ) => Promise<T>,
  ): Promise<T> {
    return this.withStagedAttachments(input.attachments, (paths) =>
      action([
        ...(input.skill ? [{ type: 'skill', name: input.skill.name, path: input.skill.path }] : []),
        ...(input.text.trim() ? [{ type: 'text', text: input.text }] : []),
        ...paths.map((path, index) => ({
          type: input.attachments?.[index]?.kind ?? 'image',
          path,
          ...(input.attachments?.[index]?.name ? { name: input.attachments[index]!.name } : {}),
        })),
      ]),
    )
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.transfers])
  }
}
