import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { realpath, mkdir, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveBackendExecutable } from '../../src/main/backend/chat-service.ts'
import { RpcClient } from '../../src/main/backend/rpc-client.ts'
import { array, id, record } from '../../src/shared/chat.ts'
import { resolveRuntimeDirectory } from '../../src/main/backend/runtime-assets.ts'

export const resourceRoot = fileURLToPath(new URL('../../resources/', import.meta.url))
export const supportedBackend =
  (process.platform === 'darwin' || process.platform === 'win32') &&
  (process.arch === 'arm64' || process.arch === 'x64')
export const backendExecutable = supportedBackend ? resolveBackendExecutable(resourceRoot) : ''

/** 仅用于启动与失败重试测试；受控文件不用于验证解释器执行能力。 */
export async function createRuntimeFixture(resources: string): Promise<string> {
  await cp(join(resourceRoot, 'skills'), join(resources, 'skills'), { recursive: true })
  const root = resolveRuntimeDirectory(resources)
  const python = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'
  const node = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node'
  const data = Buffer.from('controlled-startup-fixture\n')
  const files = []
  const git = process.platform === 'win32' ? 'git/cmd/git.exe' : 'git/bin/git'
  for (const name of [
    node,
    python,
    git,
    'git/etc/gitconfig',
    'git/libexec/helper',
    'git/share/templates/sample',
  ].sort()) {
    const full = join(root, name)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, data, { mode: 0o755 })
    files.push({
      path: name,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })
  }
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      format_version: 3,
      platform: process.platform === 'win32' ? 'windows' : 'darwin',
      arch: process.arch === 'x64' ? 'amd64' : 'arm64',
      python: { version: '3.12.14', path: python },
      node: { version: '26.13.0', path: node },
      git: {
        version: '2.56.1',
        path: git,
        exec_path: 'git/libexec',
        template_path: 'git/share/templates',
        config_path: 'git/etc/gitconfig',
      },
      files,
    }),
  )
  return root
}

/** 只定位指定隔离配置下的直接子进程，拒绝终止其他测试或日常服务。 */
export async function findTestBackend(parentId: number, profile: string): Promise<number> {
  if (!Number.isSafeInteger(parentId) || parentId <= 0 || !profile.includes('callum-desktop-e2e-'))
    throw new Error('只能定位隔离测试的服务进程')
  const dataDirectory = join(profile, 'backend')
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentId}' | Select-Object ProcessId,ExecutablePath,CommandLine)`,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    )
    const rows = array(JSON.parse(stdout.trim() || '[]'), record)
    const child = rows.find((row) => {
      const commandLine = row.CommandLine
      return (
        typeof commandLine === 'string' &&
        [backendExecutable, `"${backendExecutable}"`].some((path) =>
          commandLine.toLowerCase().startsWith(`${path.toLowerCase()} --data-dir `),
        ) &&
        [dataDirectory, `"${dataDirectory}"`].some((path) =>
          commandLine.includes(` --data-dir ${path} --runtime-dir `),
        )
      )
    })
    if (child && Number.isSafeInteger(child.ProcessId) && Number(child.ProcessId) > 0)
      return Number(child.ProcessId)
  } else {
    const installedRuntime = join(await realpath(dataDirectory), 'runtimes')
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const child = stdout
      .split('\n')
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
      .find(
        (match) =>
          match?.[2] === String(parentId) &&
          match[3] ===
            `${backendExecutable} --data-dir ${dataDirectory} --runtime-dir ${installedRuntime}`,
      )
    if (child?.[1]) return Number(child[1])
  }
  throw new Error('未定位到本次测试独占的服务子进程')
}

/** 仅对调用方提供的测试目录写入本机受控端点；不提供生产环境通用 RPC 入口。 */
export async function seedModel(
  profile: string,
  baseUrl: string,
  approvalPolicy: 'on-request' | 'always' = 'on-request',
  imageInput = false,
): Promise<string> {
  const client = new RpcClient(
    backendExecutable,
    ['--data-dir', join(profile, 'backend')],
    () => undefined,
    () => undefined,
  )
  try {
    if (approvalPolicy !== 'on-request') {
      const settings = record(await client.request('settings.get', { key: 'execution' }))
      await client.request('settings.update', {
        key: 'execution',
        revision: settings.revision,
        value: { approval_policy: approvalPolicy, approvals_reviewer: 'user' },
      })
    }
    const provider = record(
      await client.request('provider.create', {
        name: `受控本机端点-${randomUUID()}`,
        protocol: 'chatcompletions',
        base_url: baseUrl,
      }),
    )
    const model = record(
      await client.request('model.create', {
        provider_id: id(provider.id),
        display_name: '受控文本模型',
        remote_model_id: 'local-fixture',
        enabled: true,
        context_window: 1_000_000,
        model_type: imageInput ? ['text', 'image'] : [],
      }),
    )
    return id(model.id)
  } finally {
    await client.close()
  }
}

/** 只回收当前临时配置拥有的系统主密钥；不枚举系统凭据。服务须先关闭。 */
export async function cleanupTestCredentials(profile: string): Promise<void> {
  const root = await realpath(tmpdir())
  const actual = await realpath(profile)
  const rel = relative(root, actual)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能清理临时测试配置的凭据')
  let directory: string
  try {
    directory = await realpath(join(actual, 'backend'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  const name = createHash('sha256').update(join(directory, 'callum.db')).digest('hex')
  if (process.platform === 'darwin') {
    try {
      await promisify(execFile)(
        '/usr/bin/security',
        ['delete-generic-password', '-s', 'org.callum.credentials.v1', '-a', name],
        { timeout: 5000, maxBuffer: 16384 },
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 44) return
      throw error
    }
  } else if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CallumTestCredential { [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDeleteW(string target,int type,int flags); }'; if (-not [CallumTestCredential]::CredDeleteW('org.callum.credentials.v1:${name}',1,0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw '测试凭据清理失败' }`
    await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10000, maxBuffer: 16384 },
    )
  }
}
