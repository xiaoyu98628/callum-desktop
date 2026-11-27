import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { record } from '../../shared/chat.ts'
import type { ServiceState } from '../../shared/desktop-api.ts'
import { RpcClient, RpcConnectionError } from './rpc-client.ts'
import { resolveResourceTarget, resolveRuntimeDirectory } from './runtime-assets.ts'
import { installRuntimeAssets } from './runtime-installation.ts'
import { installSkillAssets } from './skill-assets.ts'

import { Subscriptions } from './subscriptions.ts'
function startupError(error: unknown, phase: string): string {
  if (error instanceof RpcConnectionError) return error.message
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (phase === 'path') return '服务数据目录必须是绝对路径。'
  if (phase === 'platform') return '当前平台没有配套的对话服务程序。'
  if (phase === 'executable') {
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return '未找到对话服务程序，请检查客户端服务资源是否完整。'
    if (code === 'EACCES' || code === 'EPERM') return '没有执行对话服务程序的权限，请检查文件权限。'
    return '无法访问对话服务程序，请检查客户端服务资源。'
  }
  if (phase === 'runtime')
    return '未找到完整的内置 Python/Node/Git 资源，请重新准备客户端运行时资源。'
  if (phase === 'runtime-install')
    return '无法安装内置运行时，请检查资源完整性、数据目录权限及磁盘空间；原有目录按安装恢复记录保留。'
  if (phase === 'skills')
    return '无法安装随附技能，请检查客户端技能资源、数据目录权限及磁盘空间；用户技能保留，自带技能旧副本已备份。'
  if (phase === 'directory') {
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
      return '服务数据目录不可写，请检查目录权限。'
    if (code === 'ENOSPC' || code === 'EDQUOT') return '磁盘空间或配额不足，无法创建服务数据目录。'
    if (code === 'ENOTDIR' || code === 'EEXIST') return '服务数据目录路径被文件占用，无法创建目录。'
    return '无法创建服务数据目录，请检查路径及磁盘状态。'
  }
  return '无法完成对话服务启动，请重试启动。'
}

/** 只持有后端安装、连接、启动重试和关闭；业务及附件状态由借用的回调持有。 */
export class BackendLifecycle {
  private generationCounter = 0
  get generation(): number {
    return this.generationCounter
  }
  private client: RpcClient | null = null
  private ready: Promise<void>
  private readonly developmentExecutable: string | undefined
  private readonly dataDirectory: string
  private readonly resourceRoot: string
  private retryTask: Promise<ServiceState> | null = null
  private state: ServiceState = { status: 'starting' }
  private readonly stateListeners = new Subscriptions<ServiceState>()
  private error: string | null = null
  closing = false
  private startupAbort = new AbortController()
  private installing = false
  private closeTask: Promise<void> | null = null
  private readonly notify: (method: string, params: unknown) => void
  private readonly disconnected: (error: string) => void
  private readonly resetAttachments: (directory: string) => Promise<void>
  private readonly waitTransfers: () => Promise<void>
  private readonly releaseState: () => void
  constructor(
    dataDirectory: string,
    resourceRoot: string,
    developmentExecutable: string | undefined,
    hooks: {
      notify: (method: string, params: unknown) => void
      disconnected: (error: string) => void
      resetAttachments: (directory: string) => Promise<void>
      waitTransfers: () => Promise<void>
      releaseState: () => void
    },
  ) {
    this.dataDirectory = dataDirectory
    this.resourceRoot = resourceRoot
    this.developmentExecutable = developmentExecutable
    this.notify = hooks.notify
    this.disconnected = hooks.disconnected
    this.resetAttachments = hooks.resetAttachments
    this.waitTransfers = hooks.waitTransfers
    this.releaseState = hooks.releaseState
    this.ready = this.initialize(dataDirectory, resourceRoot)
    void this.ready.catch(() => undefined)
  }
  async ensureReady(): Promise<void> {
    await this.ready
    if (this.closing || this.state.status !== 'ready') throw new Error('对话服务尚未就绪。')
  }
  private async initialize(dataDirectory: string, resourceRoot: string): Promise<void> {
    this.generationCounter++
    this.startupAbort = new AbortController()
    let phase = 'path'
    try {
      if (!isAbsolute(dataDirectory)) throw new Error('服务数据目录必须是绝对路径')
      phase = 'platform'
      const executable = this.developmentExecutable ?? resolveBackendExecutable(resourceRoot)
      if (!isAbsolute(executable)) throw new Error('开发服务程序路径必须是绝对路径')
      phase = 'executable'
      await access(executable, constants.X_OK)
      phase = 'runtime'
      const sourceRuntime = resolveRuntimeDirectory(resourceRoot)
      const manifest = await lstat(join(sourceRuntime, 'manifest.json'))
      if (!manifest.isFile() || manifest.isSymbolicLink())
        throw new Error('内置运行时清单必须是普通文件')
      phase = 'directory'
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
      if (this.closing) return
      phase = 'handshake'
      const guard = new RpcClient(
        executable,
        ['resource-lock', '--data-dir', dataDirectory],
        () => undefined,
        (error) => {
          if (this.closing || this.client !== guard) return
          this.error = error.message
          this.startupAbort.abort(error)
        },
      )
      this.client = guard
      await guard.ready
      if (this.closing) return
      const canonicalData = await realpath(dataDirectory)
      phase = 'runtime-install'
      let runtimeDirectory: string
      this.installing = true
      try {
        const verifyCopies = this.developmentExecutable !== undefined
        runtimeDirectory = await installRuntimeAssets(
          sourceRuntime,
          canonicalData,
          this.startupAbort.signal,
          async (directory, manifestSHA256) => {
            const name = basename(directory)
            const params = verifyCopies ? { name } : { name, manifest_sha256: manifestSHA256 }
            const result = record(await guard.request('runtime.validate', params, 35_000))
            if (typeof result.valid !== 'boolean') throw new Error('运行时校验响应无效')
            return result.valid
          },
          { verifyCopies },
        )
        phase = 'skills'
        await installSkillAssets(resourceRoot, canonicalData, this.startupAbort.signal)
      } finally {
        this.installing = false
      }
      await guard.close()
      if (this.closing) return
      phase = 'handshake'
      const client = new RpcClient(
        executable,
        ['--data-dir', dataDirectory, '--runtime-dir', runtimeDirectory],
        (method, params) => this.notify(method, params),
        (error) => {
          if (this.closing || this.client !== client) return
          if (this.state.status === 'starting') {
            this.error = error.message
            return
          }
          this.error =
            '对话服务连接已中断，未完成请求的结果可能未知。请重新打开应用核对历史，避免重复发送。'
          this.setState({ status: 'failed', error: this.error })
          this.disconnected(this.error)
        },
        // 完整资源校验最多 30 秒，后续初始化仍有独立的 10 秒预算。
        45_000,
      )
      this.client = client
      await client.ready
      if (this.error) throw new RpcConnectionError(this.error)
      if (!this.closing) {
        // 后端持有实例锁后，附件组件才回收上次异常退出的暂存资源。
        await this.resetAttachments(await realpath(dataDirectory))
        if (!this.closing) this.setState({ status: 'ready' })
      }
    } catch (error) {
      this.error ??= startupError(error, phase)
      if (!this.closing) this.setState({ status: 'startup-failed', error: this.error })
      try {
        if (this.client) await this.client.close()
      } catch (cleanupError) {
        this.error += ' 上一次服务进程未能完全退出，暂时无法重新启动。'
        if (!this.closing) this.setState({ status: 'startup-failed', error: this.error })
        throw new AggregateError([error, cleanupError], this.error, { cause: cleanupError })
      }
      throw new Error(this.error, { cause: error })
    }
  }
  /** 仅允许重试未曾就绪的失败启动；共享一次在途重试，关闭后不再创建进程。 */
  retryStart(): Promise<ServiceState> {
    if (this.closing) return Promise.reject(new Error('应用正在退出，无法重新启动服务。'))
    if (this.retryTask) return this.retryTask
    if (this.state.status !== 'startup-failed')
      return Promise.reject(new Error('仅支持重试启动失败的服务。'))
    this.retryTask = this.restart().finally(() => {
      this.retryTask = null
    })
    return this.retryTask
  }
  private async restart(): Promise<ServiceState> {
    this.setState({ status: 'starting' })
    // 失败状态可以早于清理完成发布；必须等待旧初始化及连接结束，避免进程或实例锁重叠。
    try {
      await this.ready
    } catch {
      /* 原始启动失败已经保存，下面单独确认进程清理结果。 */
    }
    if (this.closing) return this.getState()
    try {
      await this.client?.close()
    } catch {
      this.setState({
        status: 'startup-failed',
        error: this.error ?? '上一次服务进程未能完全退出，无法重新启动。',
      })
      return this.getState()
    }
    if (this.closing) return this.getState()
    this.client = null
    this.error = null
    this.ready = this.initialize(this.dataDirectory, this.resourceRoot)
    try {
      await this.ready
    } catch {
      /* 初始化发布具体失败原因，重试结果以当前生命周期快照为准。 */
    }
    return this.getState()
  }
  getState(): ServiceState {
    return { ...this.state }
  }
  subscribeState(listener: (state: ServiceState) => void): () => void {
    return this.stateListeners.add(listener)
  }
  private setState(state: ServiceState): void {
    if (
      this.state.status === state.status &&
      (!('error' in state) || ('error' in this.state && this.state.error === state.error))
    )
      return
    this.state = state
    this.stateListeners.emit(Object.freeze(this.getState()))
  }
  async request(method: string, params: unknown): Promise<unknown> {
    const ready = this.ready
    await ready
    if (ready !== this.ready) throw new Error('服务状态已变化，请重新加载。')
    if (this.error) throw new Error(this.error)
    if (this.closing || !this.client) throw new Error('对话服务正在关闭。')
    return this.client.request(method, params)
  }
  close(): Promise<void> {
    this.closeTask ??= this.shutdown()
    return this.closeTask
  }
  private async shutdown(): Promise<void> {
    this.closing = true
    this.startupAbort.abort(new Error('应用正在退出。'))
    this.setState({ status: 'closing' })
    // 退出可能发生在握手期间，先关闭已创建的进程，不能等待就绪超时后才取消启动。
    // 安装期间先取消并等待文件清理，再由初始化释放实例锁。
    const closeClient = this.installing
      ? Promise.resolve()
      : (this.client?.close() ?? Promise.resolve())
    void closeClient.catch(() => undefined)
    try {
      await this.ready
    } catch {
      /* 初始化错误已记录，仍需清理已创建的子进程。 */
    }
    try {
      const results = await Promise.allSettled([closeClient, this.retryTask])
      await this.waitTransfers()
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length) throw new AggregateError(errors, '对话服务关闭失败。')
    } finally {
      this.releaseState()
      this.stateListeners.close()
    }
  }
}

/** 服务程序与客户端采用相同架构，资源路径不依赖当前工作目录。 */
export function resolveBackendExecutable(
  resourceRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (!isAbsolute(resourceRoot)) throw new Error('服务资源根目录必须是绝对路径')
  return join(
    resourceRoot,
    'backend',
    resolveResourceTarget(platform, architecture),
    platform === 'win32' ? 'callum.exe' : 'callum',
  )
}
