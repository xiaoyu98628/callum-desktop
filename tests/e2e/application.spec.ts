import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test as base, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { backendExecutable, resourceRoot, seedModel, supportedBackend } from '../helpers/backend'
import { startModelServer } from '../helpers/model-server'
import { ChatService } from '../../src/main/backend/chat-service'
import {
  MARKDOWN_CODE,
  MARKDOWN_CODE_START,
  MARKDOWN_END,
  MARKDOWN_START,
  MARKDOWN_UNSAFE,
} from '../helpers/markdown-fixture'
import { IPC_CHANNELS } from '../../src/shared/ipc-channels'
import type { ChatResult, SendMessageInput, SendMessageResult } from '../../src/shared/chat'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

async function interruptTestBackend(desktop: ElectronApplication): Promise<void> {
  const main = await desktop.evaluate(({ app }) => ({
    pid: process.pid,
    profile: app.getPath('userData'),
  }))
  if (!main.profile.includes('callum-desktop-e2e-')) throw new Error('只能终止隔离测试的服务进程')
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  const child = stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .find(
      (match) =>
        match?.[2] === String(main.pid) &&
        match[3] === `${backendExecutable} --data-dir ${join(main.profile, 'backend')}`,
    )
  if (!child?.[1]) throw new Error('未定位到本次测试独占的服务子进程')
  process.kill(Number(child[1]), 'SIGKILL')
}

const test = base.extend<{
  desktop: ElectronApplication
  profile: string
  withModel: boolean
  withEndpoint: boolean
  approvalPolicy: 'on-request' | 'always'
  modelEndpoint: Awaited<ReturnType<typeof startModelServer>> | null
}>({
  withModel: [false, { option: true }],
  withEndpoint: [false, { option: true }],
  approvalPolicy: ['on-request', { option: true }],
  profile: async ({ playwright }, use) => {
    void playwright
    const profile = await mkdtemp(join(tmpdir(), 'callum-desktop-e2e-'))
    try {
      await use(profile)
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  modelEndpoint: async ({ withModel, withEndpoint, profile, approvalPolicy }, use) => {
    if (!withModel && !withEndpoint) {
      await use(null)
      return
    }
    const file = join(profile, 'fixture.txt')
    await writeFile(file, 'controlled-file', { mode: 0o600 })
    const endpoint = await startModelServer(file, 'fixture-ui-key')
    try {
      if (withModel) await seedModel(profile, endpoint.baseUrl, approvalPolicy)
      await use(endpoint)
    } finally {
      await endpoint.close()
    }
  },
  desktop: async ({ playwright, profile, modelEndpoint }, use) => {
    void modelEndpoint
    let application: ElectronApplication | undefined
    let closed = false
    try {
      application = await playwright._electron.launch({
        args: [projectRoot],
        env: { ...process.env, CALLUM_USER_DATA_DIR: profile, CALLUM_TEST_BACKGROUND: '1' },
      })
      application.on('close', () => {
        closed = true
      })
      // 元素获得 DOM 焦点不应激活原生窗口；后台回归保持窗口隐藏。
      await expect
        .poll(() =>
          application!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some(
              (window) => window.isVisible() || window.isFocused(),
            ),
          ),
        )
        .toBe(false)
      await use(application)
    } finally {
      if (!closed) await application?.close()
    }
  },
})

async function prepareManualCompaction(page: Page, title: string, turns = 6) {
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled()
  const overview = await page.evaluate(() => window.callum.getChatOverview(0))
  if (!overview.ok || !overview.value.models[0]) throw new Error('压缩测试模型不存在')
  const modelId = overview.value.models[0].id
  let conversationId: string | null = null
  for (let index = 0; index < turns; index++) {
    const accepted: ChatResult<SendMessageResult> = await page.evaluate(
      (input: SendMessageInput) => window.callum.sendMessage(input),
      {
        conversationId,
        modelId,
        text: `历史第 ${index} 轮 ` + '保留已经确认的事实、约束与决定。'.repeat(120),
      },
    )
    if (!accepted.ok) throw new Error(accepted.error)
    conversationId = accepted.value.conversationId
    await expect
      .poll(async () => {
        const detail = await page.evaluate(
          (id) => window.callum.getConversation(id),
          accepted.value.conversationId,
        )
        return detail.ok && detail.value.runs.find((run) => run.id === accepted.value.runId)?.status
      })
      .toBe('completed')
  }
  if (!conversationId) throw new Error('未创建压缩测试对话')
  await page.evaluate(
    ({ conversationId, title }) => window.callum.renameConversation(conversationId, title),
    { conversationId, title },
  )
  await page
    .getByRole('region', { name: '最近', exact: true })
    .getByRole('button', { name: title, exact: true })
    .click()
  await expect(page.getByRole('article', { name: '你的消息', exact: true })).toHaveCount(turns)
  return { conversationId, modelId }
}

test('发布页面通过受限桥接读取真实应用信息', async ({ desktop }) => {
  const page = await desktop.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '开始一段新对话', exact: true })).toBeVisible()
  await expect(page.getByText('v0.1.0', { exact: true })).toBeVisible()
  expect(page.url()).toBe('callum://app/')
  const bridge = await page.evaluate(async () => ({
    hasNode: 'process' in window || 'require' in window,
    methods: Object.keys(window.callum),
    info: await window.callum.getAppInfo(),
  }))
  expect(bridge.hasNode).toBe(false)
  expect(bridge.methods).toEqual([
    'getAppInfo',
    'copyCode',
    'copyMessage',
    'openWebLink',
    'getModelCatalog',
    'getExecutionSettings',
    'updateExecutionSettings',
    'saveModelProvider',
    'deleteModelProvider',
    'saveModel',
    'setModelEnabled',
    'deleteModel',
    'getChatOverview',
    'getContextUsage',
    'getConversation',
    'chooseWorkspaceDirectories',
    'discardWorkspaceDirectories',
    'listWorkspaces',
    'getWorkspaceConversations',
    'createWorkspace',
    'updateWorkspace',
    'deleteWorkspace',
    'setWorkspacePinned',
    'setWorkspaceArchived',
    'listArchivedWorkspaces',
    'renameConversation',
    'deleteConversation',
    'setConversationPinned',
    'setConversationArchived',
    'listArchivedConversations',
    'getEarlierMessages',
    'listRunSteps',
    'getStepDetails',
    'sendMessage',
    'compactConversation',
    'resendMessage',
    'cancelRun',
    'submitUserInput',
    'decideApproval',
    'listDirectoryGrants',
    'revokeDirectoryGrant',
    'onChatEvent',
  ])
  expect(bridge.info.name).toBe('Callum')
  expect(bridge.info.version).toBe('0.1.0')
  expect(await desktop.evaluate(({ app }) => app.getPath('userData'))).toContain(
    'callum-desktop-e2e-',
  )
  // 显式隔离配置必须同时约束 Go 服务，不能因默认目录变更访问真实 ~/.callum。
  const catalog = await page.evaluate(() => window.callum.getModelCatalog())
  expect(catalog.ok).toBe(true)
  const main = await desktop.evaluate(({ app }) => ({
    pid: process.pid,
    profile: app.getPath('userData'),
  }))
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  const backend = stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .find(
      (match) =>
        match?.[2] === String(main.pid) && match[3]?.startsWith(`${backendExecutable} --data-dir `),
    )
  expect(backend?.[3]).toBe(`${backendExecutable} --data-dir ${join(main.profile, 'backend')}`)
  expect(errors).toEqual([])
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.screenshot({ path: '.artifacts/screenshots/conversation.png' })
})

test('外观支持持久化及跟随系统，侧栏可收起', async ({ desktop }) => {
  const page = await desktop.firstWindow()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '外观', level: 2, exact: true })).toBeVisible()
  await page.getByText('深色', { exact: true }).click()
  await expect(page.getByRole('radio', { name: '深色', exact: false })).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.screenshot({ path: '.artifacts/screenshots/settings-dark.png' })
  await page.getByText('跟随系统', { exact: true }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: '收起侧栏' }).click()
  await expect(page.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByRole('heading', { name: '开始一段新对话' })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible()
})

test('工作内容为空时不创建记录，设置支持键盘操作和小窗口布局', async ({ desktop }) => {
  const page = await desktop.firstWindow()
  const workspace = page.getByRole('region', { name: '项目', exact: true })
  const conversations = page.getByRole('region', { name: '最近', exact: true })
  await expect(workspace.getByText('暂无项目', { exact: true })).toBeVisible()
  await expect(conversations.getByText('暂无对话', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '添加项目' })).toBeEnabled()
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled()
  await expect(page.getByText('尚未配置可用模型，配置完成后即可开始对话。')).toBeVisible()

  await page.getByRole('button', { name: '设置', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '外观', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await page.getByRole('radio', { name: '跟随系统', exact: false }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: '浅色', exact: false })).toBeChecked()
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('窗口不存在')
    window.setSize(860, 620)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(860)
  await expect
    .poll(() =>
      page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true)
  await expect(page.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible()
  await page.screenshot({ path: '.artifacts/screenshots/settings-compact.png' })
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByRole('heading', { name: '开始一段新对话' })).toBeVisible()
  await expect(workspace.getByText('暂无项目', { exact: true })).toBeVisible()
  await expect(conversations.getByText('暂无对话', { exact: true })).toBeVisible()
})

test('发布环境保持隔离、沙箱、CSP 和新窗口限制', async ({ desktop }) => {
  const page = await desktop.firstWindow()
  await expect(page.getByText('v0.1.0', { exact: true })).toBeVisible()
  const sandboxed = await desktop.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('窗口不存在')
    const pid = window.webContents.getOSProcessId()
    return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed
  })
  // Electron 的 OS 级沙箱指标只在 macOS 和 Windows 提供。
  if (process.platform !== 'linux') expect(sandboxed).toBe(true)
  const policy = await desktop.evaluate(async ({ net }) => {
    const response = await net.fetch('callum://app/')
    return response.headers.get('content-security-policy')
  })
  expect(policy).toContain("connect-src 'none'")
  expect(policy).toContain("worker-src 'self'")
  expect(policy).not.toContain('unsafe-eval')
  await page.evaluate(() => {
    window.open('https://example.com')
  })
  expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
    1,
  )
})

test('macOS 关闭窗口后激活可重新打开，IPC 仍然有效', async ({ desktop }) => {
  test.skip(process.platform !== 'darwin', '仅验证 macOS 的应用激活行为')
  const page = await desktop.firstWindow()
  await expect(page.getByText('v0.1.0', { exact: true })).toBeVisible()
  await page.close()
  const nextWindow = desktop.waitForEvent('window')
  await desktop.evaluate(({ app }) => {
    app.emit('activate')
  })
  const reopened = await nextWindow
  await expect(reopened.getByText('v0.1.0', { exact: true })).toBeVisible()
})

test.describe('真实 Go 对话交互', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('双方消息可复制正文，最后一条提问支持取消编辑和重发并在历史中替换回答', async ({
    desktop,
  }) => {
    await desktop.evaluate(({ clipboard }) => {
      const state = { copies: [] as string[], fail: false }
      Reflect.set(globalThis, 'messageActionsTest', state)
      clipboard.writeText = async (text) => {
        if (state.fail) throw new Error('受控剪贴板失败')
        state.copies.push(text)
      }
    })
    const copies = () =>
      desktop.evaluate(() => Reflect.get(globalThis, 'messageActionsTest').copies as string[])
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const users = page.getByRole('article', { name: '你的消息', exact: true })
    const answers = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('保留第一条提问\n第二行')
    await input.press('Enter')
    await expect(answers.last()).toContainText('你好，这是受控回答。')
    const copyQuestion = users.first().getByRole('button', { name: '复制提问', exact: true })
    const questionActions = users.first().getByRole('group', { name: '消息操作', exact: true })
    const answerActions = answers.first().getByRole('group', { name: '消息操作', exact: true })
    await input.focus()
    await input.hover()
    await expect(questionActions).toHaveCSS('opacity', '0')
    await expect(answerActions).toHaveCSS('opacity', '0')
    const questionHeight = await users.first().evaluate((element) => element.clientHeight)
    await users.first().hover()
    await expect(questionActions).toHaveCSS('opacity', '1')
    await expect(answerActions).toHaveCSS('opacity', '0')
    await answers.first().hover()
    await expect(answerActions).toHaveCSS('opacity', '1')
    await expect(questionActions).toHaveCSS('opacity', '0')
    await input.hover()
    await expect(answerActions).toHaveCSS('opacity', '0')
    expect(await users.first().evaluate((element) => element.clientHeight)).toBe(questionHeight)
    await copyQuestion.focus()
    await expect(questionActions).toHaveCSS('opacity', '1')
    await page.keyboard.press('Tab')
    await expect(users.first().getByRole('button', { name: '编辑提问', exact: true })).toBeFocused()
    await expect(questionActions).toHaveCSS('opacity', '1')
    await page.keyboard.press('Shift+Tab')
    await expect(copyQuestion).toBeFocused()
    await copyQuestion.press('Enter')
    expect((await copies()).at(-1)).toBe('保留第一条提问\n第二行')
    await expect(copyQuestion).toBeFocused()
    await answers.first().getByRole('button', { name: '复制回答', exact: true }).click()
    expect((await copies()).at(-1)).toBe('你好，这是受控回答。')
    await expect(answers.first().getByRole('status')).toHaveText('已复制')
    await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok || !overview.value.conversations[0]) throw new Error('测试会话不存在')
      await window.callum.renameConversation(overview.value.conversations[0].id, '消息操作测试')
    })

    await expect(input).toBeEnabled()
    await input.fill('Markdown 安全')
    await input.press('Enter')
    await expect(answers).toHaveCount(2)
    await expect(input).toBeEnabled()
    await answers.last().getByRole('button', { name: '复制回答', exact: true }).click()
    expect((await copies()).at(-1)).toBe(MARKDOWN_UNSAFE)
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'messageActionsTest').fail = true
    })
    await answers.last().getByRole('button', { name: '复制回答', exact: true }).click()
    await expect(answers.last().getByRole('alert')).toContainText('复制失败')
    await input.focus()
    await input.hover()
    await expect(answers.last().getByRole('group', { name: '消息操作', exact: true })).toHaveCSS(
      'opacity',
      '0',
    )
    await expect(answers.last().getByRole('alert')).toBeVisible()
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'messageActionsTest').fail = false
    })
    await answers.last().getByRole('button', { name: '复制回答', exact: true }).click()
    await expect(answers.last().getByRole('alert')).toHaveCount(0)
    await expect(users.first().getByRole('button', { name: '编辑提问', exact: true })).toHaveCount(
      0,
    )

    await input.fill('普通输入草稿')
    const edit = users.last().getByRole('button', { name: '编辑提问', exact: true })
    await edit.focus()
    await expect(users.last().getByRole('group', { name: '消息操作', exact: true })).toHaveCSS(
      'opacity',
      '1',
    )
    await edit.press('Enter')
    const editor = page.getByRole('form', { name: '编辑最后一条提问', exact: true })
    const text = editor.getByRole('textbox', { name: '编辑提问', exact: true })
    await expect(text).toBeFocused()
    await expect(text).toHaveValue('Markdown 安全')
    await expect(input).toBeDisabled()
    const send = editor.getByRole('button', { name: '重新发送', exact: true })
    await expect(send).toHaveAccessibleDescription('重发会替换旧回答，已执行的操作会保留。')
    await text.fill('请检查上一轮命令的结果。\n把执行状态和输出一起列出来。')
    await editor.screenshot({ path: '.artifacts/screenshots/message-editor.png' })
    const shortHeight = await text.evaluate((element) => element.clientHeight)
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await text.fill('这是一行需要保留的编辑内容。\n'.repeat(30))
    await expect
      .poll(() => text.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(shortHeight)
    await expect
      .poll(() => text.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true)
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await text.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(edit).toBeFocused()
    await expect(users.last()).toContainText('Markdown 安全')
    await expect(input).toHaveValue('普通输入草稿')
    await edit.press('Enter')
    await text.fill('取消这次修改')
    await editor.getByRole('button', { name: '取消编辑', exact: true }).click()
    await expect(users.last()).toContainText('Markdown 安全')
    await expect(input).toHaveValue('普通输入草稿')
    await edit.click()
    await text.fill('修正后的最后一条提问')
    await send.click()
    await expect(editor).toHaveCount(0)
    await expect(users).toHaveCount(2)
    await expect(answers).toHaveCount(2)
    await expect(users.last()).toContainText('修正后的最后一条提问')
    await expect(answers.last()).toContainText('你好，这是受控回答。')
    await expect(input).toHaveValue('普通输入草稿')
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '消息操作测试', exact: true })
      .click()
    await expect(users.last()).toContainText('修正后的最后一条提问')
    await expect(answers).toHaveCount(2)
    await expect(answers.last()).toContainText('你好，这是受控回答。')
    await input.fill('等待甲')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    await expect(users.last().getByRole('button', { name: '编辑提问', exact: true })).toBeDisabled()
    await expect(answers.last()).toContainText('仅属于等待甲的内容')
    const copyAnswer = answers.last().getByRole('button', { name: '复制回答', exact: true })
    await expect(copyAnswer).toHaveCount(0)
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(users.last().getByRole('button', { name: '编辑提问', exact: true })).toBeEnabled()
    await copyAnswer.click()
    expect((await copies()).at(-1)).toBe('仅属于等待甲的内容')
    await input.focus()
    await input.hover()
    await page.screenshot({ path: '.artifacts/screenshots/message-actions-light.png' })
    await users.last().hover()
    await page.screenshot({ path: '.artifacts/screenshots/message-actions-hover.png' })
  })

  test('处理用时按执行关联，切换页面释放计时，完成与历史恢复后固定', async ({
    desktop,
    modelEndpoint,
  }) => {
    if (!modelEndpoint) throw new Error('受控端点不存在')
    const page = await desktop.firstWindow()
    // 观察真实浏览器定时器，不修改生产组件，也不改变后端或系统时间。
    await page.evaluate(() => {
      const timers = new Set<unknown>()
      const start = window.setInterval.bind(window),
        stop = window.clearInterval.bind(window)
      Reflect.set(window, 'runStatusTimers', timers)
      Reflect.set(window, 'setInterval', (...args: Parameters<typeof window.setInterval>) => {
        const timer = start(...args)
        if (args[1] === 1000) timers.add(timer)
        return timer
      })
      Reflect.set(window, 'clearInterval', (...args: Parameters<typeof window.clearInterval>) => {
        timers.delete(args[0])
        return stop(...args)
      })
    })
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const status = page.getByRole('group', { name: '执行状态', exact: true })
    const sidebar = page.getByRole('region', { name: '最近', exact: true })
    const timers = () => page.evaluate(() => Reflect.get(window, 'runStatusTimers').size)
    await expect(input).toBeEnabled()
    await input.fill('Markdown 流式')
    await input.press('Enter')
    await expect(status).toHaveCount(1)
    await expect(status).toContainText(/正在处理\s+[1-9]\d* 秒/)
    await expect.poll(timers).toBe(1)
    const conversationId = await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok || !overview.value.conversations[0]) throw new Error('会话不存在')
      return overview.value.conversations[0].id
    })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect.poll(timers).toBe(0)
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(status).toHaveCount(0)
    await input.fill('另一轮')
    await input.press('Enter')
    await expect(status).toContainText('已处理')
    await expect.poll(timers).toBe(0)
    await sidebar.getByRole('button', { name: 'Markdown 流式', exact: true }).click()
    await expect(status).toContainText(/正在处理\s+[1-9]\d* 秒/)
    await expect.poll(timers).toBe(1)
    modelEndpoint.finishMarkdown()
    await expect(status).toContainText('已处理')
    await expect.poll(timers).toBe(0)
    const finished = await status.innerText()
    const run = await page.evaluate(async (id) => {
      const detail = await window.callum.getConversation(id)
      if (!detail.ok || !detail.value.runs[0]) throw new Error('执行不存在')
      return detail.value.runs[0]
    }, conversationId)
    expect(run.finishedAt).not.toBeNull()
    if (run.finishedAt === null) throw new Error('执行没有结束时间')
    expect(run.finishedAt - run.createdAt).toBeGreaterThanOrEqual(1000)
    await sidebar.getByRole('button', { name: '另一轮', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Markdown 流式', exact: true }).click()
    await expect(status).toHaveText(finished)
    await expect.poll(timers).toBe(0)
    await page.reload()
    await sidebar.getByRole('button', { name: 'Markdown 流式', exact: true }).click()
    await expect(status).toHaveText(finished)
    await expect(page.getByRole('heading', { name: 'Markdown 示例', exact: true })).toBeVisible()
    await status.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.artifacts/screenshots/conversation-duration.png' })
  })

  test('模型浮层向上展开，支持选中标记、键盘、长名称与深色小窗口', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const picker = page.getByRole('combobox', { name: '模型', exact: true })
    const list = page.getByRole('listbox', { name: '选择模型', exact: true })
    async function openModels(key?: 'ArrowDown'): Promise<void> {
      if (key) await picker.press(key)
      else await picker.click()
      await expect(list).toBeVisible()
      // 完成定位后 reka-ui 会聚焦当前选项；等到此时再开始悬停、导航或外部点击。
      await expect(page.getByRole('option', { selected: true })).toBeFocused()
      // Reka 将外部指针监听延后注册；等待定位帧后的浏览器任务，避免焦点早于监听就绪。
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
      )
    }
    await expect(picker).toHaveText('受控文本模型')
    const longName = await page.evaluate(async () => {
      const result = await window.callum.getModelCatalog()
      if (!result.ok || !result.value.providers[0]) throw new Error('测试供应商不存在')
      const providerId = result.value.providers[0].id
      for (let index = 1; index <= 24; index++) {
        const saved = await window.callum.saveModel({
          id: null,
          providerId,
          name: `展示模型 ${String(index).padStart(2, '0')}`,
          remoteModelId: `display-${index}`,
          enabled: true,
        })
        if (!saved.ok) throw new Error(saved.error)
      }
      const name = '长名称模型-' + 'abcdefghij'.repeat(10)
      const saved = await window.callum.saveModel({
        id: null,
        providerId,
        name,
        remoteModelId: 'long-name-model',
        enabled: true,
      })
      if (!saved.ok) throw new Error(saved.error)
      return name
    })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(picker).toBeEnabled()
    const triggerBox = await picker.boundingBox()
    await openModels()
    const listBox = await list.boundingBox()
    if (!triggerBox || !listBox) throw new Error('模型浮层不存在')
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(triggerBox.y)
    expect(listBox.height).toBeLessThanOrEqual(288)
    const selected = page.getByRole('option', { name: '受控文本模型', exact: true })
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect(selected.locator('svg')).toBeVisible()
    const option = page.getByRole('option', { name: '展示模型 01', exact: true })
    await option.hover()
    await expect(option).toHaveAttribute('data-highlighted', '')
    await page.screenshot({ path: '.artifacts/screenshots/model-selector-light.png' })
    await option.click()
    await expect(picker).toHaveText('展示模型 01')
    await expect(list).not.toBeVisible()
    await expect(picker).toBeFocused()
    await openModels('ArrowDown')
    const firstName = (await page.getByRole('option').first().innerText()).trim()
    await page.keyboard.press('Home')
    await expect(page.getByRole('option').first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(list).not.toBeVisible()
    await expect(picker).toHaveText(firstName)
    const noSubmission = await page.evaluate(() => window.callum.getChatOverview(0))
    expect(noSubmission.ok && noSubmission.value.conversations.length).toBe(0)
    await openModels()
    await page.keyboard.press('Escape')
    await expect(list).not.toBeVisible()
    await expect(picker).toBeFocused()
    await openModels()
    await page.mouse.click(300, 500)
    await expect(list).not.toBeVisible()
    await openModels()
    await page.getByRole('option', { name: longName, exact: true }).click()
    await expect(picker).toHaveText(longName)
    expect((await picker.boundingBox())?.width).toBeLessThanOrEqual(224)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await openModels()
    const bounds = await list.boundingBox()
    if (!bounds) throw new Error('模型浮层不存在')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
    expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(page.getByRole('option', { name: longName, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.screenshot({ path: '.artifacts/screenshots/model-selector-dark-compact.png' })
    await page.keyboard.press('Escape')
  })

  test('输入默认两行，自动向上增高并在删除、发送、恢复草稿及窗口缩放时适配', async ({
    desktop,
  }) => {
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    const geometry = () =>
      input.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement
        const form = textarea.closest('form')
        if (!form) throw new Error('输入表单不存在')
        const style = getComputedStyle(textarea),
          rect = form.getBoundingClientRect()
        return {
          inputHeight: textarea.getBoundingClientRect().height,
          minimumHeight:
            2 * parseFloat(style.lineHeight) +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom),
          maxHeight: parseFloat(style.maxHeight),
          formHeight: rect.height,
          top: rect.top,
          bottom: rect.bottom,
          clientHeight: textarea.clientHeight,
          scrollHeight: textarea.scrollHeight,
          overflowY: style.overflowY,
        }
      })
    await expect(input).toHaveAttribute('rows', '2')
    const initial = await geometry()
    expect(initial.inputHeight).toBeCloseTo(initial.minimumHeight, 0)
    expect(initial.formHeight).toBeLessThanOrEqual(104)
    const inputBox = await input.boundingBox(),
      pickerBox = await page.getByRole('combobox', { name: '模型', exact: true }).boundingBox(),
      sendBox = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox()
    if (!inputBox || !pickerBox || !sendBox) throw new Error('输入区域不存在')
    expect(pickerBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height)
    expect(sendBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height)
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(initial.bottom)
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(initial.bottom)
    await page.screenshot({ path: '.artifacts/screenshots/composer-two-lines.png' })
    const wrappedText = '内容超过一行时自动向上增高。'.repeat(9)
    await input.fill(wrappedText)
    await expect
      .poll(async () => (await geometry()).inputHeight)
      .toBeGreaterThan(initial.inputHeight)
    const expanded = await geometry()
    expect(expanded.top).toBeLessThan(initial.top)
    expect(expanded.bottom).toBeCloseTo(initial.bottom, 0)
    await input.fill('短消息')
    await expect.poll(async () => (await geometry()).inputHeight).toBe(initial.inputHeight)
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('短消息\n')
    await expect.poll(async () => (await geometry()).inputHeight).toBe(initial.inputHeight)
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('短消息\n\n')
    await expect
      .poll(async () => (await geometry()).inputHeight)
      .toBeGreaterThan(initial.inputHeight)
    await input.fill(
      Array.from({ length: 40 }, (_, index) => `粘贴内容第 ${index + 1} 行`).join('\n'),
    )
    await expect.poll(async () => (await geometry()).inputHeight).toBe(initial.maxHeight)
    const capped = await geometry()
    expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight)
    expect(capped.overflowY).toBe('auto')
    expect(capped.bottom).toBeCloseTo(initial.bottom, 0)
    await page.screenshot({ path: '.artifacts/screenshots/composer-multiline.png' })
    await input.fill(wrappedText)
    const wideHeight = (await geometry()).inputHeight
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await expect.poll(async () => (await geometry()).inputHeight).toBeGreaterThan(wideHeight)
    await expect(input).toHaveValue(wrappedText)
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1240, 820),
    )
    await expect.poll(async () => (await geometry()).inputHeight).toBe(wideHeight)
    await input.fill('你好')
    await input.press('Enter')
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await geometry()).inputHeight).toBe(initial.inputHeight)
    await input.fill(wrappedText)
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await geometry()).inputHeight).toBe(initial.inputHeight)
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await expect(input).toHaveValue(wrappedText)
    await expect.poll(async () => (await geometry()).inputHeight).toBe(wideHeight)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await expect(input).toHaveValue(wrappedText)
    await expect.poll(async () => (await geometry()).inputHeight).toBe(wideHeight)
    await input.fill('')
    await expect.poll(async () => (await geometry()).inputHeight).toBe(initial.inputHeight)
    expect(errors).toEqual([])
  })

  test('发送、停止、切换与刷新保留历史，并验证受限输入', async ({ desktop, modelEndpoint }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText(
      '受控文本模型',
    )
    await expect(input).toBeEnabled()
    await input.fill('你好')
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('你好\n')
    await input.press('Enter')
    await expect(
      page
        .getByRole('article', { name: 'Callum 的回答' })
        .getByText('你好，这是受控回答。', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()
    const bubble = await page
      .getByRole('article', { name: '你的消息', exact: true })
      .first()
      .evaluate((element) => {
        const container = element.parentElement
        if (!container) throw new Error('消息容器不存在')
        const rect = element.getBoundingClientRect(),
          parent = container.getBoundingClientRect()
        return {
          width: rect.width,
          containerWidth: parent.width,
          rightGap: parent.right - rect.right,
        }
      })
    expect(bubble.width).toBeLessThan(bubble.containerWidth / 2)
    expect(bubble.rightGap).toBeCloseTo(0, 0)
    const sendPosition = await page
      .getByRole('button', { name: '发送消息', exact: true })
      .boundingBox()
    if (!sendPosition) throw new Error('发送按钮不存在')
    await input.fill('等待甲')
    await input.press('Enter')
    await expect(page.getByText('仅属于等待甲的内容', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成' })).toBeEnabled()
    const stopPosition = await page
      .getByRole('button', { name: '停止生成', exact: true })
      .boundingBox()
    if (!stopPosition) throw new Error('停止按钮不存在')
    expect(stopPosition.width).toBeCloseTo(sendPosition.width, 0)
    expect(stopPosition.height).toBeCloseTo(sendPosition.height, 0)
    expect(stopPosition.x).toBeCloseTo(sendPosition.x, 0)
    expect(stopPosition.y).toBeCloseTo(sendPosition.y, 0)
    await page.screenshot({
      path: '.artifacts/screenshots/composer-generating.png',
      animations: 'disabled',
    })
    await expect(page.getByRole('combobox', { name: '模型', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await expect(page.getByText('仅属于等待甲的内容', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('第二个会话')
    await input.press('Enter')
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
    await expect(page.getByText('仅属于等待甲的内容', { exact: true })).not.toBeVisible()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.getByText('生成已停止', { exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: '执行状态' }).last()).toContainText('生成已停止')
    await expect.poll(() => modelEndpoint?.cancelled).toBeGreaterThan(0)
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await expect(page.getByText('生成已停止', { exact: true })).toBeVisible()
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
    const invalid = await page.evaluate(() =>
      window.callum.sendMessage({ conversationId: null, modelId: 'invalid', text: '不能受理' }),
    )
    expect(invalid.ok).toBe(false)
    const overview = await page.evaluate(() => window.callum.getChatOverview(0))
    expect(overview.ok && overview.value.conversations.length).toBe(2)
    await page.screenshot({ path: '.artifacts/screenshots/conversation-connected.png' })
  })

  test('默认读取文件、列目录和搜索不审批，权限管理按需打开并恢复焦点', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const answers = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    for (const text of ['只读文件', '只读目录', '只读搜索']) {
      await expect(input).toBeEnabled()
      const before = await answers.count()
      await input.fill(text)
      await input.press('Enter')
      await expect(answers).toHaveCount(before + 1)
      await expect(answers.last()).toContainText('已完成只读检查。')
      await expect(page.getByRole('region', { name: '工具审批', exact: true })).toHaveCount(0)
    }
    await expect(page.getByLabel('会话目录授权', { exact: true })).toHaveCount(0)
    const trigger = page.getByRole('button', { name: '会话权限', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '会话权限', exact: true })
    await expect(
      dialog.getByText('暂无额外目录授权。普通读取无需先添加授权。', { exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test.describe('逐次读取审批交互', () => {
    test.use({ approvalPolicy: 'always' })

    test('输入框切换三种审批模式，AI 审批和转人工由 Go 服务执行', async ({ desktop }) => {
      const page = await desktop.firstWindow()
      const trigger = page.getByRole('button', { name: '审批模式', exact: true })
      const menu = page.getByRole('menu')
      const request = menu.getByRole('menuitemradio', { name: /^请求批准/ })
      const assist = menu.getByRole('menuitemradio', { name: /^帮我审批/ })
      const full = menu.getByRole('menuitemradio', { name: /^完全访问权限/ })
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      const panel = page.getByRole('region', { name: '工具审批', exact: true })
      await expect(trigger).toHaveText('请求批准')
      await trigger.focus()
      await trigger.press('Enter')
      await expect(menu.getByRole('menuitemradio')).toHaveCount(3)
      await expect(request).toHaveAttribute('aria-checked', 'true')
      await expect(assist).toBeEnabled()
      await page.screenshot({ path: '.artifacts/screenshots/approval-mode-menu.png' })
      await assist.click()
      await expect(trigger).toHaveText('帮我审批')

      await input.fill('AI 审批目录')
      await input.press('Enter')
      await expect(page.getByText('已查看当前目录。', { exact: true })).toBeVisible()
      await expect(panel).toHaveCount(0)
      const timeline = page.getByRole('region', { name: '调用过程', exact: true })
      const disclosure = timeline.getByRole('button', { name: '调用过程', exact: true })
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
      await disclosure.click()
      await timeline.getByRole('button', { name: '工具详情：已运行 /bin/pwd', exact: true }).click()
      await expect(timeline.getByRole('button', { name: /^操作分组：/ })).toHaveCount(0)
      await expect(
        page.getByText('AI 审批通过。用户明确要求查看当前目录。', { exact: true }),
      ).toBeVisible()

      await input.fill('AI 审批转人工')
      await input.press('Enter')
      await expect(panel).toContainText('受控审核需要用户确认。')
      await panel.getByRole('button', { name: '拒绝', exact: true }).click()
      await expect(page.getByText('操作已拒绝。', { exact: true })).toBeVisible()
      await trigger.click()
      await full.click()
      await expect(trigger).toHaveText('完全访问权限')
      await page.reload()
      await expect(trigger).toHaveText('完全访问权限')
      await trigger.click()
      await expect(full).toHaveAttribute('aria-checked', 'true')
      await request.click()
      await expect(trigger).toHaveText('请求批准')
      const settings = await page.evaluate(() => window.callum.getExecutionSettings())
      expect(settings).toMatchObject({
        ok: true,
        value: {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
        },
      })
    })

    test('审批位于底部输入区，过程说明和工具步骤在完成及历史重载后保留', async ({
      desktop,
      modelEndpoint,
      profile,
    }) => {
      const page = await desktop.firstWindow()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('需要审批')
      await input.press('Enter')
      await expect(page.getByRole('heading', { name: '允许读取文件？' })).toBeVisible()
      const panel = page.getByRole('region', { name: '工具审批', exact: true })
      await expect(
        page.getByRole('button', {
          name: '工具详情：读取文件 · 等待审批 fixture.txt',
          exact: true,
        }),
      ).toBeVisible()
      await expect(input).toBeVisible()
      await expect(input).toBeDisabled()
      await expect(panel).toBeFocused()
      await panel.press('Enter')
      await panel.press('Escape')
      await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: '收起工具审批', exact: true }).click()
      await expect(panel.getByRole('button', { name: '仅本次允许', exact: true })).not.toBeVisible()
      expect(modelEndpoint?.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(
        0,
      )
      await panel.getByRole('button', { name: '展开工具审批', exact: true }).click()
      await expect(panel.getByRole('button', { name: '仅本次允许', exact: true })).toBeVisible()
      expect(
        await panel.evaluate((element) => {
          const section = element.closest('section[aria-label="对话内容"]')
          const scroller =
            section?.querySelector('[aria-label="消息记录"]')?.parentElement?.parentElement
          return !!scroller && !scroller.contains(element)
        }),
      ).toBe(true)
      await expect(panel.getByText(join(profile, 'fixture.txt'), { exact: true })).toBeVisible()
      await page.screenshot({
        path: '.artifacts/screenshots/approval-composer-light.png',
        animations: 'disabled',
      })
      await panel.getByText('查看详情', { exact: true }).click()
      await expect(page.getByRole('group', { name: '执行状态', exact: true })).toContainText(
        '等待审批',
      )
      await expect(panel.locator('pre')).toContainText(join(profile, 'fixture.txt'))
      expect(modelEndpoint?.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(
        0,
      )
      await page.reload()
      await page
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: '需要审批', exact: true })
        .click()
      await expect(page.getByRole('heading', { name: '允许读取文件？' })).toBeVisible()
      await page.getByRole('button', { name: '仅本次允许' }).click()
      await expect(page.getByText('已读取测试文件。', { exact: true })).toBeVisible()
      await expect(page.getByRole('group', { name: '执行状态', exact: true })).toContainText(
        '已处理',
      )
      const timeline = page.getByRole('region', { name: '调用过程', exact: true })
      await expect(timeline.getByRole('button', { name: '调用过程', exact: true })).toHaveAttribute(
        'aria-expanded',
        'false',
      )
      await timeline.getByRole('button', { name: '调用过程', exact: true }).click()
      await expect(timeline.getByText('准备检查文件。', { exact: true })).toBeVisible()
      const readStep = timeline.getByRole('button', {
        name: '工具详情：已读取 fixture.txt',
        exact: true,
      })
      await readStep.click()
      await expect(timeline.getByText('已保存的结果', { exact: true })).toBeVisible()
      await expect(timeline.getByLabel('工具结果', { exact: true })).toContainText(
        'controlled-file',
      )
      await page.reload()
      await page
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: '需要审批', exact: true })
        .click()
      await expect(timeline.getByRole('button', { name: '调用过程', exact: true })).toHaveAttribute(
        'aria-expanded',
        'false',
      )
      await timeline.getByRole('button', { name: '调用过程', exact: true }).click()
      await expect(timeline.getByText('准备检查文件。', { exact: true })).toBeVisible()
      await expect(readStep).toBeVisible()
      await expect(timeline.getByRole('button', { name: /^操作分组：/ })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '仅本次允许' })).not.toBeVisible()
      await expect(input).toBeVisible()
      expect(
        modelEndpoint?.requests.some(
          (request) => request.lastRole === 'tool' && request.text.includes('controlled-file'),
        ),
      ).toBe(true)
      await page.screenshot({ path: '.artifacts/screenshots/conversation-approved.png' })
    })

    test('底部审批在切换会话后恢复，拒绝与停止后保留草稿和自动增高', async ({
      desktop,
      modelEndpoint,
      profile,
    }) => {
      if (!modelEndpoint) throw new Error('受控端点不存在')
      const page = await desktop.firstWindow()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      const panel = page.getByRole('region', { name: '工具审批', exact: true })
      const sidebar = page.getByRole('region', { name: '最近', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('需要延迟审批')
      await input.press('Enter')
      await expect(page.getByText('准备检查文件。', { exact: true })).toBeVisible()
      await expect(input).toBeEnabled()
      const draft = '审批后继续讨论。\n第二行草稿。'
      await input.fill(draft)
      const draftHeight = await input.evaluate((element) => element.getBoundingClientRect().height)
      modelEndpoint.requestApproval()
      await expect(panel).toBeVisible()
      await expect(input).toBeVisible()
      await expect(input).toBeDisabled()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByText('深色', { exact: true }).click()
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
      )
      await sidebar.getByRole('button', { name: '需要延迟审批', exact: true }).click()
      await expect(panel).toBeVisible()
      await page.screenshot({
        path: '.artifacts/screenshots/approval-composer-dark.png',
        animations: 'disabled',
      })
      await panel.getByText('查看详情', { exact: true }).click()
      await expect(panel.getByLabel('完整操作快照')).toContainText(join(profile, 'fixture.txt'))
      const panelBox = await panel.boundingBox(),
        approveBox = await panel
          .getByRole('button', { name: '仅本次允许', exact: true })
          .boundingBox()
      if (!panelBox || !approveBox) throw new Error('审批区域不存在')
      expect(panelBox.y).toBeGreaterThanOrEqual(0)
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(
        await page.evaluate(() => innerHeight),
      )
      expect(approveBox.y + approveBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height)
      expect(
        await page
          .locator('main')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true)
      await page.screenshot({
        path: '.artifacts/screenshots/approval-details-compact.png',
        animations: 'disabled',
      })
      await page.getByRole('button', { name: '新对话', exact: true }).click()
      await expect(panel).not.toBeVisible()
      await expect(input).toHaveValue('')
      await sidebar.getByRole('button', { name: '需要延迟审批', exact: true }).click()
      await expect(panel).toBeVisible()
      expect(modelEndpoint.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(
        0,
      )
      await panel.getByRole('button', { name: '拒绝', exact: true }).click()
      await expect(page.getByText('操作已拒绝。', { exact: true })).toBeVisible()
      await expect(panel).not.toBeVisible()
      await expect(input).toHaveValue(draft)
      await expect(input).toBeFocused()
      await expect
        .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(draftHeight)
      await input.fill('审批停止')
      await input.press('Enter')
      await expect(panel).toBeVisible()
      const toolCalls = modelEndpoint.requests.filter(
        (request) => request.lastRole === 'tool',
      ).length
      await page.getByRole('button', { name: '停止生成', exact: true }).click()
      await expect(page.getByText('生成已停止', { exact: true })).toBeVisible()
      await expect(panel).not.toBeVisible()
      await expect(input).toBeEnabled()
      expect(modelEndpoint.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(
        toolCalls,
      )
    })

    test('审批提交失败保留完整快照，提交中不能重复操作，可以重新查询待审批状态', async ({
      desktop,
      modelEndpoint,
    }) => {
      const page = await desktop.firstWindow()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      const panel = page.getByRole('region', { name: '工具审批', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('审批提交')
      await input.press('Enter')
      await expect(panel).toBeVisible()
      const snapshot = await panel.getByLabel('完整操作快照').textContent()
      // 仅替换本次隔离进程的 IPC 回包以制造失败；真实 Go 审批保持 pending。
      await desktop.evaluate(({ ipcMain }, channel) => {
        const state: { attempts: number; release: (() => void) | null } = {
          attempts: 0,
          release: null,
        }
        Reflect.set(globalThis, 'approvalFailure', state)
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async () => {
          state.attempts++
          await new Promise<void>((resolve) => {
            state.release = resolve
          })
          return { ok: false, error: '受控审批提交失败' }
        })
      }, IPC_CHANNELS.decideApproval)
      await panel.getByRole('button', { name: '仅本次允许', exact: true }).click()
      await expect(panel.getByRole('button', { name: '仅本次允许', exact: true })).toBeDisabled()
      await expect(panel.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeDisabled()
      await panel.press('Enter')
      expect(
        await desktop.evaluate(() => Reflect.get(globalThis, 'approvalFailure').attempts),
      ).toBe(1)
      await desktop.evaluate(() => {
        const release: unknown = Reflect.get(globalThis, 'approvalFailure').release
        if (typeof release !== 'function') throw new Error('没有待完成的提交')
        release()
      })
      await expect(panel.getByRole('alert')).toContainText('受控审批提交失败')
      expect(await panel.getByLabel('完整操作快照').textContent()).toBe(snapshot)
      await expect(input).toBeVisible()
      await expect(input).toBeDisabled()
      await panel.getByRole('button', { name: '重新加载审批', exact: true }).click()
      await expect(panel.getByRole('alert')).toHaveCount(0)
      await expect(panel.getByRole('button', { name: '仅本次允许', exact: true })).toBeEnabled()
      expect(await panel.getByLabel('完整操作快照').textContent()).toBe(snapshot)
      expect(modelEndpoint?.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(
        0,
      )
    })
  })

  test('沙箱内项目写入审批展示范围并只执行本次命令', async ({ desktop, profile }) => {
    const page = await desktop.firstWindow()
    await addTestWorkspace(desktop, page, profile, '受控命令项目')
    const project = page.getByRole('region', { name: '受控命令项目', exact: true })
    await project.getByRole('button', { name: '在受控命令项目中新建对话', exact: true }).click()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const panel = page.getByRole('region', { name: '工具审批', exact: true })
    await input.fill('沙箱申请项目写入')
    await input.press('Enter')
    await expect(panel.getByText('沙箱内项目写入', { exact: true })).toBeVisible()
    await expect(panel.getByText('可修改或删除项目内的文件', { exact: false })).toBeVisible()
    const projectPath = await realpath(profile)
    await expect(panel.locator('dd').filter({ hasText: projectPath }).first()).toBeVisible()
    const target = join(profile, 'sandbox-write.txt')
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await panel.getByRole('button', { name: '仅本次允许', exact: true }).click()
    await expect.poll(() => readFile(target, 'utf8').catch(() => '')).toBe('controlled')
    await expect(panel).not.toBeVisible()
  })

  test('会话目录写授权覆盖子目录、其他会话隔离并可撤销', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const panel = page.getByRole('region', { name: '工具审批', exact: true })
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    await input.fill('目录审批')
    await input.press('Enter')
    await expect(
      panel.getByText('本会话允许此目录及子目录读取和普通修改', { exact: false }),
    ).toBeVisible()
    await panel.getByRole('button', { name: '本会话允许此目录', exact: true }).click()
    await expect(answer.last()).toContainText('已修改测试文件。')
    await page.getByRole('button', { name: '会话权限', exact: true }).click()
    const permissions = page.getByRole('dialog', { name: '会话权限', exact: true })
    await expect(permissions).toBeVisible()
    await expect(permissions.getByText('读取和普通修改', { exact: true })).toBeVisible()
    await permissions.getByRole('button', { name: '关闭会话权限', exact: true }).click()
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '目录审批', exact: true })
      .click()
    await input.fill('目录再次审批')
    await input.press('Enter')
    await expect(answer.last()).toContainText('已修改测试文件。')
    await expect(panel).not.toBeVisible()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('另一个会话目录审批')
    await input.press('Enter')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect(input).toBeEnabled()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '目录审批', exact: true })
      .click()
    await page.getByRole('button', { name: '会话权限', exact: true }).click()
    await permissions.getByRole('button', { name: '撤销授权', exact: true }).click()
    await expect(permissions.getByText('已撤销', { exact: false })).toBeVisible()
    await permissions.getByRole('button', { name: '关闭会话权限', exact: true }).click()
    await input.fill('目录撤销后审批')
    await input.press('Enter')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '拒绝', exact: true }).click()
  })

  test.describe('逐次审批隔离与断连', () => {
    test.use({ approvalPolicy: 'always' })

    test('连续工具审批逐项确认，新目标不会继承上一项决定', async ({
      desktop,
      modelEndpoint,
      profile,
    }) => {
      await writeFile(join(profile, 'fixture.txt.second'), 'second-controlled-file', {
        mode: 0o600,
      })
      const page = await desktop.firstWindow()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      const panel = page.getByRole('region', { name: '工具审批', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('需要连续审批')
      await input.press('Enter')
      await expect(panel.getByText(join(profile, 'fixture.txt'), { exact: true })).toBeVisible()
      await panel.getByText('查看详情', { exact: true }).click()
      await panel.getByRole('button', { name: '仅本次允许', exact: true }).click()
      await expect(
        panel.getByText(join(profile, 'fixture.txt.second'), { exact: true }),
      ).toBeVisible()
      await expect(panel.getByLabel('完整操作快照')).toBeHidden()
      await expect(panel).toBeFocused()
      expect(modelEndpoint?.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(
        0,
      )
      await panel.getByRole('button', { name: '拒绝', exact: true }).click()
      await expect(page.getByText('操作已拒绝。', { exact: true })).toBeVisible()
      await expect(panel).not.toBeVisible()
      await expect(input).toBeEnabled()
    })

    test('待审批时连接中断会保留操作详情并禁用所有决定和停止操作', async ({ desktop }) => {
      const page = await desktop.firstWindow()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      const panel = page.getByRole('region', { name: '工具审批', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('审批服务中断')
      await input.press('Enter')
      await expect(panel).toBeVisible()
      const snapshot = await panel.getByLabel('完整操作快照').textContent()
      await interruptTestBackend(desktop)
      await expect(panel.getByRole('alert')).toContainText('连接已中断')
      for (const name of ['仅本次允许', '拒绝'])
        await expect(panel.getByRole('button', { name, exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeDisabled()
      expect(await panel.getByLabel('完整操作快照').textContent()).toBe(snapshot)
      await expect(input).toBeVisible()
      await expect(input).toBeDisabled()
      await panel.getByRole('button', { name: '重新加载审批', exact: true }).click()
      await expect(panel.getByRole('alert')).toContainText('连接已中断')
      await expect(panel.getByRole('button', { name: '仅本次允许', exact: true })).toBeDisabled()
    })
  })

  test('失败不会当成成功，长消息在小窗口正常换行', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('失败')
    await input.press('Enter')
    await expect(page.getByRole('alert')).toContainText(/失败|暂不可用/)
    await expect(page.getByRole('group', { name: '执行状态', exact: true })).toContainText(
      '回答失败',
    )
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await input.fill('长内容' + 'a'.repeat(3000))
    await input.press('Enter')
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
    expect(
      await page
        .getByRole('article', { name: '你的消息', exact: true })
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await page.screenshot({ path: '.artifacts/screenshots/conversation-compact.png' })
  })

  test('macOS 关闭窗口保留执行，应用退出释放服务数据锁', async ({
    desktop,
    profile,
    modelEndpoint,
  }) => {
    test.skip(process.platform !== 'darwin')
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('等待窗口恢复')
    await input.press('Enter')
    await expect(page.getByText('仅属于等待窗口恢复的内容')).toBeVisible()
    await page.close()
    expect(modelEndpoint?.cancelled).toBe(0)
    const nextWindow = desktop.waitForEvent('window')
    await desktop.evaluate(({ app }) => {
      app.emit('activate')
    })
    const reopened = await nextWindow
    await reopened
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '等待窗口恢复', exact: true })
      .click()
    await expect(reopened.getByText('仅属于等待窗口恢复的内容')).toBeVisible()
    await desktop.close()
    // 同一目录能再次启动并写入，证明旧服务已释放实例锁；端点仍限定在本机。
    if (!modelEndpoint) throw new Error('测试模型端点不存在')
    expect(await seedModel(profile, modelEndpoint.baseUrl)).toMatch(/^[0-9a-f-]+$/)
  })

  test('消息历史按真实序号向前翻页，并可返回最新页面', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled()
    await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok || !overview.value.models[0]) throw new Error('测试模型不存在')
      const modelId = overview.value.models[0].id
      let conversationId: string | null = null
      for (let index = 0; index < 26; index++) {
        const accepted = await window.callum.sendMessage({
          conversationId,
          modelId,
          text: `分页-${index}`,
        })
        if (!accepted.ok) throw new Error(accepted.error)
        conversationId = accepted.value.conversationId
        const deadline = Date.now() + 5000
        while (true) {
          const detail = await window.callum.getConversation(conversationId)
          if (!detail.ok) throw new Error(detail.error)
          if (
            detail.value.runs.find((run) => run.id === accepted.value.runId)?.status === 'completed'
          )
            break
          if (Date.now() > deadline) throw new Error('分页记录生成超时')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
    })
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '分页-0', exact: true })
      .click()
    const messages = page.getByLabel('消息记录', { exact: true })
    await expect(messages.getByText('分页-1', { exact: true })).toBeVisible()
    await expect(messages.getByText('分页-0', { exact: true })).not.toBeVisible()
    await page.getByRole('button', { name: '更早的消息', exact: true }).click()
    await expect(messages.getByText('分页-0', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click()
    await expect(messages.getByText('分页-25', { exact: true })).toBeInViewport()
    await expect(messages.getByText('分页-0', { exact: true })).not.toBeVisible()
  })

  test('自有服务异常退出后保留部分回答，不重发请求，重启可读取中断状态', async ({
    desktop,
    profile,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('等待服务中断')
    await input.press('Enter')
    await expect(page.getByText('仅属于等待服务中断的内容', { exact: true })).toBeVisible()
    const conversationId = await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok || !overview.value.conversations[0]) throw new Error('会话不存在')
      return overview.value.conversations[0].id
    })
    const main = await desktop.evaluate(({ app }) => ({
      pid: process.pid,
      profile: app.getPath('userData'),
    }))
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,command='])
    const child = stdout
      .split('\n')
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
      .find(
        (match) =>
          match?.[2] === String(main.pid) &&
          match[3] === `${backendExecutable} --data-dir ${join(main.profile, 'backend')}`,
      )
    if (!child?.[1]) throw new Error('未定位到本次测试独占的服务子进程')
    process.kill(Number(child[1]), 'SIGKILL')
    await expect(page.getByRole('alert')).toContainText('连接已中断')
    await expect(page.getByRole('group', { name: '执行状态', exact: true })).toHaveText(
      '连接已断开',
    )
    await expect(page.getByRole('button', { name: '重试加载', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '重试加载', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试加载', exact: true })).toBeVisible()
    await expect(page.getByText('仅属于等待服务中断的内容', { exact: true })).toBeVisible()
    await expect(input).toBeDisabled()
    expect(
      modelEndpoint?.requests.filter(
        (request) => request.stream && request.text === '等待服务中断',
      ),
    ).toHaveLength(1)
    await desktop.close()
    const recovered = new ChatService(join(profile, 'backend'), resourceRoot)
    try {
      const detail = await recovered.detail(conversationId)
      expect(detail.runs.at(-1)?.status).toBe('interrupted')
      expect(detail.messages).toHaveLength(2)
    } finally {
      await recovered.close()
    }
  })
})

async function chooseTestDirectory(
  desktop: ElectronApplication,
  path: string | string[] | null,
): Promise<void> {
  // 仅替代操作系统选择器；返回值仍经过生产 IPC、路径检查和真实 Go 服务。
  await desktop.evaluate(({ dialog }, path) => {
    Reflect.set(
      dialog,
      'showOpenDialog',
      async (_parent: unknown, options: { properties?: string[] }) => {
        if (options.properties?.join() !== 'openDirectory,multiSelections')
          throw new Error('选择器未限制为可多选的文件夹')
        return { canceled: path === null, filePaths: path === null ? [] : [path].flat() }
      },
    )
  }, path)
}
async function addTestWorkspace(
  desktop: ElectronApplication,
  page: Page,
  path: string,
  name: string,
): Promise<void> {
  await chooseTestDirectory(desktop, path)
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建项目', exact: true })
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill(name)
  await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('region', { name, exact: true })).toBeVisible()
}

test.describe('会话与项目管理', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('输入区可搜索和新建项目，最近入口与项目选择保留隔离草稿并在发送时绑定', async ({
    desktop,
    profile,
  }) => {
    const firstFolder = join(profile, 'composer-existing-project')
    const newFolder = join(profile, 'composer-new-project')
    await mkdir(firstFolder)
    await mkdir(newFolder)
    const page = await desktop.firstWindow()
    await addTestWorkspace(desktop, page, firstFolder, '输入区项目')
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const trigger = page.getByRole('button', { name: '选择项目', exact: true })
    const picker = page.getByRole('dialog', { name: '选择项目', exact: true })
    await expect(trigger).toHaveText('输入区项目')
    await input.fill('项目草稿')
    await page.getByRole('button', { name: '最近中新建对话', exact: true }).click()
    await expect(trigger).toHaveText('选择项目')
    await input.fill('独立草稿')
    await trigger.click()
    const search = picker.getByRole('combobox', { name: '搜索项目', exact: true })
    await expect(search).toBeFocused()
    await search.fill('没有这个项目')
    await expect(picker.getByText('没有匹配的项目', { exact: true })).toBeVisible()
    await search.fill('输入区')
    await search.press('ArrowDown')
    await search.press('Enter')
    await expect(picker).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveText('输入区项目')
    await expect(input).toHaveValue('项目草稿')
    await trigger.click()
    await picker.getByRole('option', { name: '不选择项目', exact: true }).click()
    await expect(input).toHaveValue('独立草稿')
    const before = await page.evaluate(() => window.callum.getChatOverview(0))
    expect(before.ok && before.value.conversations).toHaveLength(0)

    await trigger.click()
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await picker.getByRole('button', { name: '新建项目', exact: true }).click()
    const creation = page.getByRole('dialog', { name: '创建项目', exact: true })
    await expect(creation).toBeVisible()
    await creation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(trigger).toBeFocused()
    await expect(input).toHaveValue('独立草稿')
    await trigger.click()
    await picker.getByRole('button', { name: '新建项目', exact: true }).click()
    await chooseTestDirectory(desktop, newFolder)
    await creation.getByRole('textbox', { name: '项目名称', exact: true }).fill('输入区新项目')
    await creation.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await creation.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(creation).toHaveCount(0)
    await expect(trigger).toHaveText('输入区新项目')
    await input.fill('从输入区绑定项目')
    await input.press('Enter')
    const project = page.getByRole('region', { name: '输入区新项目', exact: true })
    await expect(
      project.getByRole('button', { name: '从输入区绑定项目', exact: true }),
    ).toBeVisible()
    await expect(page.getByLabel('对话项目', { exact: true })).toHaveCount(0)
    await expect(trigger).toHaveCount(0)
    const details = await page.evaluate(async () => {
      const projects = await window.callum.listWorkspaces(0)
      if (!projects.ok) throw new Error(projects.error)
      const project = projects.value.workspaces.find((item) => item.name === '输入区新项目')
      if (!project) throw new Error('项目未创建')
      const conversations = await window.callum.getWorkspaceConversations(project.id, 0)
      if (!conversations.ok) throw new Error(conversations.error)
      return { projectId: project.id, items: conversations.value.conversations }
    })
    expect(details.items).toEqual([
      expect.objectContaining({ title: '从输入区绑定项目', workspaceId: details.projectId }),
    ])
    await page.reload()
    await project.getByRole('button', { name: '输入区新项目', exact: true }).click()
    await project.getByRole('button', { name: '从输入区绑定项目', exact: true }).click()
    await expect(input).toBeEnabled()
    await expect(page.getByLabel('对话项目', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '最近中新建对话', exact: true }).click()
    await expect(page.getByLabel('对话项目', { exact: true })).toBeVisible()
    await expect(trigger).toHaveText('选择项目')
  })

  test('文件夹侧栏支持空项目、键盘新建、缩进会话与独立最近列表', async ({ desktop, profile }) => {
    const folder = join(profile, 'sidebar-project')
    await mkdir(folder)
    const page = await desktop.firstWindow()
    await addTestWorkspace(desktop, page, folder, '空项目')
    const project = page.getByRole('region', { name: '空项目', exact: true })
    const row = project.getByRole('button', { name: '空项目', exact: true })
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await expect(row).toHaveCSS('font-size', '13px')
    await expect(project.getByText('暂无聊天', { exact: true })).toBeVisible()
    const create = project.getByRole('button', { name: '在空项目中新建对话', exact: true })
    await create.focus()
    await expect(create).toHaveCSS('opacity', '1')
    await create.press('Enter')
    await expect(page.getByText('在 空项目 中开始对话。', { exact: true })).toBeVisible()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('项目聊天')
    await input.press('Enter')
    await expect(project.getByRole('button', { name: '项目聊天', exact: true })).toBeVisible()
    await expect(
      project.getByRole('button', { name: '项目聊天', exact: true }).locator('svg'),
    ).toHaveCount(0)
    const recent = page.getByRole('region', { name: '最近', exact: true })
    await expect(recent.getByRole('button', { name: '项目聊天', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('独立聊天')
    await input.press('Enter')
    const independent = recent.getByRole('button', { name: '独立聊天', exact: true })
    await expect(independent).toBeVisible()
    await expect(independent).toHaveCSS('font-size', '13px')
    await expect(independent.locator('svg')).toHaveCount(0)

    const projects = page.getByRole('button', { name: '项目', exact: true })
    const recentToggle = recent.getByRole('button', { name: '最近', exact: true })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const resize = await projects.evaluate(async (button: HTMLButtonElement) => {
      const panel = document.getElementById(button.getAttribute('aria-controls') ?? '')
      if (!panel) throw new Error('缺少项目列表')
      const fullHeight = panel.getBoundingClientRect().height
      button.click()
      await Promise.resolve()
      const transition = panel
        .getAnimations()
        .find(
          (item) =>
            item instanceof CSSTransition && item.transitionProperty === 'grid-template-rows',
        )
      if (!transition?.effect) throw new Error('项目列表没有高度过渡')
      transition.currentTime = Number(transition.effect.getTiming().duration) / 2
      const midHeight = panel.getBoundingClientRect().height
      const inert = panel.inert
      button.click()
      await Promise.resolve()
      return { fullHeight, midHeight, inert, reversedHeight: panel.getBoundingClientRect().height }
    })
    expect(resize.midHeight).toBeGreaterThan(0)
    expect(resize.midHeight).toBeLessThan(resize.fullHeight)
    expect(Math.abs(resize.reversedHeight - resize.midHeight)).toBeLessThan(2)
    expect(resize.inert).toBe(true)
    await expect(projects).toHaveAttribute('aria-expanded', 'true')
    await expect(row).toHaveAttribute('aria-expanded', 'true')

    await projects.press('Space')
    await expect(projects).toHaveAttribute('aria-expanded', 'false')
    await expect(project).toHaveCount(0)
    await expect(independent).toBeVisible()
    await expect(projects).toBeFocused()
    await projects.press('Space')
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    const projectChat = project.getByRole('button', { name: '项目聊天', exact: true })
    await expect(projectChat).toBeVisible()
    await row.click()
    await expect(projectChat).toHaveCount(0)
    await row.click()
    await expect(projectChat).toBeVisible()

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await recentToggle.press('Enter')
    await expect(recentToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#recent-conversations')).toHaveCSS('transition-duration', '0s')
    await expect(independent).toHaveCount(0)
    await expect(projectChat).toBeVisible()
    await recentToggle.press('Enter')
    await expect(independent).toBeVisible()
  })

  test('项目与会话悬停卡片展示现有资料，支持操作、键盘和细滚动条', async ({ desktop, profile }) => {
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const folder = join(profile, 'hover-primary'),
      otherFolder = join(profile, 'hover-secondary')
    await Promise.all([mkdir(folder), mkdir(otherFolder)])
    await chooseTestDirectory(desktop, [folder, otherFolder])
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    const create = page.getByRole('dialog', { name: '创建项目', exact: true })
    await create.getByRole('textbox', { name: '项目名称', exact: true }).fill('悬停项目')
    await create.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await create.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(create).toHaveCount(0)
    const project = page.getByRole('region', { name: '悬停项目', exact: true })
    const row = project.getByRole('button', { name: '悬停项目', exact: true })
    const preview = page.getByRole('dialog', { name: '项目预览', exact: true })
    await row.hover()
    await expect(preview).toBeVisible()
    await expect(preview).toContainText(await realpath(folder))
    await expect(preview).toContainText(await realpath(otherFolder))
    await expect(preview).not.toContainText('次聊天')
    const rowBounds = (await row.boundingBox())!,
      previewBounds = (await preview.boundingBox())!
    expect(previewBounds.x).toBeGreaterThan(rowBounds.x + rowBounds.width)
    await preview.hover()
    await preview.getByRole('button', { name: '置顶项目', exact: true }).click()
    await expect(
      preview.getByRole('button', { name: '取消项目置顶', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: '.artifacts/screenshots/project-hover-light.png' })
    await preview.getByRole('button', { name: '编辑项目', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '编辑项目', exact: true })
    await expect(edit.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
      '悬停项目',
    )
    await expect(preview).toHaveCount(0)
    await edit.getByRole('button', { name: '取消', exact: true }).click()
    await expect(row).toBeFocused()
    await row.press('ArrowRight')
    await expect(preview.getByRole('button', { name: '取消项目置顶', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(preview.getByRole('button', { name: '编辑项目', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    await expect(preview).toHaveCount(0)

    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('项目悬停会话')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    const chat = project.getByRole('button', { name: '项目悬停会话', exact: true })
    const chatPreview = page.getByRole('dialog', { name: '会话预览', exact: true })
    await chat.hover()
    await expect(chatPreview).toContainText('项目悬停会话')
    await expect(chatPreview).toContainText('悬停项目')
    await expect(chatPreview.locator('time')).toHaveText('刚刚')
    await expect(chatPreview.getByRole('button')).toHaveCount(0)
    await chat.click({ button: 'right' })
    await expect(chatPreview).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('独立悬停会话')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    const independent = page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '独立悬停会话', exact: true })
    await independent.hover()
    await expect(chatPreview).toContainText('独立悬停会话')
    await expect(chatPreview).not.toContainText('悬停项目')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await independent.hover()
    await expect(chatPreview).toBeVisible()
    await expect(chatPreview).toHaveCSS('background-color', 'rgb(31, 32, 39)')
    const smallCard = (await chatPreview.boundingBox())!
    const windowWidth = await page.evaluate(() => innerWidth)
    expect(smallCard.x).toBeGreaterThanOrEqual(0)
    expect(smallCard.x + smallCard.width).toBeLessThanOrEqual(windowWidth)
    await page.screenshot({ path: '.artifacts/screenshots/conversation-hover-dark.png' })
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await independent.hover()
    await expect(chatPreview).toContainText('独立悬停会话')
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()

    await page.evaluate(async () => {
      for (let index = 0; index < 12; index++) {
        const result = await window.callum.createWorkspace(
          { name: `滚动项目 ${index}`, rootPath: '' },
          '00000000-0000-7000-8000-000000000001',
        )
        if (!result.ok) throw new Error(result.error)
      }
    })
    const empty = page
      .getByRole('region', { name: '滚动项目 11', exact: true })
      .getByRole('button', { name: '滚动项目 11', exact: true })
    await empty.hover()
    await expect(preview).toContainText('未添加文件夹')
    const scroller = page.locator('[data-sidebar-scroll]')
    await scroller.hover()
    await page.mouse.wheel(0, 300)
    await expect(preview).toHaveCount(0)
    await expect(scroller).toHaveAttribute('data-scrolling', '')
    expect(
      await scroller.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').width),
    ).toBe('6px')
    await expect(scroller).not.toHaveAttribute('data-scrolling')
    await expect
      .poll(() =>
        scroller.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--sidebar-scrollbar-thumb').trim(),
        ),
      )
      .toBe('rgba(0, 0, 0, 0)')
    expect(errors).toEqual([])
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })

  test('无目录项目可持续添加、移除源文件夹，取消和并发冲突保留原设置及对话', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const a = join(profile, 'source-a'),
      b = join(profile, 'source-b'),
      c = join(profile, 'source-c')
    await Promise.all([mkdir(a), mkdir(b), mkdir(c)])
    await writeFile(join(a, 'kept.txt'), 'kept-directory-file', { mode: 0o600 })
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    const create = page.getByRole('dialog', { name: '创建项目', exact: true })
    await create.getByRole('textbox', { name: '项目名称', exact: true }).fill('持续管理的项目')
    await expect(create.getByRole('button', { name: '创建项目', exact: true })).toBeEnabled()
    await create.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(create).toHaveCount(0)
    const initial = await page.evaluate(() => window.callum.listWorkspaces(0))
    if (!initial.ok || !initial.value.workspaces[0]) throw new Error('无目录项目创建失败')
    const projectId = initial.value.workspaces[0].id
    expect(initial.value.workspaces[0].rootPath).toBe('')
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('无目录也保留的对话')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    const project = page.getByRole('button', { name: '持续管理的项目', exact: true })
    await project.dblclick()
    const edit = page.getByRole('dialog', { name: '编辑项目', exact: true })
    const folders = edit.getByRole('listitem')
    await expect(folders).toHaveCount(0)
    await chooseTestDirectory(desktop, [a, b])
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await expect(folders).toHaveCount(2)
    await edit.getByRole('button', { name: '取消', exact: true }).click()
    await project.dblclick()
    await expect(folders).toHaveCount(0)
    await chooseTestDirectory(desktop, [a, b])
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await chooseTestDirectory(desktop, a)
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await expect(folders).toHaveCount(2)
    await edit.getByRole('button', { name: '将 source-b 设为主要', exact: true }).click()
    await expect(folders.first()).toContainText('source-b')
    await edit.getByRole('button', { name: '移除 source-a', exact: true }).click()
    await chooseTestDirectory(desktop, c)
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await chooseTestDirectory(desktop, null)
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await expect(folders).toHaveCount(2)
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toHaveCount(0)
    const canonicalA = await realpath(a),
      canonicalB = await realpath(b),
      canonicalC = await realpath(c)
    const saved = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(saved.ok && saved.value.workspaces[0]).toMatchObject({
      id: projectId,
      rootPath: canonicalB,
      otherPaths: [canonicalC],
    })
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      '无目录也保留的对话',
    )
    await page.reload()
    await project.dblclick()
    await expect(folders.first()).toContainText('source-b')
    await expect(folders).toHaveCount(2)
    const forged = await page.evaluate(
      ({ id, a, b, c }) =>
        window.callum.updateWorkspace(
          id,
          {
            name: '伪造目录',
            rootPath: a,
            otherPaths: [c],
            expectedFolders: [b, c],
          },
          crypto.randomUUID(),
        ),
      { id: projectId, a: canonicalA, b: canonicalB, c: canonicalC },
    )
    expect(forged.ok).toBe(false)
    await chooseTestDirectory(desktop, a)
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    const concurrent = await page.evaluate(
      ({ id, b, c }) =>
        window.callum.updateWorkspace(id, {
          name: '持续管理的项目',
          rootPath: b,
          otherPaths: [],
          expectedFolders: [b, c],
        }),
      { id: projectId, b: canonicalB, c: canonicalC },
    )
    expect(concurrent.ok).toBe(true)
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit.getByRole('alert')).toContainText('文件夹已更新')
    await expect(folders).toHaveCount(3)
    await edit.getByRole('button', { name: '取消', exact: true }).click()
    await project.dblclick()
    await expect(folders).toHaveCount(1)
    await edit.getByRole('button', { name: '移除 source-b', exact: true }).click()
    await expect(folders).toHaveCount(0)
    await expect(edit.getByRole('button', { name: '添加文件夹', exact: true })).toBeFocused()
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toHaveCount(0)
    const empty = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(empty.ok && empty.value.workspaces[0]).toMatchObject({
      id: projectId,
      rootPath: '',
      otherPaths: [],
    })
    await project.dblclick()
    await chooseTestDirectory(desktop, a)
    await edit.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toHaveCount(0)
    const attached = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(attached.ok && attached.value.workspaces[0]).toMatchObject({
      id: projectId,
      rootPath: canonicalA,
      otherPaths: [],
    })
    expect(await readFile(join(a, 'kept.txt'), 'utf8')).toBe('kept-directory-file')
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    await create.getByRole('textbox', { name: '项目名称', exact: true }).fill('第二个无目录项目')
    await create.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(create).toHaveCount(0)
    await expect(project).toBeVisible()
    await expect(page.getByRole('button', { name: '第二个无目录项目', exact: true })).toBeVisible()
  })

  test('编辑目录上限包含已有目录，超额选择撤销后可以重试', async ({ desktop, profile }) => {
    const page = await desktop.firstWindow()
    const root = join(profile, 'limit-root')
    const additions = Array.from({ length: 16 }, (_, index) => join(profile, `additional-${index}`))
    await Promise.all([mkdir(root), ...additions.map((path) => mkdir(path))])
    await addTestWorkspace(desktop, page, root, '目录上限项目')
    await page.getByRole('button', { name: '目录上限项目', exact: true }).dblclick()
    const edit = page.getByRole('dialog', { name: '编辑项目', exact: true })
    const add = edit.getByRole('button', { name: '添加文件夹', exact: true })
    await chooseTestDirectory(desktop, additions)
    await add.click()
    await expect(edit.getByRole('alert')).toContainText('最多可添加 16')
    await expect(edit.getByRole('listitem')).toHaveCount(1)
    await chooseTestDirectory(desktop, additions.slice(0, 15))
    await add.click()
    await expect(edit.getByRole('listitem')).toHaveCount(16)
    await expect(add).toBeDisabled()
    await edit.getByRole('button', { name: '移除 additional-0', exact: true }).click()
    await expect(add).toBeEnabled()
    await chooseTestDirectory(desktop, additions[0] ?? null)
    await add.click()
    await expect(edit.getByRole('listitem')).toHaveCount(16)
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toHaveCount(0)
    const rows = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(rows.ok && rows.value.workspaces[0]?.otherPaths).toHaveLength(15)
  })

  test('创建与编辑项目可切换主要目录并置顶，取消保留设置，活动执行拒绝切换', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const firstFolder = join(profile, `first-folder-${'long-name-'.repeat(12)}`),
      secondFolder = join(profile, 'second-folder'),
      removedFolder = join(profile, 'removed-folder')
    await mkdir(firstFolder)
    await mkdir(secondFolder)
    await mkdir(removedFolder)
    await chooseTestDirectory(desktop, null)
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '创建项目', exact: true })
    const name = dialog.getByRole('textbox', { name: '项目名称', exact: true })
    await expect(name).toBeFocused()
    await expect(dialog.getByRole('button', { name: '创建项目', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '添加文件夹', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('listitem')).toHaveCount(0)
    await page.screenshot({
      path: '.artifacts/screenshots/create-project-empty.png',
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    const before = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(before.ok && before.value.workspaces).toEqual([])
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    await name.fill('自定义项目名称')
    await chooseTestDirectory(desktop, [firstFolder, secondFolder, firstFolder])
    await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await expect(name).toHaveValue('自定义项目名称')
    await expect(dialog.getByTitle(await realpath(firstFolder), { exact: true })).toContainText(
      'first-folder',
    )
    await expect(dialog.getByTitle(await realpath(secondFolder), { exact: true })).toContainText(
      'second-folder',
    )
    await expect(dialog.getByText('其他', { exact: true })).toHaveCount(0)
    const mainDirectory = dialog.getByRole('button', {
      name: '将 second-folder 设为主要',
      exact: true,
    })
    await expect(mainDirectory).toHaveText('设为主要')
    await page.mouse.move(0, 0)
    await name.focus()
    await expect(mainDirectory).toHaveCSS('opacity', '0')
    await dialog.getByTitle(await realpath(secondFolder), { exact: true }).hover()
    await expect(mainDirectory).toHaveCSS('opacity', '1')
    await expect(mainDirectory).toHaveCSS('border-top-width', '1px')
    await expect(mainDirectory).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await dialog.screenshot({
      path: '.artifacts/screenshots/create-project-main-action-hover.png',
      animations: 'disabled',
    })
    await page.mouse.move(0, 0)
    await expect(mainDirectory).toHaveCSS('opacity', '0')
    await mainDirectory.focus()
    await expect(mainDirectory).toHaveCSS('opacity', '1')
    await mainDirectory.press('Enter')
    await expect(dialog.getByRole('listitem').first()).toContainText('second-folder')
    await expect(
      dialog.getByRole('listitem', { name: '主要目录 second-folder', exact: true }),
    ).toBeFocused()
    await expect(
      dialog.getByRole('listitem').filter({ hasText: 'second-folder' }).getByText('主要'),
    ).toBeVisible()
    await chooseTestDirectory(desktop, removedFolder)
    await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await dialog.getByRole('button', { name: '移除 removed-folder', exact: true }).click()
    await expect(dialog.getByTitle(await realpath(removedFolder), { exact: true })).toHaveCount(0)
    await chooseTestDirectory(desktop, null)
    await dialog.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await expect(dialog.getByTitle(await realpath(secondFolder), { exact: true })).toBeVisible()
    await expect(name).toHaveValue('自定义项目名称')
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.mouse.move(0, 0)
    await page.screenshot({
      path: '.artifacts/screenshots/create-project-folders-light.png',
      animations: 'disabled',
    })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({
      path: '.artifacts/screenshots/create-project-folders-dark.png',
      animations: 'disabled',
    })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const result = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(result.ok && result.value.workspaces).toEqual([
      expect.objectContaining({
        name: '自定义项目名称',
        rootPath: await realpath(secondFolder),
        otherPaths: [await realpath(firstFolder)],
      }),
    ])
    const message = page.getByRole('textbox', { name: '消息', exact: true })
    await message.fill('保留主要目录切换前的对话')
    await message.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '自定义项目名称', exact: true }).dblclick()
    const management = page.getByRole('dialog', { name: '编辑项目', exact: true })
    await expect(
      management.getByTitle(await realpath(secondFolder), { exact: true }),
    ).toContainText('second-folder')
    await expect(management.getByTitle(await realpath(firstFolder), { exact: true })).toContainText(
      'first-folder',
    )
    await expect(management.getByText('其他', { exact: true })).toHaveCount(0)
    const folders = management.getByRole('listitem')
    await expect(folders.first()).toContainText('second-folder')
    const secondaryRow = management.getByTitle(await realpath(firstFolder), { exact: true })
    const secondaryAction = secondaryRow.getByRole('button', { name: /^将 .* 设为主要$/ })
    await page.mouse.move(0, 0)
    await expect(secondaryAction).toHaveCSS('opacity', '0')
    await expect(folders.first().getByText('主要', { exact: true })).toBeVisible()
    await secondaryRow.hover()
    await expect(secondaryAction).toHaveCSS('opacity', '1')
    await expect(secondaryAction).toHaveCSS('border-top-width', '1px')
    await expect(secondaryAction).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await management.screenshot({
      path: '.artifacts/screenshots/project-edit-main-action-hover.png',
      animations: 'disabled',
    })
    await secondaryAction.click()
    await expect(folders.first()).toContainText('first-folder')
    await expect(folders.first().getByText('主要', { exact: true })).toBeVisible()
    await expect(folders.first()).toBeFocused()
    await management.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '自定义项目名称', exact: true }).dblclick()
    await expect(folders.first()).toContainText('second-folder')
    const originalRow = management.getByTitle(await realpath(firstFolder), { exact: true })
    const originalFolder = originalRow.getByRole('button', { name: /^将 .* 设为主要$/ })
    await expect(originalFolder).toHaveText('设为主要')
    await page.mouse.move(0, 0)
    await expect(originalFolder).toHaveCSS('opacity', '0')
    await originalFolder.focus()
    await expect(originalFolder).toHaveCSS('opacity', '1')
    await originalFolder.press('Space')
    await expect(folders.first()).toContainText('first-folder')
    await expect(originalRow).toBeFocused()
    await management
      .getByRole('textbox', { name: '项目名称', exact: true })
      .fill('切换主要目录的项目')
    await management.getByRole('button', { name: '保存', exact: true }).click()
    await expect(management).toHaveCount(0)
    const changed = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(changed.ok && changed.value.workspaces).toEqual([
      expect.objectContaining({
        id: result.ok ? result.value.workspaces[0]?.id : '',
        name: '切换主要目录的项目',
        rootPath: await realpath(firstFolder),
        otherPaths: [await realpath(secondFolder)],
      }),
    ])
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      '保留主要目录切换前的对话',
    )
    await page.reload()
    await page.getByRole('button', { name: '切换主要目录的项目', exact: true }).dblclick()
    await expect(folders.first()).toContainText('first-folder')
    await expect(folders.first().getByText('主要', { exact: true })).toBeVisible()
    expect(await management.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.screenshot({
      path: '.artifacts/screenshots/project-edit-folders-light.png',
      animations: 'disabled',
    })

    await chooseTestDirectory(desktop, removedFolder)
    const rejected = await page.evaluate(
      async (unselected) => {
        const selectionId = crypto.randomUUID()
        const selected = await window.callum.chooseWorkspaceDirectories(selectionId)
        if (!selected.ok || !selected.value[0]) throw new Error('测试文件夹选择失败')
        const rootPath = selected.value[0].path
        const input = { name: '伪造其他目录', rootPath, otherPaths: [unselected] }
        const forged = await window.callum.createWorkspace(input, selectionId)
        await window.callum.discardWorkspaceDirectories(selectionId, rootPath)
        const removed = await window.callum.createWorkspace(
          { name: '已移除', rootPath },
          selectionId,
        )
        return [forged.ok, removed.ok]
      },
      await realpath(firstFolder),
    )
    expect(rejected).toEqual([false, false])
    await management.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '在切换主要目录的项目中新建对话', exact: true }).click()
    await message.fill('等待甲')
    await message.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '切换主要目录的项目', exact: true }).dblclick()
    await management
      .getByTitle(await realpath(secondFolder), { exact: true })
      .getByRole('button', { name: /^将 .* 设为主要$/ })
      .click()
    await management.getByRole('textbox', { name: '项目名称', exact: true }).fill('不得保存的名称')
    await management.getByRole('button', { name: '保存', exact: true }).click()
    await expect(management.getByRole('alert')).toContainText('未结束执行')
    await expect(folders.first()).toContainText('second-folder')
    await expect(management.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(
      '不得保存的名称',
    )
    const unchanged = await page.evaluate(() => window.callum.listWorkspaces(0))
    expect(unchanged.ok && unchanged.value.workspaces).toEqual(
      changed.ok ? changed.value.workspaces : [],
    )
    await management.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  })

  test('项目菜单下方展开且明暗不透明，支持键盘置顶、编辑和归档恢复，并保留目录与草稿', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const folder = join(profile, 'menu-project-a'),
      otherFolder = join(profile, 'menu-project-b')
    await mkdir(folder)
    await mkdir(otherFolder)
    await writeFile(join(folder, 'kept.txt'), 'project-data', { mode: 0o600 })
    const name = '菜单项目甲—用于核对长名称和菜单定位'
    await addTestWorkspace(desktop, page, folder, name)
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('项目归档保留的会话')
    await input.press('Enter')
    const project = page.getByRole('region', { name, exact: true, includeHidden: true })
    await expect(
      project.getByRole('button', { name: '项目归档保留的会话', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await input.fill('项目会话恢复后的草稿')
    await addTestWorkspace(desktop, page, otherFolder, '菜单项目乙')
    await input.fill('另一个项目的草稿')
    const trigger = project.getByRole('button', {
      name: `${name}的操作`,
      exact: true,
      includeHidden: true,
    })
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toHaveAttribute('data-side', 'bottom')
    await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(menu).toHaveCSS('width', '160px')
    await expect(menu.getByRole('menuitem').first()).toHaveCSS('font-size', '14px')
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual([
      '置顶',
      '编辑',
      '归档项目',
      '移除项目',
    ])
    const bounds = await menu.boundingBox(),
      anchor = await trigger.boundingBox()
    expect(
      bounds &&
        anchor &&
        Math.abs(bounds.x - anchor.x) <= 1 &&
        bounds.y >= anchor.y + anchor.height,
    ).toBe(true)
    await expect(
      project.getByRole('button', {
        name: `在${name}中新建对话`,
        exact: true,
        includeHidden: true,
      }),
    ).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: '.artifacts/screenshots/project-menu-light.png',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')
    await page.keyboard.press('Home')
    await expect(menu.getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('另一个项目的草稿')
    expect(
      await page.evaluate(async () => {
        const result = await window.callum.listWorkspaces(0)
        return result.ok && result.value.workspaces[0]?.name
      }),
    ).toBe(name)
    await page.reload()
    await page.emulateMedia({ colorScheme: 'dark' })
    await trigger.click()
    await expect(menu.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible()
    await expect(menu).toHaveCSS('background-color', 'rgb(31, 32, 39)')
    await page.screenshot({
      path: '.artifacts/screenshots/project-menu-dark.png',
      animations: 'disabled',
    })
    await menu.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const editing = page.getByRole('dialog', { name: '编辑项目', exact: true })
    await expect(editing).toHaveCSS('background-color', 'rgb(23, 24, 29)')
    await expect(editing.getByRole('textbox', { name: '项目名称', exact: true })).toBeFocused()
    await editing.getByRole('button', { name: '取消', exact: true }).click()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await menu.getByRole('menuitem', { name: '归档项目', exact: true }).click()
    await expect(project).toHaveCount(0)
    expect(await readFile(join(folder, 'kept.txt'), 'utf8')).toBe('project-data')
    const archived = page.getByRole('button', { name: '已归档', exact: true })
    await archived.click()
    await page.getByRole('tab', { name: '项目', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '已归档项目', exact: true })
    await expect(dialog.getByRole('button', { name: `恢复${name}`, exact: true })).toBeVisible()
    await page.screenshot({
      path: '.artifacts/screenshots/archived-projects-dark.png',
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: `恢复${name}`, exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('已恢复项目')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(archived).toBeFocused()
    await project.getByRole('button', { name: '项目归档保留的会话', exact: true }).click()
    // 页面重载只保留服务端数据；重新填写后再次归档，核对本窗口草稿生命周期。
    await input.fill('当前窗口项目草稿')
    await trigger.click()
    await menu.getByRole('menuitem', { name: '归档项目', exact: true }).click()
    await expect(project).toHaveCount(0)
    await archived.click()
    await page.getByRole('tab', { name: '项目', exact: true }).click()
    await dialog.getByRole('button', { name: `恢复${name}`, exact: true }).click()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await project.getByRole('button', { name: '项目归档保留的会话', exact: true }).click()
    await expect(input).toHaveValue('当前窗口项目草稿')
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      '项目归档保留的会话',
    )
    await trigger.click()
    await menu.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
    await trigger.click()
    await menu.getByRole('menuitem', { name: '移除项目', exact: true }).click()
    const deletion = page.getByRole('dialog', { name: '删除项目', exact: true })
    await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(project).toBeVisible()
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })

  test('项目归档拒绝活动执行，置顶与恢复失败保留状态，忙碌和断连禁用修改', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow(),
      folder = join(profile, 'project-errors')
    await mkdir(folder)
    await addTestWorkspace(desktop, page, folder, '错误项目')
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('等待甲')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    const project = page.getByRole('region', { name: '错误项目', exact: true })
    const trigger = project.getByRole('button', { name: '错误项目的操作', exact: true })
    await trigger.click()
    await page.getByRole('menuitem', { name: '归档项目', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(/执行/)
    await expect(project).toBeVisible()
    await trigger.click()
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await desktop.evaluate(({ ipcMain }, channel) => {
      Reflect.set(globalThis, 'projectPinCalls', 0)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        Reflect.set(
          globalThis,
          'projectPinCalls',
          Number(Reflect.get(globalThis, 'projectPinCalls')) + 1,
        )
        return new Promise((resolve) =>
          Reflect.set(globalThis, 'releaseProjectPin', () =>
            resolve({ ok: false, error: '受控项目置顶失败' }),
          ),
        )
      })
    }, IPC_CHANNELS.setWorkspacePinned)
    await trigger.click()
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
    await expect(trigger).toBeDisabled()
    await expect(page.getByRole('button', { name: '添加项目', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'projectPinCalls'))).toBe(1)
    await desktop.evaluate(() => Reflect.get(globalThis, 'releaseProjectPin')())
    await expect(page.getByRole('alert')).toContainText('受控项目置顶失败')
    await trigger.click()
    await expect(page.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: '归档项目', exact: true }).click()
    await expect(project).toHaveCount(0)
    const listed = await page.evaluate(() => window.callum.listArchivedWorkspaces(0))
    await desktop.evaluate(
      ({ ipcMain }, { channel, listed }) => {
        let calls = 0
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () =>
          ++calls === 1 ? { ok: false, error: '受控项目归档读取失败' } : listed,
        )
      },
      { channel: IPC_CHANNELS.listArchivedWorkspaces, listed },
    )
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await page.getByRole('tab', { name: '项目', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '已归档项目', exact: true })
    await expect(dialog.getByRole('alert')).toContainText('受控项目归档读取失败')
    await dialog.getByRole('button', { name: '刷新已归档项目', exact: true }).click()
    await desktop.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => ({ ok: false, error: '受控项目恢复失败' }))
    }, IPC_CHANNELS.setWorkspaceArchived)
    await dialog.getByRole('button', { name: '恢复错误项目', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('受控项目恢复失败')
    await expect(dialog.getByRole('button', { name: '恢复错误项目', exact: true })).toBeEnabled()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(860)
    const bounds = await dialog.boundingBox()
    expect(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 860 &&
        bounds.y + bounds.height <= 620,
    ).toBe(true)
    await page.screenshot({
      path: '.artifacts/screenshots/archived-projects-error-compact.png',
      animations: 'disabled',
    })
    await interruptTestBackend(desktop)
    await expect(dialog.getByRole('button', { name: '恢复错误项目', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('归档项目分页和页签切换丢弃迟到查询，恢复不被旧项目快照和通知撤销', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const invalid = await page.evaluate(async () => ({
      pin: await window.callum.setWorkspacePinned('../../invalid', true),
      flag: await window.callum.setWorkspaceArchived(
        '019a4f39-0000-7000-8000-000000000001',
        'true' as unknown as boolean,
      ),
      page: await window.callum.listArchivedWorkspaces(-1),
    }))
    expect(Object.values(invalid).every((result) => !result.ok)).toBe(true)
    for (const name of ['分页项目甲', '分页项目乙']) {
      const folder = join(profile, name)
      await mkdir(folder)
      await addTestWorkspace(desktop, page, folder, name)
      await page.getByRole('button', { name: `${name}的操作`, exact: true }).click()
      await page.getByRole('menuitem', { name: '归档项目', exact: true }).click()
      await expect(page.getByRole('region', { name, exact: true })).toHaveCount(0)
    }
    const listed = await page.evaluate(() => window.callum.listArchivedWorkspaces(0))
    const active = await page.evaluate(() => window.callum.listWorkspaces(0))
    if (!listed.ok || listed.value.workspaces.length !== 2) throw new Error('项目归档准备失败')
    const first = listed.value.workspaces[0]!,
      second = listed.value.workspaces[1]!
    await desktop.evaluate(
      ({ ipcMain }, { channel, listed }) => {
        let calls = 0
        Reflect.set(globalThis, 'projectArchiveOffsets', [])
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, offset) => {
          Reflect.get(globalThis, 'projectArchiveOffsets').push(offset)
          if (++calls === 1)
            return new Promise((resolve) =>
              Reflect.set(globalThis, 'releaseProjectArchiveList', () => resolve(listed)),
            )
          if (!listed.ok) return listed
          return {
            ok: true,
            value: {
              ...listed.value,
              workspaces: listed.value.workspaces.slice(offset === 0 ? 0 : 1, offset === 0 ? 1 : 2),
              hasMore: offset === 0,
            },
          }
        })
      },
      { channel: IPC_CHANNELS.listArchivedWorkspaces, listed },
    )
    const archived = page.getByRole('button', { name: '已归档', exact: true })
    await archived.click()
    await page.getByRole('tab', { name: '会话', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    const dialog = page.getByRole('dialog', { name: '已归档项目', exact: true })
    await expect(dialog.getByRole('status')).toContainText('正在加载')
    await page.getByRole('tab', { name: '会话', exact: true }).click()
    await desktop.evaluate(() => Reflect.get(globalThis, 'releaseProjectArchiveList')())
    await expect(dialog).toHaveCount(0)
    await expect(
      page
        .getByRole('dialog', { name: '已归档会话', exact: true })
        .getByText('暂无已归档会话', { exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await archived.click()
    await page.getByRole('tab', { name: '项目', exact: true }).click()
    await dialog.getByRole('button', { name: '加载更多项目', exact: true }).click()
    await expect(
      dialog.getByRole('button', { name: `恢复${second.name}`, exact: true }),
    ).toBeVisible()
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'projectArchiveOffsets'))).toEqual([
      0, 0, 50,
    ])
    await desktop.evaluate(
      ({ ipcMain }, { channel, active }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => active)
      },
      { channel: IPC_CHANNELS.listWorkspaces, active },
    )
    await dialog.getByRole('button', { name: `恢复${first.name}`, exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('已恢复项目')
    await expect(
      dialog.getByRole('button', { name: `恢复${first.name}`, exact: true }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: '加载更多项目', exact: true }).click()
    await expect(
      dialog.getByRole('button', { name: `恢复${second.name}`, exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await desktop.evaluate(
      ({ BrowserWindow }, { channel, value, revision }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.send(channel, 0, {
          revision,
          change: { kind: 'workspace', value },
        }),
      { channel: IPC_CHANNELS.chatEvent, value: first, revision: listed.value.revision },
    )
    const restored = page.getByRole('region', { name: first.name, exact: true })
    await expect(restored).toBeVisible()
    await restored.getByRole('button', { name: `在${first.name}中新建对话`, exact: true }).click()
    await expect(page.getByText(`在 ${first.name} 中开始对话。`, { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: second.name, exact: true })).toHaveCount(0)
    // 查询已接受更新后的项目，随后才到达的旧归档通知不能再次隐藏它。
    await desktop.evaluate(
      ({ ipcMain }, { channel, snapshot }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => snapshot)
      },
      {
        channel: IPC_CHANNELS.listWorkspaces,
        snapshot: {
          ok: true,
          value: {
            workspaces: [{ ...first, archivedAt: null, updatedAt: Date.now() }],
            hasMore: false,
            revision: listed.value.revision + 100,
          },
        },
      },
    )
    await page.reload()
    await expect(restored).toBeVisible()
    await desktop.evaluate(
      ({ BrowserWindow }, { channel, value, revision }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.send(channel, 0, {
          revision,
          change: { kind: 'workspace', value },
        }),
      { channel: IPC_CHANNELS.chatEvent, value: first, revision: listed.value.revision + 50 },
    )
    await restored.getByRole('button', { name: `在${first.name}中新建对话`, exact: true }).click()
    await expect(page.getByText(`在 ${first.name} 中开始对话。`, { exact: true })).toBeVisible()
  })

  test('悬停快捷置顶不切换会话，重启保留排序，两类会话归档恢复保留内容和草稿', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const folder = join(profile, 'pin-archive-project')
    await mkdir(folder)
    await addTestWorkspace(desktop, page, folder, '归档项目')
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const project = page.getByRole('region', { name: '归档项目', exact: true })
    const recent = page.getByRole('region', { name: '最近', exact: true })
    await input.fill('项目归档会话')
    await input.press('Enter')
    await expect(project.getByRole('button', { name: '项目归档会话', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    for (const title of ['需要置顶的会话', '较新的会话']) {
      await page.getByRole('button', { name: '新对话', exact: true }).click()
      await input.fill(title)
      await input.press('Enter')
      await expect(recent.getByRole('button', { name: title, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    }
    const older = recent.getByRole('button', { name: '需要置顶的会话', exact: true })
    const pin = recent.getByRole('button', { name: '置顶需要置顶的会话', exact: true })
    const archive = recent.getByRole('button', { name: '归档需要置顶的会话', exact: true })
    await page.mouse.move(0, 0)
    await input.focus()
    await expect(pin).toHaveCSS('opacity', '0')
    await expect(archive).toHaveCSS('opacity', '0')
    await older.hover()
    await expect(pin).toHaveCSS('opacity', '1')
    await expect(archive).toHaveCSS('opacity', '1')
    await expect(pin).toHaveAttribute('title', '置顶聊天')
    await expect(archive).toHaveAttribute('title', '归档聊天')
    await pin.click()
    await expect(
      recent.getByRole('button', { name: '取消置顶需要置顶的会话', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(recent.getByRole('button', { name: '较新的会话', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      await recent
        .locator('button[data-conversation-id]')
        .evaluateAll((buttons) =>
          buttons
            .map((button) => button.textContent?.trim())
            .filter((title) => ['需要置顶的会话', '较新的会话'].includes(title ?? '')),
        ),
    ).toEqual(['需要置顶的会话', '较新的会话'])
    await older.hover()
    await page.screenshot({
      path: '.artifacts/screenshots/conversation-hover-pin-archive.png',
      animations: 'disabled',
    })
    await page.reload()
    await expect(
      recent.getByRole('button', { name: '取消置顶需要置顶的会话', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      await page.evaluate(async () => {
        const result = await window.callum.getChatOverview(0)
        return result.ok && result.value.conversations[0]?.title
      }),
    ).toBe('需要置顶的会话')
    await older.click()
    await expect(input).toBeEnabled()
    await input.fill('归档恢复保留的草稿')
    await archive.click()
    await expect(older).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '开始一段新对话', exact: true })).toBeVisible()
    const archives = page.getByRole('button', { name: '已归档', exact: true })
    await archives.click()
    const dialog = page.getByRole('dialog', { name: '已归档会话', exact: true })
    await expect(
      dialog.getByRole('button', { name: '恢复需要置顶的会话', exact: true }),
    ).toBeVisible()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({
      path: '.artifacts/screenshots/archived-conversations-dark.png',
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '恢复需要置顶的会话', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('已恢复')
    await expect(dialog.getByText('暂无已归档会话', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(archives).toBeFocused()
    await older.click()
    await expect(input).toHaveValue('归档恢复保留的草稿')
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      '需要置顶的会话',
    )
    await older.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click()
    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await project.getByRole('button', { name: '归档项目', exact: true }).click()
    await project.getByRole('button', { name: '置顶项目归档会话', exact: true }).click()
    await project
      .getByRole('button', { name: '项目归档会话', exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: '归档聊天', exact: true }).click()
    await expect(project.getByRole('button', { name: '项目归档会话', exact: true })).toHaveCount(0)
    await page.reload()
    await archives.click()
    await expect(dialog.getByText('归档项目', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '恢复项目归档会话', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await project.getByRole('button', { name: '归档项目', exact: true }).click()
    await expect(
      project.getByRole('button', { name: '取消置顶项目归档会话', exact: true }),
    ).toBeVisible()
    await expect(recent.getByRole('button', { name: '项目归档会话', exact: true })).toHaveCount(0)
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })

  test('归档拒绝活动执行，置顶和恢复失败保留原状态，忙碌禁止重复提交，离线明确报错', async ({
    desktop,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('等待甲')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    const recent = page.getByRole('region', { name: '最近', exact: true })
    const chat = recent.getByRole('button', { name: '等待甲', exact: true })
    await recent.getByRole('button', { name: '置顶等待甲', exact: true }).click()
    const unpin = recent.getByRole('button', { name: '取消置顶等待甲', exact: true })
    await expect(unpin).toHaveAttribute('aria-pressed', 'true')
    await recent.getByRole('button', { name: '归档等待甲', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(/正在执行|未结束执行/)
    await expect(chat).toBeVisible()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await desktop.evaluate(({ ipcMain }, channel) => {
      Reflect.set(globalThis, 'pinCalls', 0)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        Reflect.set(globalThis, 'pinCalls', Number(Reflect.get(globalThis, 'pinCalls')) + 1)
        return new Promise((resolve) =>
          Reflect.set(globalThis, 'releasePin', () =>
            resolve({ ok: false, error: '受控置顶失败' }),
          ),
        )
      })
    }, IPC_CHANNELS.setConversationPinned)
    await unpin.click()
    await expect(unpin).toBeDisabled()
    await expect(recent.getByRole('button', { name: '归档等待甲', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'pinCalls'))).toBe(1)
    await desktop.evaluate(() => Reflect.get(globalThis, 'releasePin')())
    await expect(page.getByRole('alert')).toContainText('受控置顶失败')
    await expect(unpin).toHaveAttribute('aria-pressed', 'true')
    await recent.getByRole('button', { name: '归档等待甲', exact: true }).click()
    await expect(chat).toHaveCount(0)
    const listed = await page.evaluate(() => window.callum.listArchivedConversations(0))
    await desktop.evaluate(
      ({ ipcMain }, { channel, listed }) => {
        let calls = 0
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () =>
          ++calls === 1 ? { ok: false, error: '受控归档读取失败' } : listed,
        )
      },
      { channel: IPC_CHANNELS.listArchivedConversations, listed },
    )
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '已归档会话', exact: true })
    await expect(dialog.getByRole('alert')).toContainText('受控归档读取失败')
    await dialog.getByRole('button', { name: '刷新已归档会话', exact: true }).click()
    const restore = dialog.getByRole('button', { name: '恢复等待甲', exact: true })
    await expect(restore).toBeVisible()
    await desktop.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => ({ ok: false, error: '受控恢复失败' }))
    }, IPC_CHANNELS.setConversationArchived)
    await restore.click()
    await expect(dialog.getByRole('alert')).toContainText('受控恢复失败')
    await expect(restore).toBeEnabled()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    const bounds = await dialog.boundingBox()
    expect(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 860 &&
        bounds.y + bounds.height <= 620,
    ).toBe(true)
    await page.screenshot({
      path: '.artifacts/screenshots/archived-conversations-error-compact.png',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await interruptTestBackend(desktop)
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('连接已中断')
    await expect(dialog.getByRole('button', { name: '刷新已归档会话', exact: true })).toBeDisabled()
  })

  test('已归档列表按需分页，关闭丢弃迟到查询，恢复不被旧快照和旧通知撤销', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const invalid = await page.evaluate(async () => ({
      pin: await window.callum.setConversationPinned('../../invalid', true),
      flag: await window.callum.setConversationArchived(
        '019a4f39-0000-7000-8000-000000000001',
        'true' as unknown as boolean,
      ),
      page: await window.callum.listArchivedConversations(-1),
    }))
    expect(Object.values(invalid).every((result) => !result.ok)).toBe(true)
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    for (const title of ['分页归档甲', '分页归档乙']) {
      await page.getByRole('button', { name: '新对话', exact: true }).click()
      await input.fill(title)
      await input.press('Enter')
      await expect(
        page
          .getByRole('region', { name: '最近', exact: true })
          .getByRole('button', { name: title, exact: true }),
      ).toBeVisible()
      await expect(page.getByRole('article', { name: 'Callum 的回答', exact: true })).toContainText(
        '你好，这是受控回答。',
      )
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: `归档${title}`, exact: true }).click()
      await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0)
    }
    const listed = await page.evaluate(() => window.callum.listArchivedConversations(0))
    const overview = await page.evaluate(() => window.callum.getChatOverview(0))
    if (!listed.ok || listed.value.conversations.length !== 2) throw new Error('归档准备失败')
    const first = listed.value.conversations[0]!,
      second = listed.value.conversations[1]!
    await desktop.evaluate(
      ({ ipcMain }, { channel, listed }) => {
        let calls = 0
        Reflect.set(globalThis, 'archiveOffsets', [])
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, offset) => {
          Reflect.get(globalThis, 'archiveOffsets').push(offset)
          if (++calls === 1)
            return new Promise((resolve) =>
              Reflect.set(globalThis, 'releaseArchiveList', () => resolve(listed)),
            )
          if (!listed.ok) return listed
          return {
            ok: true,
            value: {
              ...listed.value,
              conversations: listed.value.conversations.slice(
                offset === 0 ? 0 : 1,
                offset === 0 ? 1 : 2,
              ),
              hasMore: offset === 0,
            },
          }
        })
      },
      { channel: IPC_CHANNELS.listArchivedConversations, listed },
    )
    const archives = page.getByRole('button', { name: '已归档', exact: true })
    const dialog = page.getByRole('dialog', { name: '已归档会话', exact: true })
    await archives.click()
    await expect(dialog.getByRole('status')).toContainText('正在加载')
    await page.keyboard.press('Escape')
    await desktop.evaluate(() => Reflect.get(globalThis, 'releaseArchiveList')())
    await expect(dialog).toHaveCount(0)
    await archives.click()
    await expect(
      dialog.getByRole('button', { name: `恢复${first.title}`, exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: '加载更多会话', exact: true }).click()
    await expect(
      dialog.getByRole('button', { name: `恢复${second.title}`, exact: true }),
    ).toBeVisible()
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'archiveOffsets'))).toEqual([
      0, 0, 50,
    ])
    await desktop.evaluate(
      ({ ipcMain }, { channel, overview }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => overview)
      },
      { channel: IPC_CHANNELS.getChatOverview, overview },
    )
    await dialog.getByRole('button', { name: `恢复${first.title}`, exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('已恢复')
    await expect(
      dialog.getByRole('button', { name: `恢复${first.title}`, exact: true }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: '加载更多会话', exact: true }).click()
    await expect(
      dialog.getByRole('button', { name: `恢复${second.title}`, exact: true }),
    ).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    const restored = page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: first.title, exact: true })
    await expect(restored).toBeVisible()
    await desktop.evaluate(
      ({ BrowserWindow }, { channel, value, revision }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(channel, 0, {
          revision,
          change: { kind: 'conversation', value },
        })
      },
      { channel: IPC_CHANNELS.chatEvent, value: first, revision: listed.value.revision },
    )
    await restored.click()
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      first.title,
    )
    await expect(restored).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: second.title, exact: true }),
    ).toHaveCount(0)
    if (!overview.ok) throw new Error('会话快照准备失败')
    await desktop.evaluate(
      ({ ipcMain }, { channel, snapshot }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => snapshot)
      },
      {
        channel: IPC_CHANNELS.getChatOverview,
        snapshot: {
          ok: true,
          value: {
            ...overview.value,
            conversations: [{ ...first, archivedAt: null, updatedAt: Date.now() }],
            revision: listed.value.revision + 100,
          },
        },
      },
    )
    await page.reload()
    await expect(restored).toBeVisible()
    await desktop.evaluate(
      ({ BrowserWindow }, { channel, value, revision }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.send(channel, 0, {
          revision,
          change: { kind: 'conversation', value },
        }),
      { channel: IPC_CHANNELS.chatEvent, value: first, revision: listed.value.revision + 50 },
    )
    await restored.click()
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      first.title,
    )
  })

  test('双击项目和两类会话改名，悬停显示操作，取消保留展开状态并恢复焦点', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const folder = join(profile, 'project-with-spaces 项目')
    await mkdir(folder)
    await addTestWorkspace(desktop, page, folder, '双击项目')
    const project = page.getByRole('region', { name: '双击项目', exact: true })
    const projectRow = project.getByRole('button', { name: '双击项目', exact: true })
    const projectMenu = project.getByRole('button', { name: '双击项目的操作', exact: true })
    await page.mouse.move(0, 0)
    await page.getByRole('button', { name: '新对话', exact: true }).focus()
    await expect(projectMenu).toHaveCSS('opacity', '0')
    await projectRow.hover()
    await expect(projectMenu).toHaveCSS('opacity', '1')
    await projectRow.dblclick()
    const edit = page.getByRole('dialog', { name: '编辑项目', exact: true })
    const projectName = edit.getByRole('textbox', { name: '项目名称', exact: true })
    await expect(projectName).toBeFocused()
    expect(
      await projectName.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([0, '双击项目'.length])
    await expect(
      edit
        .getByRole('region', { name: '源文件夹', exact: true })
        .getByTitle(await realpath(folder), { exact: true }),
    ).toContainText('project-with-spaces 项目')
    await expect(edit.getByRole('button', { name: '添加文件夹', exact: true })).toBeEnabled()
    await page.screenshot({
      path: '.artifacts/screenshots/project-edit-light.png',
      animations: 'disabled',
    })
    await projectName.fill('取消的项目名')
    await edit.getByRole('button', { name: '取消', exact: true }).click()
    await expect(projectRow).toBeFocused()
    await expect(projectRow).toHaveAttribute('aria-expanded', 'true')
    await projectRow.click()
    await expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    await projectRow.dblclick()
    await expect(projectName).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(edit).toHaveCount(0)
    await expect(projectRow).toBeFocused()
    await expect(projectRow).toHaveAttribute('aria-expanded', 'false')

    await project.getByRole('button', { name: '在双击项目中新建对话', exact: true }).click()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('项目中的双击会话')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    const projectChat = project.getByRole('button', { name: '项目中的双击会话', exact: true })
    await projectChat.dblclick()
    const rename = page.getByRole('dialog', { name: '重命名会话', exact: true })
    const chatName = rename.getByRole('textbox', { name: '会话标题', exact: true })
    await expect(chatName).toBeFocused()
    expect(
      await chatName.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([0, '项目中的双击会话'.length])
    await page.screenshot({
      path: '.artifacts/screenshots/conversation-rename-light.png',
      animations: 'disabled',
    })
    await chatName.fill('已改名的项目会话')
    await chatName.press('Enter')
    const renamedChat = project.getByRole('button', { name: '已改名的项目会话', exact: true })
    await expect(renamedChat).toBeFocused()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('最近的双击会话')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    const recent = page.getByRole('region', { name: '最近', exact: true })
    const recentChat = recent.getByRole('button', { name: '最近的双击会话', exact: true })
    const menu = page.getByRole('menu')
    await expect(
      recent.getByRole('button', { name: '最近的双击会话的操作', exact: true }),
    ).toHaveCount(0)
    await recentChat.press('Shift+F10')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(recentChat).toBeFocused()
    await recentChat.hover()
    await expect(recentChat.locator('.conversation-title-text')).toHaveCSS('animation-name', 'none')
    await recentChat.dblclick()
    await chatName.fill('没有保存的会话名')
    await page.keyboard.press('Escape')
    await expect(recentChat).toBeFocused()
    await recentChat.press('Shift+F10')
    await menu.getByRole('menuitem', { name: '重命名', exact: true }).press('Enter')
    await expect(chatName).toHaveValue('最近的双击会话')
    const longTitle = '已改名的独立会话，悬停阅读完整标题'
    await chatName.fill(longTitle)
    await rename.getByRole('button', { name: '保存', exact: true }).click()
    const renamedRecent = recent.getByRole('button', { name: longTitle, exact: true })
    await expect(renamedRecent).toBeFocused()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await renamedRecent.hover()
    const titleText = renamedRecent.locator('.conversation-title-text')
    const titleOffset = () =>
      titleText.evaluate(
        (element) =>
          element.getBoundingClientRect().left -
          element.parentElement!.getBoundingClientRect().left,
      )
    await expect.poll(titleOffset).toBeLessThan(-2)
    await expect
      .poll(() =>
        titleText.evaluate(
          (element) =>
            element.getBoundingClientRect().right -
            element.parentElement!.getBoundingClientRect().right,
        ),
      )
      .toBeLessThan(1)
    await expect.poll(titleOffset).toBeCloseTo(0)
    await page.mouse.move(0, 0)
    await expect(titleText).toHaveCSS('animation-name', 'none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await renamedRecent.hover()
    await expect(titleText).toHaveCSS('animation-name', 'none')

    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    await renamedRecent.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(renamedRecent).toBeFocused()
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    await projectRow.dblclick()
    await projectName.fill('已改名的项目')
    await projectName.press('Enter')
    const renamedProject = page.getByRole('region', { name: '已改名的项目', exact: true })
    await expect(renamedProject).toBeVisible()
    await expect(
      renamedProject.getByRole('button', { name: '已改名的项目', exact: true }),
    ).toBeFocused()

    await interruptTestBackend(desktop)
    await expect(renamedRecent).not.toHaveAttribute('aria-haspopup', 'menu')
    await renamedRecent.press('Shift+F10')
    await expect(menu).toHaveCount(0)
    await renamedRecent.dblclick()
    await renamedProject.getByRole('button', { name: '已改名的项目', exact: true }).dblclick()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })

  test('管理项目和会话，保留分组草稿，软删除后重新添加恢复', async ({ desktop, profile }) => {
    const page = await desktop.firstWindow()
    const folder = join(profile, 'project')
    await mkdir(folder)
    await writeFile(join(folder, 'kept.txt'), 'original', { mode: 0o600 })
    await addTestWorkspace(desktop, page, folder, '产品计划')
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const workspace = page.getByRole('region', { name: '产品计划', exact: true })
    await expect(page.getByText('在 产品计划 中开始对话。', { exact: true })).toBeVisible()
    await input.fill('项目草稿')
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(input).toHaveValue('')
    await input.fill('独立草稿')
    await workspace.getByRole('button', { name: '在产品计划中新建对话', exact: true }).click()
    await expect(input).toHaveValue('项目草稿')
    await input.fill('项目提问')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).not.toBeVisible()
    await expect(workspace.getByRole('button', { name: '项目提问', exact: true })).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: '项目提问', exact: true }),
    ).toHaveCount(0)
    await workspace
      .getByRole('button', { name: '项目提问', exact: true })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
    const rename = page.getByRole('dialog', { name: '重命名会话', exact: true })
    await expect(rename.getByRole('textbox', { name: '会话标题', exact: true })).toBeFocused()
    await rename.getByRole('textbox', { name: '会话标题', exact: true }).fill('讨论 <方案> & 计划')
    await rename.getByRole('textbox', { name: '会话标题', exact: true }).press('Enter')
    await expect(
      workspace.getByRole('button', { name: '讨论 <方案> & 计划', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(input).toHaveValue('独立草稿')
    await input.fill('独立提问')
    await input.press('Enter')
    await expect(
      page
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: '独立提问', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '产品计划的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '编辑项目', exact: true })
    await expect(edit.getByTitle(await realpath(folder), { exact: true })).toBeVisible()
    await edit.getByRole('textbox', { name: '项目名称', exact: true }).fill('开发项目')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    const renamedWorkspace = page.getByRole('region', { name: '开发项目', exact: true })
    await expect(renamedWorkspace).toBeVisible()
    await page.screenshot({
      path: '.artifacts/screenshots/workspaces-light.png',
      animations: 'disabled',
    })
    await page.reload()
    await page.getByRole('button', { name: '开发项目', exact: true }).click()
    await renamedWorkspace.getByRole('button', { name: '讨论 <方案> & 计划', exact: true }).click()
    await input.fill('会话草稿')
    await page.getByRole('button', { name: '开发项目的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '移除项目', exact: true }).click()
    const deletion = page.getByRole('dialog', { name: '删除项目', exact: true })
    await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(deletion).not.toBeVisible()
    await expect(renamedWorkspace).toBeVisible()
    await page.getByRole('button', { name: '开发项目的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    await edit.getByRole('textbox', { name: '项目名称', exact: true }).fill('不保存的名称')
    await edit.getByRole('button', { name: '移除本地项目', exact: true }).click()
    await expect(deletion).toBeVisible()
    await expect(deletion.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await expect(deletion.getByText('开发项目', { exact: true })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(deletion).toHaveCount(0)
    await expect(renamedWorkspace).toBeVisible()
    await expect(page.getByRole('button', { name: '开发项目的操作', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '开发项目的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    await edit.getByRole('button', { name: '移除本地项目', exact: true }).click()
    await page
      .getByRole('dialog', { name: '删除项目', exact: true })
      .getByRole('button', { name: '确认删除', exact: true })
      .click()
    await expect(renamedWorkspace).not.toBeVisible()
    await expect(page.getByRole('heading', { name: '开始一段新对话', exact: true })).toBeVisible()
    expect(await readFile(join(folder, 'kept.txt'), 'utf8')).toBe('original')
    await addTestWorkspace(desktop, page, folder, '恢复项目')
    await page
      .getByRole('region', { name: '恢复项目', exact: true })
      .getByRole('button', { name: '讨论 <方案> & 计划', exact: true })
      .click()
    await expect(input).toHaveValue('')
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      '项目提问',
    )
    await expect(
      page
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: '独立提问', exact: true }),
    ).toBeVisible()
  })

  test('执行中拒绝删除，停止后可删除会话；取消选择和重复目录保持原状', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const folder = join(profile, 'project')
    await mkdir(folder)
    await chooseTestDirectory(desktop, null)
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    const cancelledCreation = page.getByRole('dialog', { name: '创建项目', exact: true })
    await cancelledCreation.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await expect(
      cancelledCreation.getByRole('button', { name: '创建项目', exact: true }),
    ).toBeDisabled()
    await cancelledCreation.getByRole('button', { name: '取消', exact: true }).click()
    await addTestWorkspace(desktop, page, folder, '运行项目')
    await chooseTestDirectory(desktop, folder)
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    const addition = page.getByRole('dialog', { name: '创建项目', exact: true })
    await addition.getByRole('button', { name: '添加文件夹', exact: true }).click()
    await addition.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(addition.getByRole('alert')).toBeVisible()
    await addition.getByRole('button', { name: '取消', exact: true }).click()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('等待甲')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '运行项目的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '移除项目', exact: true }).click()
    let deletion = page.getByRole('dialog', { name: '删除项目', exact: true })
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(deletion.getByRole('alert')).toContainText('未结束执行')
    await deletion.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '等待甲', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()
    deletion = page.getByRole('dialog', { name: '删除会话', exact: true })
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(deletion.getByRole('alert')).toBeVisible()
    await deletion.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    await input.fill('将清除的草稿')
    await page.getByRole('button', { name: '等待甲', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()
    await page
      .getByRole('dialog', { name: '删除会话', exact: true })
      .getByRole('button', { name: '确认删除', exact: true })
      .click()
    await expect(page.getByRole('button', { name: '等待甲', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '开始一段新对话', exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: '运行项目', exact: true }).click()
    await expect(page.getByRole('button', { name: '等待甲', exact: true })).toHaveCount(0)
    await expect(
      page
        .getByRole('region', { name: '运行项目', exact: true })
        .getByRole('button', { name: '在运行项目中新建对话', exact: true }),
    ).toBeVisible()
  })

  test('删除与切换后丢弃迟到的详情和项目列表', async ({ desktop, profile }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    for (const text of ['会话甲', '会话乙']) {
      await page.getByRole('button', { name: '新对话', exact: true }).click()
      await input.fill(text)
      await input.press('Enter')
      await expect(page.getByRole('article', { name: 'Callum 的回答', exact: true })).toContainText(
        '你好，这是受控回答。',
      )
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    }
    const snapshots = await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok) throw new Error(overview.error)
      return Promise.all(
        overview.value.conversations.map(async (item) => ({
          id: item.id,
          title: item.title,
          result: await window.callum.getConversation(item.id),
        })),
      )
    })
    const first = snapshots.find((item) => item.title === '会话甲')!
    await desktop.evaluate(
      ({ ipcMain }, { snapshots, firstId, channel }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, id: string) => {
          const result = snapshots.find((item) => item.id === id)?.result
          if (id !== firstId) return result
          return new Promise((resolve) =>
            Reflect.set(globalThis, 'releaseConversationDetail', () => resolve(result)),
          )
        })
      },
      { snapshots, firstId: first.id, channel: IPC_CHANNELS.getConversation },
    )
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '会话甲', exact: true })
      .click()
    await expect(page.getByText('正在加载消息…', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '会话甲', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()
    await page
      .getByRole('dialog', { name: '删除会话', exact: true })
      .getByRole('button', { name: '确认删除', exact: true })
      .click()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '会话乙', exact: true })
      .click()
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'releaseConversationDetail')()
    })
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toContainText(
      '会话乙',
    )
    await expect(page.getByRole('button', { name: '会话甲', exact: true })).toHaveCount(0)
    const folder = join(profile, 'late-project')
    await mkdir(folder)
    await addTestWorkspace(desktop, page, folder, '迟到项目')
    const listed = await page.evaluate(async () => {
      const result = await window.callum.listWorkspaces(0)
      if (!result.ok) throw new Error(result.error)
      return window.callum.getWorkspaceConversations(result.value.workspaces[0]!.id, 0)
    })
    await desktop.evaluate(
      ({ ipcMain }, { channel, result }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(
          channel,
          () =>
            new Promise((resolve) =>
              Reflect.set(globalThis, 'releaseWorkspaceList', () => resolve(result)),
            ),
        )
      },
      { channel: IPC_CHANNELS.getWorkspaceConversations, result: listed },
    )
    await page.getByRole('button', { name: '迟到项目', exact: true }).click()
    await page.getByRole('button', { name: '迟到项目', exact: true }).click()
    await expect(
      page
        .getByRole('region', { name: '迟到项目', exact: true })
        .getByText('正在加载对话…', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '迟到项目的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '移除项目', exact: true }).click()
    await page
      .getByRole('dialog', { name: '删除项目', exact: true })
      .getByRole('button', { name: '确认删除', exact: true })
      .click()
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'releaseWorkspaceList')()
    })
    await expect(page.getByRole('region', { name: '迟到项目', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '开始一段新对话', exact: true })).toBeVisible()
  })

  test('保存失败保留原名和输入，忙碌时阻止重复操作，支持深色与小窗口', async ({
    desktop,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const folder = join(profile, 'project')
    await mkdir(folder)
    await addTestWorkspace(desktop, page, folder, '界面验证项目')
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('radio', { name: '深色', exact: false }).focus()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: '界面验证项目的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true })
    const name = dialog.getByRole('textbox', { name: '项目名称', exact: true })
    await name.fill('输入会保留的名称')
    await desktop.evaluate(({ ipcMain }, channel) => {
      Reflect.set(globalThis, 'workspaceRenameCalls', 0)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        Reflect.set(
          globalThis,
          'workspaceRenameCalls',
          Number(Reflect.get(globalThis, 'workspaceRenameCalls')) + 1,
        )
        return new Promise((resolve) =>
          Reflect.set(globalThis, 'releaseWorkspaceRename', () =>
            resolve({ ok: false, error: '受控保存失败，请重新核对。' }),
          ),
        )
      })
    }, IPC_CHANNELS.updateWorkspace)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '移除本地项目', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'workspaceRenameCalls'))).toBe(1)
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'releaseWorkspaceRename')()
    })
    await expect(dialog.getByRole('alert')).toContainText('受控保存失败')
    await expect(name).toHaveValue('输入会保留的名称')
    await expect(
      page.getByRole('region', { name: '界面验证项目', exact: true, includeHidden: true }),
    ).toBeAttached()
    const bounds = await dialog.boundingBox()
    expect(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 860 &&
        bounds.y + bounds.height <= 620,
    ).toBe(true)
    await page.screenshot({
      path: '.artifacts/screenshots/workspace-edit-dark-compact.png',
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '界面验证项目的操作', exact: true }),
    ).toBeFocused()
    const invalid = await page.evaluate(async () => ({
      identifier: await window.callum.deleteWorkspace('../../invalid'),
      name: await window.callum.renameConversation(
        '019a4f39-0000-7000-8000-000000000001',
        '中'.repeat(342),
      ),
      path: await window.callum.createWorkspace(
        { name: '伪造目录', rootPath: '/arbitrary-path' },
        crypto.randomUUID(),
      ),
      page: await window.callum.listWorkspaces(-1),
    }))
    expect(Object.values(invalid).every((result) => !result.ok)).toBe(true)
  })
})

test.describe('手动压缩上下文', () => {
  async function hoverUsage(page: Page): Promise<void> {
    await page.mouse.move(1, 1)
    await page.getByRole('button', { name: '上下文使用情况', exact: true }).hover()
    await expect(page.locator('[data-context-tooltip]')).toBeVisible()
  }

  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('圆环悬停提示精简、点击不打开窗口，命令候选支持鼠标及键盘压缩', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const ring = page.getByRole('button', { name: '上下文使用情况', exact: true })
    const hint = page.locator('[data-context-tooltip]')
    await expect(input).toBeEnabled()
    await expect(ring).toHaveText('')
    await expect(ring.locator('svg')).toBeVisible()
    await input.fill('/')
    const option = page.getByRole('option', { name: /^压缩/ })
    await expect(option).toHaveAttribute('aria-disabled', 'true')
    await expect(option).toContainText('请先发送消息')
    await hoverUsage(page)
    await expect(input).toBeFocused()
    await expect(hint.locator('[data-context-estimate]')).toBeVisible()
    await expect(hint).toContainText('背景信息窗口：')
    await expect(hint.locator('[data-context-percentage]')).toContainText('已用')
    await expect(hint.locator(':scope > p')).toHaveCount(3)
    await expect(hint.getByRole('button')).toHaveCount(0)
    await expect(hint.locator('dl')).toHaveCount(0)
    await expect(hint).not.toContainText('输出 / 安全预留')
    await expect(hint).not.toContainText('上次调用实际输入')
    await expect
      .poll(async () => option.getAttribute('data-context-percent'))
      .toBe(await ring.getAttribute('data-context-percent'))
    await expect(option.locator('[data-context-ring]')).toHaveAttribute(
      'data-ratio',
      (await ring.locator('[data-context-ring]').getAttribute('data-ratio')) ?? '',
    )
    await page.mouse.move(1, 1)
    await expect(hint).toHaveCount(0)
    await ring.focus()
    await expect(hint).toBeVisible()
    await ring.press('Escape')
    await expect(hint).toHaveCount(0)
    await expect(ring).toBeFocused()
    await ring.click()
    await expect(hint).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('[data-manual-compaction]')).toHaveCount(0)
    await input.fill('正文里的 /compact 保持为普通消息')
    await input.press('Enter')
    await expect(page.getByRole('article', { name: 'Callum 的回答', exact: true })).toContainText(
      '你好，这是受控回答。',
    )
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    await input.fill('/comp')
    await hoverUsage(page)
    await expect(hint.locator('[data-context-estimate]')).toBeVisible()
    await page.screenshot({ path: '.artifacts/screenshots/context-usage-light.png' })
    await page.keyboard.press('Escape')
    await expect(option).toBeVisible()
    await option.click()
    const row = page.locator('[data-manual-compaction]')
    await expect(row).toContainText('暂无可压缩的较早对话')
    await expect(input).toHaveValue('')
    await expect(page.getByRole('article')).toHaveCount(2)
    await input.fill('/co')
    await expect(option).toHaveAttribute('aria-disabled', 'false')
    await expect(option).toContainText('压缩此聊天的上下文（已使用')
    await expect(option).not.toContainText('/compact')
    await expect(option.locator('[data-context-percentage]')).toHaveCount(0)
    await expect(option.locator('svg')).toHaveCount(1)
    const candidateHeight = (await option.boundingBox())?.height
    expect(candidateHeight).toBeLessThanOrEqual(36)
    await page.screenshot({ path: '.artifacts/screenshots/context-commands-light.png' })
    await input.press('Tab')
    await expect(input).toHaveValue('/compact')
    await input.press('ArrowDown')
    await input.press('Enter')
    await expect(row).toHaveCount(2)
    await expect(input).toHaveValue('')
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '正文里的 /compact 保持为普通消息', exact: true })
      .click()
    await expect(row).toHaveCount(2)
    await expect(row.last()).toContainText('暂无可压缩的较早对话')
  })

  test('上下文圆环实时统计草稿和生成内容，统计失败可重试，断连不显示旧百分比', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    const ring = page.getByRole('button', { name: '上下文使用情况', exact: true })
    const popup = page.locator('[data-context-tooltip]')
    await hoverUsage(page)
    const estimate = popup.locator('[data-context-estimate]')
    await expect(estimate).toBeVisible()
    const base = Number(await estimate.getAttribute('data-tokens'))
    const modelCalls = modelEndpoint!.requests.length
    await page.keyboard.press('Escape')
    await input.fill('草稿约束'.repeat(100))
    await hoverUsage(page)
    await expect
      .poll(async () => Number(await estimate.getAttribute('data-tokens')))
      .toBeGreaterThan(base + 700)
    expect(modelEndpoint!.requests.length).toBe(modelCalls)
    await expect(page.getByRole('article')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await input.fill('思考等待')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled()
    await hoverUsage(page)
    await expect(estimate).toBeVisible()
    const streaming = Number(await estimate.getAttribute('data-tokens'))
    modelEndpoint!.appendStream('实时生成内容'.repeat(300))
    await expect
      .poll(async () => Number(await estimate.getAttribute('data-tokens')))
      .toBeGreaterThan(streaming + 2000)
    modelEndpoint!.appendReasoning('新增推理'.repeat(100))
    await expect
      .poll(async () => Number(await estimate.getAttribute('data-tokens')))
      .toBeGreaterThan(streaming + 4000)
    await page.keyboard.press('Escape')
    await input.fill('/c')
    const command = page.getByRole('option', { name: /^压缩/ })
    await expect(command).toHaveAttribute('aria-disabled', 'true')
    const beforeRatio = Number(
      await command.locator('[data-context-ring]').getAttribute('data-ratio'),
    )
    modelEndpoint!.appendStream('候选比例更新'.repeat(100))
    await expect
      .poll(async () =>
        Number(await command.locator('[data-context-ring]').getAttribute('data-ratio')),
      )
      .toBeGreaterThan(beforeRatio)
    await expect
      .poll(async () => command.getAttribute('data-context-percent'))
      .toBe(await ring.getAttribute('data-context-percent'))
    await input.fill('触发统计刷新')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
    const known = await page.evaluate(async () => {
      const state = await window.callum.getChatOverview(0)
      if (!state.ok || !state.value.models[0]) throw new Error('缺少模型')
      return window.callum.getContextUsage({
        conversationId: null,
        workspaceId: null,
        modelId: state.value.models[0].id,
        draft: '',
      })
    })
    if (!known.ok) throw new Error(known.error)
    await desktop.evaluate(
      ({ ipcMain }, { channel, sample }) => {
        let fail = true
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, input) => {
          if (fail) {
            fail = false
            return { ok: false, error: '受控统计读取失败' }
          }
          return {
            ok: true,
            value: {
              ...sample,
              id: input.conversationId ?? '',
              conversationId: input.conversationId,
              state: 'ready',
              estimatedTokens: 1234,
              inputLimit: null,
              contextWindow: null,
              snapshotRevision: 99999999,
            },
          }
        })
      },
      { channel: IPC_CHANNELS.getContextUsage, sample: known.value },
    )
    await input.fill('触发统计刷新')
    await hoverUsage(page)
    await expect(popup).toContainText('受控统计读取失败')
    await page.mouse.move(1, 1)
    await expect(popup).toHaveCount(0)
    await hoverUsage(page)
    await expect(popup).toContainText('未配置上下文容量')
    await expect(ring).toHaveAttribute('data-context-percent', 'unknown')
    await expect(estimate).toContainText('已用约 1k 标记，共 —')
    await page.keyboard.press('Escape')
    await interruptTestBackend(desktop)
    await hoverUsage(page)
    await expect(popup).toContainText('连接已断开')
    await expect(estimate).toHaveCount(0)
    await expect(ring).toHaveAttribute('data-context-percent', 'unknown')
  })

  test('草稿统计丢弃迟到响应，圆环在模型左侧', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    const ring = page.getByRole('button', { name: '上下文使用情况', exact: true })
    const ringBox = await ring.boundingBox()
    const modelBox = await page.getByRole('combobox', { name: '模型', exact: true }).boundingBox()
    expect(ringBox && modelBox && ringBox.x + ringBox.width <= modelBox.x).toBe(true)
    const sample = await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok || !overview.value.models[0]) throw new Error('缺少模型')
      return window.callum.getContextUsage({
        conversationId: null,
        workspaceId: null,
        modelId: overview.value.models[0].id,
        draft: '',
      })
    })
    if (!sample.ok) throw new Error(sample.error)
    await desktop.evaluate(
      ({ ipcMain }, { channel, value }) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, request) => {
          const result = {
            ok: true,
            value: {
              ...value,
              snapshotRevision: 99999999,
              estimatedTokens: request.draft === '迟到草稿' ? 9999 : 4444,
            },
          }
          if (request.draft === '迟到草稿')
            return new Promise((resolve) =>
              Reflect.set(globalThis, 'releaseContextUsage', () => resolve(result)),
            )
          return result
        })
      },
      { channel: IPC_CHANNELS.getContextUsage, value: sample.value },
    )
    await input.fill('迟到草稿')
    await expect
      .poll(() => desktop.evaluate(() => typeof Reflect.get(globalThis, 'releaseContextUsage')))
      .toBe('function')
    await input.fill('最新草稿')
    await desktop.evaluate(() => Reflect.get(globalThis, 'releaseContextUsage')())
    await hoverUsage(page)
    const estimate = page.locator('[data-context-tooltip]').locator('[data-context-estimate]')
    await expect(estimate).toHaveAttribute('data-tokens', '4444')
    await expect(input).toHaveValue('最新草稿')
    await expect(page.getByRole('article')).toHaveCount(0)
  })

  test('手动压缩成功保留消息、草稿和位置，切换与重启后恢复并可继续对话', async ({
    desktop,
    modelEndpoint,
    playwright,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const { conversationId, modelId } = await prepareManualCompaction(page, '手动压缩成功')
    modelEndpoint!.pauseCompaction()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('压缩前保留的草稿')
    await hoverUsage(page)
    const popup = page.locator('[data-context-tooltip]')
    await expect(popup.locator('[data-context-estimate]')).toBeVisible()
    const beforeTokens = Number(
      await popup.locator('[data-context-estimate]').getAttribute('data-tokens'),
    )
    await expect(input).toHaveValue('压缩前保留的草稿')
    await page.keyboard.press('Escape')
    await input.fill('/compact')
    await page.getByRole('option', { name: /^压缩/ }).click()
    const row = page.locator('[data-manual-compaction]')
    await expect(row).toContainText('正在压缩上下文')
    await expect(input).toHaveValue('')
    await expect.poll(() => modelEndpoint!.pendingCompaction).toBe(1)
    await expect(page.getByRole('button', { name: '停止压缩', exact: true })).toBeEnabled()
    await hoverUsage(page)
    await expect(popup.getByRole('button')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await input.fill('/com')
    await expect(page.getByRole('option', { name: /^压缩/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await page.keyboard.press('Escape')
    const duplicate = await page.evaluate((input) => window.callum.compactConversation(input), {
      conversationId,
      modelId,
    })
    expect(duplicate.ok).toBe(false)
    await input.fill('压缩期间保留的草稿')
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('另一个对话的草稿')
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '手动压缩成功', exact: true })
      .click()
    await expect(input).toHaveValue('压缩期间保留的草稿')
    await expect(row).toContainText('正在压缩上下文')
    await expect(row).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: '.artifacts/screenshots/manual-compaction-running.png' })
    modelEndpoint!.finishCompaction()
    await expect(row).toContainText('上下文已压缩')
    await hoverUsage(page)
    await expect
      .poll(async () =>
        Number(await popup.locator('[data-context-estimate]').getAttribute('data-tokens')),
      )
      .toBeLessThan(beforeTokens)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('article')).toHaveCount(12)
    await expect(input).toHaveValue('压缩期间保留的草稿')
    await input.press('Enter')
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toHaveCount(7)
    await expect(
      page.getByRole('article', { name: 'Callum 的回答', exact: true }).last(),
    ).toContainText('你好，这是受控回答。')
    expect(
      await page.locator('[aria-label="消息记录"]').evaluate((element) => {
        const children = [...element.children]
        const index = children.findIndex((child) => child.hasAttribute('data-manual-compaction'))
        return (
          index >= 0 &&
          children.slice(index + 1).filter((child) => child.tagName === 'ARTICLE').length === 2
        )
      }),
    ).toBe(true)
    expect(
      modelEndpoint!.requests.some((request) => request.contextSummary && !request.summaryRequest),
    ).toBe(true)
    await desktop.close()
    const restarted = await playwright._electron.launch({
      args: [projectRoot],
      env: { ...process.env, CALLUM_USER_DATA_DIR: profile, CALLUM_TEST_BACKGROUND: '1' },
    })
    try {
      const restored = await restarted.firstWindow()
      await restored
        .getByRole('region', { name: '最近', exact: true })
        .getByRole('button', { name: '手动压缩成功', exact: true })
        .click()
      await expect(restored.locator('[data-manual-compaction]')).toContainText('上下文已压缩')
      await expect(restored.getByRole('article')).toHaveCount(14)
    } finally {
      await restarted.close()
    }
  })

  test('手动压缩结果读取失败只重试查询，断连保留已确认结果', async ({ desktop, modelEndpoint }) => {
    const page = await desktop.firstWindow()
    const { conversationId } = await prepareManualCompaction(page, '压缩结果查询')
    modelEndpoint!.pauseCompaction()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('/compact')
    await input.press('Enter')
    const row = page.locator('[data-manual-compaction]')
    await expect(row).toContainText('正在压缩上下文')
    const pending = await page.evaluate((id) => window.callum.getConversation(id), conversationId)
    if (!pending.ok) throw new Error(pending.error)
    const run = pending.value.runs.find((item) => item.compaction)
    if (!run?.compaction) throw new Error('缺少独立压缩步骤')
    const detail = await page.evaluate(
      ({ conversationId, runId, stepId }) =>
        window.callum.getStepDetails(conversationId, runId, stepId),
      { conversationId, runId: run.id, stepId: run.compaction.stepId },
    )
    if (!detail.ok) throw new Error(detail.error)
    // 仅模拟展示查询的失败和恢复；压缩执行仍由真实 Go 服务与受控模型完成。
    await desktop.evaluate(
      ({ ipcMain }, { channel, detail }) => {
        let calls = 0
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () =>
          ++calls === 1
            ? { ok: false, error: '受控压缩结果读取失败' }
            : {
                ok: true,
                value: { ...detail, output: '{"compressed":true}', outputTruncated: false },
              },
        )
      },
      { channel: IPC_CHANNELS.getStepDetails, detail: detail.value },
    )
    await expect.poll(() => modelEndpoint!.pendingCompaction).toBe(1)
    modelEndpoint!.finishCompaction()
    await expect(row).toContainText('受控压缩结果读取失败')
    await expect(row).not.toContainText('上下文已压缩')
    await row.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(row).toContainText('上下文已压缩')
    const after = await page.evaluate((id) => window.callum.getConversation(id), conversationId)
    expect(after.ok && after.value.runs.filter((item) => item.compaction).length).toBe(1)
    expect(modelEndpoint!.requests.filter((request) => request.summaryRequest)).toHaveLength(1)
    await interruptTestBackend(desktop)
    await expect(page.getByRole('alert')).toContainText('连接已中断')
    await expect(row).toContainText('上下文已压缩')
    await expect(row.locator('.activity-shimmer')).toHaveCount(0)
  })

  for (const outcome of ['failed', 'cancelled', 'interrupted'] as const) {
    test(`手动压缩 ${outcome} 保留历史并显示真实状态`, async ({
      desktop,
      modelEndpoint,
      playwright,
      profile,
    }) => {
      const page = await desktop.firstWindow()
      const title = `压缩状态 ${outcome}`
      await prepareManualCompaction(page, title)
      modelEndpoint!.pauseCompaction()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      await input.fill('/compact')
      await page.getByRole('option', { name: /^压缩/ }).click()
      const row = page.locator('[data-manual-compaction]')
      await expect(row).toContainText('正在压缩上下文')
      await expect.poll(() => modelEndpoint!.pendingCompaction).toBe(1)
      await input.fill('不丢失的草稿')
      if (outcome === 'failed') {
        modelEndpoint!.finishCompaction(false)
        await expect(row).toContainText('上下文压缩失败')
      } else if (outcome === 'cancelled') {
        await page.getByRole('button', { name: '停止压缩', exact: true }).click()
        await expect(row).toContainText('上下文压缩已取消')
      } else {
        await interruptTestBackend(desktop)
        await expect(row).toContainText('连接已断开')
        await expect(page.getByRole('button', { name: '停止压缩', exact: true })).toBeDisabled()
      }
      await expect(row).not.toContainText('上下文已压缩')
      await expect(row.locator('.activity-shimmer')).toHaveCount(0)
      await expect(page.getByRole('article')).toHaveCount(12)
      await expect(input).toHaveValue('不丢失的草稿')
      if (outcome === 'interrupted') {
        await desktop.close()
        const restarted = await playwright._electron.launch({
          args: [projectRoot],
          env: { ...process.env, CALLUM_USER_DATA_DIR: profile, CALLUM_TEST_BACKGROUND: '1' },
        })
        try {
          const restored = await restarted.firstWindow()
          await restored
            .getByRole('region', { name: '最近', exact: true })
            .getByRole('button', { name: title, exact: true })
            .click()
          await expect(restored.locator('[data-manual-compaction]')).toContainText(
            '上下文压缩已中断',
          )
          await expect(restored.getByRole('article')).toHaveCount(12)
        } finally {
          await restarted.close()
        }
      } else {
        await page.reload()
        await page
          .getByRole('region', { name: '最近', exact: true })
          .getByRole('button', { name: title, exact: true })
          .click()
        await expect(row).toContainText(
          outcome === 'failed' ? '上下文压缩失败' : '上下文压缩已取消',
        )
      }
    })
  }

  test('压缩受理失败保留命令，忙碌不重复提交，迟到失败不污染其他对话草稿', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('新对话原有草稿')
    await prepareManualCompaction(page, '受理失败测试', 1)
    await desktop.evaluate(({ ipcMain }, channel) => {
      Reflect.set(globalThis, 'compactCalls', 0)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        Reflect.set(globalThis, 'compactCalls', Number(Reflect.get(globalThis, 'compactCalls')) + 1)
        return new Promise((resolve) =>
          Reflect.set(globalThis, 'releaseCompact', () =>
            resolve({ ok: false, error: '受控压缩受理失败' }),
          ),
        )
      })
    }, IPC_CHANNELS.compactConversation)
    await input.fill('/compact')
    await input.press('Enter')
    await expect(input).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'compactCalls'))).toBe(1)
    await desktop.evaluate(() => Reflect.get(globalThis, 'releaseCompact')())
    await expect(page.getByRole('alert')).toContainText('受控压缩受理失败')
    await expect(input).toHaveValue('/compact')
    await expect(page.locator('[data-manual-compaction]')).toHaveCount(0)
    await input.focus()
    await input.press('Enter')
    await expect(input).toBeDisabled()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(input).toHaveValue('新对话原有草稿')
    await desktop.evaluate(() => Reflect.get(globalThis, 'releaseCompact')())
    await expect(input).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(input).toHaveValue('新对话原有草稿')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('/')
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620)
    })
    await expect(page.getByRole('option', { name: /^压缩/ })).toBeVisible()
    await page.screenshot({ path: '.artifacts/screenshots/context-commands-dark.png' })
    await hoverUsage(page)
    await expect(page.locator('[data-context-tooltip]')).toBeVisible()
    await expect(
      page.locator('[data-context-tooltip]').locator('[data-context-estimate]'),
    ).toBeVisible()
    await page.screenshot({ path: '.artifacts/screenshots/context-usage-dark.png' })
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
  })
})

test.describe('输入区交互卡片', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('提问卡片保留输入框，收起不会提交，支持选项、文字和跳过', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const card = page.getByRole('region', { name: '补充输入', exact: true })
    for (const mode of ['选项', '文字', '跳过']) {
      await page.getByRole('button', { name: '新对话', exact: true }).click()
      await expect(input).toBeEnabled()
      await input.fill(`提问${mode}`)
      await input.press('Enter')
      await expect(card).toBeVisible()
      await expect(input).toBeVisible()
      await expect(input).toBeDisabled()
      await expect(card).toBeFocused()
      await expect(card.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
      const before = modelEndpoint?.requests.filter((item) => item.lastRole === 'tool').length ?? 0
      await card.press('Enter')
      await card.press('Escape')
      await card.getByRole('button', { name: '收起补充输入', exact: true }).click()
      await expect(card.getByRole('textbox', { name: '自行回复', exact: true })).not.toBeVisible()
      expect(modelEndpoint?.requests.filter((item) => item.lastRole === 'tool')).toHaveLength(
        before,
      )
      await card.getByRole('button', { name: '展开补充输入', exact: true }).click()
      const cardBox = await card.boundingBox(),
        inputBox = await input.boundingBox()
      if (!cardBox || !inputBox) throw new Error('输入卡片不存在')
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(inputBox.y)
      if (mode === '选项') {
        await page.screenshot({
          path: '.artifacts/screenshots/user-input-light.png',
          animations: 'disabled',
        })
        await card.getByRole('radio', { name: '已结束，可以复验', exact: true }).focus()
        await page.keyboard.press('Space')
        await card.getByRole('button', { name: '发送', exact: true }).click()
      } else if (mode === '文字') {
        const reply = card.getByRole('textbox', { name: '自行回复', exact: true })
        await reply.fill('我自己补充的回复')
        await reply.press('Shift+Enter')
        await expect(reply).toHaveValue('我自己补充的回复\n')
        await reply.press('Enter')
      } else await card.getByRole('button', { name: '跳过', exact: true }).click()
      await expect(card).not.toBeVisible()
      await expect(page.getByRole('article', { name: 'Callum 的回答', exact: true })).toContainText(
        mode === '选项'
          ? '已结束，可以复验'
          : mode === '文字'
            ? '我自己补充的回复'
            : '用户已跳过问题。',
      )
      await expect(input).toBeEnabled()
      expect(modelEndpoint?.requests.filter((item) => item.lastRole === 'tool')).toHaveLength(
        before + 1,
      )
    }
  })

  test('提问草稿和收起状态按请求隔离，切换后恢复，取消不影响另一会话', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const card = page.getByRole('region', { name: '补充输入', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('提问甲')
    await input.press('Enter')
    await expect(card).toBeVisible()
    await card.getByRole('textbox', { name: '自行回复', exact: true }).fill('甲自己的回复')
    await card.getByRole('radio', { name: '仍在进行', exact: true }).focus()
    await page.keyboard.press('Space')
    await card.getByRole('button', { name: '收起补充输入', exact: true }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('提问乙')
    await input.press('Enter')
    await expect(card.getByRole('textbox', { name: '自行回复', exact: true })).toHaveValue('')
    await card.getByRole('textbox', { name: '自行回复', exact: true }).fill('乙自己的回复')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '提问甲', exact: true })
      .click()
    await expect(card.getByRole('button', { name: '展开补充输入', exact: true })).toBeVisible()
    await card.getByRole('button', { name: '展开补充输入', exact: true }).click()
    await expect(card.getByRole('textbox', { name: '自行回复', exact: true })).toHaveValue(
      '甲自己的回复',
    )
    await expect(card.getByRole('radio', { name: '仍在进行', exact: true })).toBeChecked()
    await page.screenshot({
      path: '.artifacts/screenshots/user-input-dark-compact.png',
      animations: 'disabled',
    })
    const submit = await card.getByRole('button', { name: '发送', exact: true }).boundingBox()
    expect(submit && submit.y >= 0 && submit.y + submit.height < 620).toBe(true)
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(card).not.toBeVisible()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '提问乙', exact: true })
      .click()
    await expect(card.getByRole('textbox', { name: '自行回复', exact: true })).toHaveValue(
      '乙自己的回复',
    )
    await card.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('article', { name: 'Callum 的回答', exact: true })).toContainText(
      '乙自己的回复',
    )
  })

  test('提问重载恢复，提交失败保留草稿，忙碌和断连阻止重复回复', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const card = page.getByRole('region', { name: '补充输入', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('提问提交')
    await input.press('Enter')
    await expect(card).toBeVisible()
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '提问提交', exact: true })
      .click()
    await expect(card).toBeVisible()
    await card.getByRole('textbox', { name: '自行回复', exact: true }).fill('保留这条回复草稿')
    const question = await card
      .getByText('另一个任务是否已经结束？这会影响接下来的验证。', { exact: true })
      .textContent()
    await desktop.evaluate(({ ipcMain }, channel) => {
      Reflect.set(globalThis, 'inputSubmitAttempts', 0)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        Reflect.set(
          globalThis,
          'inputSubmitAttempts',
          Number(Reflect.get(globalThis, 'inputSubmitAttempts')) + 1,
        )
        return new Promise((resolve) =>
          Reflect.set(globalThis, 'releaseInputSubmit', () =>
            resolve({ ok: false, error: '受控回复提交失败，请核对后再试。' }),
          ),
        )
      })
    }, IPC_CHANNELS.submitUserInput)
    await card.getByRole('button', { name: '发送', exact: true }).click()
    await expect(card.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: '跳过', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(await desktop.evaluate(() => Reflect.get(globalThis, 'inputSubmitAttempts'))).toBe(1)
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'releaseInputSubmit')()
    })
    await expect(card.getByRole('alert')).toContainText('受控回复提交失败')
    await expect(card.getByRole('textbox', { name: '自行回复', exact: true })).toHaveValue(
      '保留这条回复草稿',
    )
    await card.getByRole('button', { name: '重新加载问题', exact: true }).click()
    await expect(card.getByRole('textbox', { name: '自行回复', exact: true })).toHaveValue(
      '保留这条回复草稿',
    )
    await interruptTestBackend(desktop)
    await expect(card.getByRole('alert')).toContainText('连接已中断')
    await expect(card.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: '跳过', exact: true })).toBeDisabled()
    await expect(card.getByText(question ?? '', { exact: true })).toBeVisible()
    expect(modelEndpoint?.requests.filter((item) => item.lastRole === 'tool')).toHaveLength(0)
  })
})

test.describe('模型配置与对话联动', () => {
  test.use({ withEndpoint: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('从空状态配置供应商和模型，编辑后直接对话，支持启停和删除', async ({
    desktop,
    modelEndpoint,
  }) => {
    if (!modelEndpoint) throw new Error('本机受控模型端点不存在')
    const page = await desktop.firstWindow()
    await expect(page.getByRole('button', { name: '配置模型', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toHaveCount(0)
    const invalid = await page.evaluate(() =>
      window.callum.saveModelProvider({
        id: null,
        protocol: 'chatcompletions',
        name: '不应保存',
        baseUrl: 'file:///tmp/file',
        keyMode: 'keep',
      }),
    )
    expect(invalid.ok).toBe(false)
    const unsupported: unknown = await page.evaluate(async () => {
      const result: unknown = await Reflect.apply(window.callum.saveModelProvider, undefined, [
        {
          id: null,
          protocol: 'unsupported',
          name: '不应保存',
          baseUrl: 'https://example.invalid/v1',
          keyMode: 'keep',
        },
      ])
      return result
    })
    expect(unsupported).toEqual({ ok: false, error: '暂不支持所选服务类型' })
    await page.getByRole('button', { name: '配置模型', exact: true }).click()
    await expect(page.getByRole('heading', { name: '模型', level: 2, exact: true })).toBeVisible()
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '添加供应商', exact: true })
    const service = dialog.getByRole('combobox', { name: '服务类型', exact: true })
    await expect(service).toBeFocused()
    await expect(service).toHaveValue('chatcompletions')
    await expect(service.locator('option')).toHaveText(['Chat Completions'])
    await service.selectOption('chatcompletions')
    await page.screenshot({ path: '.artifacts/screenshots/provider-service-type.png' })
    await dialog.getByLabel('供应商名称', { exact: true }).fill('本机模型服务')
    await dialog.getByLabel('API 地址', { exact: true }).fill(modelEndpoint.baseUrl)
    await dialog.getByLabel(/^API Key/).fill('fixture-ui-key')
    await expect(dialog.getByLabel(/^API Key/)).toHaveAttribute('type', 'password')
    await dialog.getByRole('button', { name: '保存供应商', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText('已设置 API Key', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '为 本机模型服务 添加模型', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '添加模型', exact: true })
    await dialog.getByLabel('模型名称', { exact: true }).fill('文本助手')
    await dialog.getByLabel('模型 ID', { exact: true }).fill('local-fixture')
    await dialog.getByLabel('上下文容量（Token）', { exact: true }).fill('1000000')
    await dialog.getByRole('button', { name: '保存模型', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByRole('button', { name: '编辑供应商 本机模型服务', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑供应商', exact: true })
    await expect(dialog.getByRole('combobox', { name: '服务类型', exact: true })).toHaveValue(
      'chatcompletions',
    )
    await expect(dialog.getByLabel(/^API Key/)).toHaveValue('')
    await dialog.getByLabel('供应商名称', { exact: true }).fill('本机服务')
    await dialog.getByRole('button', { name: '保存供应商', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByRole('button', { name: '编辑模型 文本助手', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑模型', exact: true })
    await dialog.getByLabel('模型名称', { exact: true }).fill('我的助手')
    await dialog.getByRole('button', { name: '保存模型', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('switch', { name: '启用模型 我的助手', exact: true })).toBeChecked()
    await expect(
      page.getByRole('button', { name: '删除供应商 本机服务', exact: true }),
    ).toBeDisabled()
    await page.screenshot({ path: '.artifacts/screenshots/model-settings.png' })
    const safe = await page.evaluate(async () => ({
      catalog: await window.callum.getModelCatalog(),
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }))
    expect(JSON.stringify(safe)).not.toContain('fixture-ui-key')
    expect(safe.catalog.ok && safe.catalog.value.providers[0]?.protocol).toBe('chatcompletions')
    expect(await page.locator('body').innerText()).not.toContain('fixture-ui-key')
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '模型', exact: true }).click()
    await expect(page.getByRole('switch', { name: '启用模型 我的助手', exact: true })).toBeChecked()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    const picker = page.getByRole('combobox', { name: '模型', exact: true })
    await expect(picker).toBeEnabled()
    await expect(picker).toHaveText('我的助手')
    const pickerBox = await picker.boundingBox(),
      formBox = await page.locator('form').boundingBox(),
      sendBox = await page.getByRole('button', { name: '发送消息' }).boundingBox()
    if (!pickerBox || !formBox || !sendBox) throw new Error('输入区域不存在')
    expect(pickerBox.x).toBeGreaterThan(formBox.x + formBox.width / 2)
    expect(pickerBox.x + pickerBox.width).toBeLessThan(sendBox.x)
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await input.fill('你好')
    await input.press('Enter')
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
    expect(
      modelEndpoint.requests.some((request) => request.stream && request.expectedAuthorization),
    ).toBe(true)
    await page.screenshot({ path: '.artifacts/screenshots/conversation-model-right.png' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('switch', { name: '启用模型 我的助手', exact: true }).click()
    await expect(
      page.getByRole('switch', { name: '启用模型 我的助手', exact: true }),
    ).not.toBeChecked()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(page.getByRole('button', { name: '配置模型', exact: true })).toBeVisible()
    await expect(input).toBeDisabled()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('switch', { name: '启用模型 我的助手', exact: true }).click()
    await expect(page.getByRole('switch', { name: '启用模型 我的助手', exact: true })).toBeChecked()
    await page.getByRole('button', { name: '删除模型 我的助手', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '删除模型？', exact: true })
    await dialog.getByRole('button', { name: '删除模型', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByRole('button', { name: '删除供应商 本机服务', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '删除供应商？', exact: true })
    await dialog.getByRole('button', { name: '删除供应商', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('heading', { name: '添加你的模型服务', exact: true })).toBeVisible()
    const history = await page.evaluate(() => window.callum.getChatOverview(0))
    expect(history.ok && history.value.conversations.length).toBe(1)
  })

  test('配置校验、重复模型、明确清除密钥及弹窗键盘操作', async ({ desktop, modelEndpoint }) => {
    if (!modelEndpoint) throw new Error('本机端点不存在')
    const page = await desktop.firstWindow()
    await page.getByRole('button', { name: '配置模型', exact: true }).click()
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '添加供应商', exact: true })
    await dialog.getByLabel('供应商名称', { exact: true }).fill('校验服务')
    await dialog.getByLabel('API 地址', { exact: true }).fill('file:///tmp/file')
    await dialog.getByRole('button', { name: '保存供应商', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText(/HTTP/)
    await dialog.getByLabel('API 地址', { exact: true }).fill(modelEndpoint.baseUrl)
    await dialog.getByLabel(/^API Key/).fill('fixture-ui-key')
    await dialog.getByRole('button', { name: '保存供应商', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByRole('button', { name: '编辑供应商 校验服务', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑供应商', exact: true })
    await dialog.getByRole('checkbox', { name: '清除已保存的 API Key', exact: true }).check()
    await dialog.getByRole('button', { name: '保存供应商', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText('未设置 API Key', { exact: true })).toBeVisible()
    const add = page.getByRole('button', { name: '为 校验服务 添加模型', exact: true })
    for (let index = 0; index < 2; index++) {
      await add.click()
      dialog = page.getByRole('dialog', { name: '添加模型', exact: true })
      await dialog.getByLabel('模型名称', { exact: true }).fill('重复校验')
      await dialog.getByLabel('模型 ID', { exact: true }).fill('same-remote-id')
      await dialog.getByLabel('上下文容量（Token）', { exact: true }).fill('1000000')
      await dialog.getByRole('button', { name: '保存模型', exact: true }).click()
      if (index === 0) await expect(dialog).not.toBeVisible()
      else {
        await expect(dialog.getByRole('alert')).toContainText(/存在|重复/)
        await page.keyboard.press('Escape')
        await expect(dialog).not.toBeVisible()
        await expect(add).toBeFocused()
      }
    }
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await page.getByRole('button', { name: '编辑供应商 校验服务', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑供应商', exact: true })
    await expect(dialog.getByRole('combobox', { name: '服务类型', exact: true })).toHaveValue(
      'chatcompletions',
    )
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.screenshot({ path: '.artifacts/screenshots/provider-editor-compact.png' })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '编辑模型 重复校验', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑模型', exact: true })
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.screenshot({ path: '.artifacts/screenshots/model-editor-compact.png' })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await page.getByRole('button', { name: '模型', exact: true }).click()
    await expect(page.getByRole('switch', { name: '启用模型 重复校验', exact: true })).toBeVisible()
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await page.screenshot({ path: '.artifacts/screenshots/model-settings-dark.png' })
  })
})

test.describe('Markdown 回答展示', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  for (const renderDelay of [0, 80])
    test(`持续分片和慢排版仍持续更新，复用稳定节点且不抢回阅读位置（${renderDelay}ms）`, async ({
      desktop,
      modelEndpoint,
    }) => {
      if (!modelEndpoint) throw new Error('受控端点不存在')
      const page = await desktop.firstWindow()
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate((delay) => {
        if (delay === 0) return
        // 每次解析额外等待 80ms，稳定复现分片快于排版时结果被不断作废的问题。
        const OriginalWorker = window.Worker
        class DelayedWorker extends OriginalWorker {
          postMessage(message: unknown): void {
            setTimeout(() => super.postMessage(message), delay)
          }
        }
        Reflect.set(window, 'Worker', DelayedWorker)
      }, renderDelay)
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('连续流渲染')
      await input.press('Enter')
      const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
      await expect(answer.getByRole('heading', { name: '连续流渲染', exact: true })).toBeVisible()
      await answer.evaluate((element) => {
        const heading = element.querySelector('h1'),
          code = element.querySelector('pre'),
          button = element.querySelector('button[data-copy-code]')
        const updates: { index: number; delayMs: number }[] = []
        let previous = -1
        const observer = new MutationObserver(() => {
          const latest = Array.from(
            (element.textContent ?? '').matchAll(/序号(\d{3})时刻(\d{13})/g),
          ).at(-1)
          const index = Number(latest?.[1] ?? -1)
          if (index > previous) {
            previous = index
            updates.push({
              index,
              delayMs: Date.now() - Number(latest?.[2] ?? Date.now()),
            })
          }
        })
        observer.observe(element, { subtree: true, childList: true, characterData: true })
        Reflect.set(window, 'streamRenderingReport', () => ({
          updates,
          sameHeading: heading === element.querySelector('h1'),
          sameCode: code === element.querySelector('pre'),
          sameButton: button === element.querySelector('button[data-copy-code]'),
        }))
        Reflect.set(window, 'stopStreamObservation', () => {
          observer.disconnect()
        })
      })
      for (let index = 0; index < 60; index++) {
        modelEndpoint.appendStream(`序号${String(index).padStart(3, '0')}时刻${Date.now()}正文。`)
        await new Promise((resolve) => setTimeout(resolve, 12))
      }
      await expect(answer).toContainText('序号059')
      const report = await page.evaluate(() => Reflect.get(window, 'streamRenderingReport')())
      await mkdir('.artifacts', { recursive: true })
      await writeFile(
        `.artifacts/stream-rendering-${renderDelay}.json`,
        JSON.stringify(report, null, 2),
      )
      expect(report.updates.length).toBeGreaterThanOrEqual(5)
      expect(report.sameHeading).toBe(true)
      expect(report.sameCode).toBe(true)
      expect(report.sameButton).toBe(true)
      expect(
        Math.max(...report.updates.map((sample: { delayMs: number }) => sample.delayMs)),
      ).toBeLessThan(500)
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
      const scroller = page.locator('[data-conversation-scroll]')
      const distanceFromBottom = () =>
        scroller.evaluate((element) =>
          Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight),
        )
      await expect.poll(distanceFromBottom).toBeLessThan(1)
      const composer = page.locator('[data-conversation-composer]')
      const runningIndicator = composer.getByRole('button', { name: '正在执行', exact: true })
      const dots = runningIndicator.locator('.conversation-progress-dots > span')
      await expect(runningIndicator).toBeDisabled()
      await expect(dots).toHaveCount(3)
      await expect(dots.first()).toHaveCSS('animation-iteration-count', 'infinite')
      expect(
        new Set(
          await dots.evaluateAll((items) =>
            items.map((dot) => getComputedStyle(dot).animationDelay),
          ),
        ).size,
      ).toBe(3)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(dots.first()).toHaveCSS('animation-name', 'none')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const indicatorBounds = (await runningIndicator.boundingBox())!
      const inputArea = (await composer.boundingBox())!
      expect(indicatorBounds.x + indicatorBounds.width / 2).toBeCloseTo(
        inputArea.x + inputArea.width / 2,
      )
      expect(indicatorBounds.y + indicatorBounds.height).toBeLessThan(inputArea.y)

      await scroller.evaluate((element) => {
        element.scrollTop = 120
      })
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(120)
      modelEndpoint.appendStream('\n\n阅读期间的新段落。'.repeat(15))
      await expect(answer).toContainText('阅读期间的新段落。')
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(120)
      const latest = composer.getByRole('button', { name: '回到最新消息', exact: true })
      await expect(latest.locator('.conversation-progress-dots > span')).toHaveCount(3)
      await latest.click()
      await expect.poll(distanceFromBottom).toBeLessThan(1)
      await scroller.evaluate((element) => {
        element.scrollTop = 120
      })
      await expect(latest).toBeEnabled()
      modelEndpoint.finishStream()
      await expect(page.getByRole('button', { name: '停止生成', exact: true })).not.toBeVisible()
      await expect(latest.locator('svg')).toBeVisible()
      await latest.press('Enter')
      await expect.poll(distanceFromBottom).toBeLessThan(1)
      await expect(latest).toHaveCount(0)
      await expect(answer.locator('pre')).toHaveCount(12)
      await page.evaluate(() => Reflect.get(window, 'stopStreamObservation')())

      const viewportBounds = (await scroller.boundingBox())!
      const composerBounds = (await composer.boundingBox())!
      expect(viewportBounds.y + viewportBounds.height).toBeCloseTo(
        composerBounds.y + composerBounds.height,
      )
      expect(
        viewportBounds.x + viewportBounds.width - composerBounds.x - composerBounds.width,
      ).toBeCloseTo(6)

      const composerTop = () => composer.evaluate((element) => element.getBoundingClientRect().top)
      await input.fill('未发送的多行草稿。\n'.repeat(10))
      await expect.poll(composerTop).toBeLessThan(composerBounds.y)
      await expect.poll(distanceFromBottom).toBeLessThan(1)
      await expect
        .poll(async () => {
          const bottom = await answer.evaluate((element) => element.getBoundingClientRect().bottom)
          return (await composerTop()) - bottom
        })
        .toBeGreaterThanOrEqual(12)
    })

  test('流式 Markdown、高亮、复制、链接与深色小窗口布局', async ({ desktop, modelEndpoint }) => {
    if (!modelEndpoint) throw new Error('受控端点不存在')
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // 只替换本次 Electron 进程的系统调用，验证真实 IPC，不写用户剪贴板或打开外部浏览器。
    await desktop.evaluate(({ clipboard, shell }) => {
      const state: { copies: string[]; links: string[]; copyFails: boolean; linkFails: boolean } = {
        copies: [],
        links: [],
        copyFails: false,
        linkFails: false,
      }
      Reflect.set(globalThis, 'callumMarkdownTest', state)
      clipboard.writeText = async (text) => {
        if (state.copyFails) throw new Error('受控复制失败')
        state.copies.push(text)
      }
      shell.openExternal = async (url) => {
        if (state.linkFails) throw new Error('受控打开失败')
        state.links.push(url)
      }
    })
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('Markdown 流式\n# 用户消息保留原文')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    const heading = answer.getByRole('heading', { name: 'Markdown 示例', exact: true })
    const copyAnswer = answer.getByRole('button', { name: '复制回答', exact: true })
    await expect(heading).toBeVisible()
    await expect(answer.locator('strong')).toHaveText('粗体')
    await expect(answer.locator('blockquote')).toContainText('引用内容')
    await expect(answer.locator('li')).toHaveCount(4)
    await expect(answer.locator('ul ul')).toHaveCount(1)
    await expect(answer.locator('code .hljs-keyword').first()).toHaveText('const')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await heading.hover()
    await expect(copyAnswer).toHaveCount(0)
    await expect(
      page.getByRole('article', { name: '你的消息', exact: true }).locator('h1'),
    ).toHaveCount(0)
    const code = answer.locator('pre').first()
    const scrollLeft = await code.evaluate((element) => {
      element.scrollLeft = 160
      return element.scrollLeft
    })
    expect(scrollLeft).toBeGreaterThan(0)
    const copy = answer.getByRole('button', { name: '复制代码', exact: true }).first()
    await copy.focus()
    await copy.press('Enter')
    await expect(answer.getByRole('button', { name: '代码已复制', exact: true })).toBeFocused()
    modelEndpoint.finishMarkdown()
    await expect(answer.getByText('回答已经完成。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).not.toBeVisible()
    await expect(answer.getByRole('table')).toBeVisible()
    await expect(answer.locator('pre')).toHaveCount(2)
    // 新快照替换了 DOM，代码续写仍保留阅读位置与键盘焦点；旧的复制反馈不能用于新代码。
    await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBe(scrollLeft)
    await expect(copy).toBeFocused()
    await expect(answer.getByRole('button', { name: '代码已复制', exact: true })).toHaveCount(0)
    await copy.press('Enter')
    await expect(answer.getByRole('button', { name: '代码已复制', exact: true })).toBeVisible()
    expect(
      await desktop.evaluate(() => Reflect.get(globalThis, 'callumMarkdownTest').copies),
    ).toEqual([MARKDOWN_CODE_START, MARKDOWN_CODE])
    const actions = answer.getByRole('group', { name: '消息操作', exact: true })
    await input.focus()
    await input.hover()
    await expect(actions).toHaveCSS('opacity', '0')
    await heading.hover()
    await expect(actions).toHaveCSS('opacity', '1')
    await copyAnswer.click()
    expect(
      await desktop.evaluate(() => Reflect.get(globalThis, 'callumMarkdownTest').copies.at(-1)),
    ).toBe(MARKDOWN_START + MARKDOWN_END)
    await answer
      .getByRole('heading', { name: 'Markdown 示例', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.artifacts/screenshots/markdown-light-prose.png' })
    await answer.getByRole('link', { name: '项目文档', exact: true }).click()
    expect(
      await desktop.evaluate(() => Reflect.get(globalThis, 'callumMarkdownTest').links),
    ).toEqual(['https://example.com/docs?source=callum'])
    expect(page.url()).toBe('callum://app/')
    await page.screenshot({ path: '.artifacts/screenshots/markdown-light.png' })
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'callumMarkdownTest').copyFails = true
      Reflect.get(globalThis, 'callumMarkdownTest').linkFails = true
    })
    await answer.getByRole('button', { name: '复制代码', exact: true }).last().click()
    await expect(answer.getByRole('alert')).toHaveText('代码复制失败，请重试。')
    await answer.getByRole('link', { name: '项目文档', exact: true }).click()
    await expect(answer.getByRole('alert')).toHaveText('网页链接无法打开，请检查地址后重试。')
    await desktop.evaluate(() => {
      Reflect.get(globalThis, 'callumMarkdownTest').copyFails = false
      Reflect.get(globalThis, 'callumMarkdownTest').linkFails = false
    })
    const sidebar = page.getByRole('region', { name: '最近', exact: true })
    const conversation = sidebar.locator('button[aria-current="page"]')
    const title = await conversation.getAttribute('title')
    if (!title) throw new Error('会话标题不存在')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await sidebar.getByRole('button', { name: title, exact: true }).click()
    await expect(answer.getByRole('table')).toBeVisible()
    const table = answer.locator('.markdown-table-wrap')
    expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await table.focus()
    await table.press('ArrowRight')
    await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await page.screenshot({ path: '.artifacts/screenshots/markdown-dark-compact.png' })
    await answer
      .getByRole('heading', { name: 'Markdown 示例', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.artifacts/screenshots/markdown-dark-prose.png' })
    expect(errors).toEqual([])
  })

  test('模型中的 HTML 与危险链接不执行，图片不加载，IPC 拒绝系统协议', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.url().startsWith('https://example.invalid/')) requests.push(request.url())
    })
    await desktop.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error('非法链接不应触及系统调用')
      }
    })
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('Markdown 安全')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    await expect(answer.getByRole('heading', { name: '安全展示', exact: true })).toBeVisible()
    await expect(
      answer
        .locator('.markdown-message')
        .locator('script, img, iframe, svg, style, form, [onclick], [onerror]'),
    ).toHaveCount(0)
    await expect(answer.getByRole('link', { name: '网页', exact: true })).toBeVisible()
    expect(
      await answer
        .locator('a')
        .evaluateAll((elements) =>
          elements.every((element) => /^https?:\/\//.test(element.getAttribute('href') ?? '')),
        ),
    ).toBe(true)
    expect(await page.evaluate(() => Reflect.get(window, 'markdownExecuted'))).toBeUndefined()
    const results = await page.evaluate(async () =>
      Promise.all(
        [
          'javascript:alert(1)',
          'file:///tmp/file',
          'callum://app/',
          'mailto:test@example.com',
          'https://user:pass@example.com',
        ].map((url) => window.callum.openWebLink(url)),
      ),
    )
    expect(results.every((result) => !result.ok)).toBe(true)
    const invalidCopy: unknown = await page.evaluate(() =>
      Reflect.apply(window.callum.copyCode, undefined, [{ command: 'unexpected' }]),
    )
    expect(invalidCopy).toEqual({ ok: false, error: '代码复制失败，请重试。' })
    expect(requests).toEqual([])
    expect(page.url()).toBe('callum://app/')
  })

  test('长内容完整回退为文本，取消及切换页面后不遗留旧排版', async ({ desktop, modelEndpoint }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('Markdown 流式')
    await input.press('Enter')
    let answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    await expect(answer.getByRole('heading', { name: 'Markdown 示例', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByText('生成已停止', { exact: true })).toBeVisible()
    modelEndpoint?.finishMarkdown()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Markdown 示例', exact: true }),
    ).not.toBeVisible()
    await input.fill('Markdown 长内容')
    await input.press('Enter')
    answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    await expect(answer.getByText('内容较长，已按文本显示。', { exact: true })).toBeVisible()
    expect(await answer.locator('p').filter({ hasText: '完整长内容-' }).innerText()).toHaveLength(
      '完整长内容-'.length + 256 * 1024,
    )
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
  })

  test('排版 Worker 无响应时有界终止并完整回退文本', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    await page.evaluate(() => {
      const OriginalWorker = window.Worker
      class SilentWorker extends OriginalWorker {
        postMessage(): void {
          /* 故意不转发请求，用于验证真实的 Worker 超时与释放。 */
        }
        terminate(): void {
          Reflect.set(window, 'markdownWorkerTerminated', true)
          super.terminate()
        }
      }
      Reflect.set(window, 'Worker', SilentWorker)
    })
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('Markdown 安全')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    await expect(
      answer.getByText('消息排版暂不可用，已按文本显示。', { exact: true }),
    ).toBeVisible()
    await expect(answer).toContainText('# 安全展示')
    await expect(answer.locator('h1, script, img, iframe')).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, 'markdownWorkerTerminated'))).toBe(true)
    await expect(input).toBeEnabled()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设置', level: 1, exact: true })).toBeVisible()
  })
})

test.describe('Codex 风格过程展示', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('运行中直接显示单条操作，结束收起，标题支持键盘展开', async ({ desktop, modelEndpoint }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    const timeline = answer.getByRole('region', { name: '调用过程', exact: true })
    const toggle = timeline.getByRole('button', { name: '调用过程', exact: true })
    const overview = timeline.getByRole('region', { name: '过程概述', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('分阶段过程命令')
    await input.press('Enter')
    await expect(answer).toContainText('我会先运行检查命令')
    // 运行中不要求先打开外层过程，也不提供可折叠的“思考中”按钮。
    await expect(toggle).toHaveCount(0)
    await expect(overview.getByLabel('思考内容')).toBeVisible()
    await expect(overview.getByLabel('思考内容')).toContainText('核对调用结果，再决定下一步。')
    await expect(overview.getByRole('button', { name: '思考过程', exact: true })).toHaveCount(0)
    await expect(overview.locator('.activity-shimmer')).toHaveText('思考中')
    await expect(overview).toHaveCSS('border-left-width', '0px')
    await expect(overview).toHaveCSS('font-size', '14px')
    await page.screenshot({
      path: '.artifacts/screenshots/activity-thinking-light.png',
      animations: 'disabled',
    })
    await expect.poll(() => modelEndpoint?.pendingProcess).toBe(1)
    modelEndpoint!.continueProcess()
    await expect(answer).toContainText('命令检查已完成')
    const thinking = overview.getByRole('button', { name: '思考过程', exact: true }).first()
    await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    await thinking.focus()
    await thinking.press('Enter')
    await expect(thinking).toHaveAttribute('aria-expanded', 'true')
    await expect(thinking.locator('svg')).toHaveCSS('opacity', '1')
    await thinking.press('Space')
    await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    const command = overview.getByRole('button', {
      name: '工具详情：已运行 /bin/echo controlled-fold-output',
      exact: true,
    })
    await expect(command).toBeVisible()
    await expect(overview.getByRole('button', { name: /^操作分组：/ })).toHaveCount(0)
    await expect(command).toHaveAttribute('aria-expanded', 'false')
    await command.focus()
    await command.press('Enter')
    const terminal = overview.locator('.activity-terminal')
    await expect(terminal.getByLabel('命令', { exact: true })).toHaveText(
      '$ /bin/echo controlled-fold-output',
    )
    await expect(terminal.getByLabel('工具结果', { exact: true })).toHaveText(
      'controlled-fold-output',
    )
    const raw = overview.locator('.activity-command-record')
    await expect(raw.getByText('退出码 0', { exact: true })).toBeVisible()
    await expect(overview.getByText('目标与参数', { exact: true })).toHaveCount(0)
    await expect(raw).not.toHaveAttribute('open')
    await expect(overview.getByRole('button', { name: '刷新结果', exact: true })).toHaveCount(0)
    await expect(timeline.locator('.activity-reveal-enter-active')).toHaveCount(0)
    await command.evaluate((element) => (element as HTMLElement).blur())
    await overview
      .locator('[data-tool-details]')
      .screenshot({ path: '.artifacts/screenshots/activity-command-terminal.png' })
    await terminal.focus()
    await expect.poll(() => modelEndpoint?.pendingProcess).toBe(1)
    modelEndpoint!.continueProcess()
    await expect(answer).toContainText('已完成项目检查')
    expect(modelEndpoint!.requests.some((request) => request.reasoningReturned)).toBe(true)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    await expect(overview).toHaveCount(0)
    await expect(answer.getByRole('group', { name: '执行状态', exact: true })).toHaveCount(1)
    await toggle.press('Enter')
    await expect(overview).toContainText('命令检查已完成')
    await expect(command).toBeVisible()
    await expect(
      overview.getByRole('button', { name: '工具详情：已读取 fixture.txt', exact: true }),
    ).toBeVisible()
    await expect(
      overview.getByRole('button', { name: '思考过程', exact: true }).first(),
    ).toContainText('已思考')
    await expect(overview.locator('[data-tool-details]')).toHaveCount(0)
    await expect(timeline.locator('.activity-reveal-enter-active')).toHaveCount(0)
    await input.focus()
    await page.mouse.move(1, 1)
    await timeline.screenshot({
      path: '.artifacts/screenshots/activity-single-operation-light.png',
    })
    await toggle.click()
    await expect(overview).toHaveCount(0)
    await input.focus()
    await page.mouse.move(1, 1)
    // 收起且无悬停/焦点时隐藏箭头；标题的完整区域可点击。
    await expect(toggle.locator('svg')).toHaveCSS('opacity', '0')
    await toggle.hover()
    await expect(toggle.locator('svg')).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: '.artifacts/screenshots/activity-collapsed-light.png',
      animations: 'disabled',
    })
    await toggle.click()
    await toggle.click()
    await toggle.click()
    await expect(overview).toContainText('命令检查已完成')
    await expect(timeline.locator('.activity-body').first()).toHaveJSProperty('inert', false)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '分阶段过程命令', exact: true })
      .click()
    await toggle.click()
    await overview.getByRole('button', { name: '思考过程', exact: true }).first().click()
    await expect(overview.getByLabel('思考内容').first()).toBeVisible()
    await expect(
      overview.locator('.activity-reveal-enter-active, .activity-reveal-leave-active'),
    ).toHaveCount(0)
    await expect
      .poll(() =>
        overview
          .getByLabel('思考文本')
          .first()
          .evaluate((element) => element.clientHeight),
      )
      .toBeGreaterThan(20)
    await page.screenshot({
      path: '.artifacts/screenshots/activity-expanded-dark.png',
      animations: 'disabled',
    })
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await command.click()
    await expect(terminal.getByLabel('工具结果', { exact: true })).toHaveText(
      'controlled-fold-output',
    )
    await expect(terminal).toHaveCSS('border-top-width', '0px')
    await expect(timeline.locator('.activity-reveal-enter-active')).toHaveCount(0)
    await overview
      .locator('[data-tool-details]')
      .screenshot({ path: '.artifacts/screenshots/activity-command-detail-dark.png' })
  })

  test('概述间合并多项操作，阶段结束自动收起，审批和失败始终可见', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    const groups = answer.locator('[data-operation-group]')
    const firstGroup = groups.first()
    const firstToggle = firstGroup.getByRole('button', { name: /^操作分组：/ })
    await expect(input).toBeEnabled()
    await input.fill('操作分组')
    await input.press('Enter')
    await expect(answer).toContainText('我会先核对目录和文件')
    await expect.poll(() => modelEndpoint?.pendingProcess).toBe(1)
    modelEndpoint!.continueProcess()
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(answer).toContainText('第一组检查已完成')
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(firstToggle).toHaveText('已查看目录、读取文件、运行命令')
    await expect(firstGroup.getByRole('region', { name: '本组操作', exact: true })).toHaveCount(0)
    await firstToggle.focus()
    await firstToggle.press('Enter')
    await expect(firstGroup.getByRole('button', { name: /^工具详情：/ })).toHaveCount(4)
    const command = firstGroup.getByRole('button', {
      name: '工具详情：已运行 /bin/echo controlled-group-output',
      exact: true,
    })
    await expect(command).toHaveAttribute('aria-expanded', 'false')
    await expect(firstGroup.locator('[data-tool-details]')).toHaveCount(0)
    await command.press('Enter')
    await expect(firstGroup.getByLabel('工具结果', { exact: true })).toContainText(
      'controlled-group-output',
    )
    await firstGroup
      .getByRole('button', { name: '工具详情：已运行 /bin/sleep 1', exact: true })
      .click()
    await expect(
      firstGroup
        .locator('.activity-terminal')
        .filter({ hasText: '$ /bin/sleep 1' })
        .getByLabel('工具结果', { exact: true }),
    ).toHaveText('无输出。')
    await firstToggle.press('Space')
    await firstToggle.press('Enter')
    await expect(command).toHaveAttribute('aria-expanded', 'false')
    await expect(firstGroup.locator('[data-tool-details]')).toHaveCount(0)
    await expect.poll(() => modelEndpoint?.pendingProcess).toBe(1)
    modelEndpoint!.continueProcess()
    const lastGroup = groups.last()
    const lastToggle = lastGroup.getByRole('button', { name: /^操作分组：/ })
    await expect(groups).toHaveCount(2)
    await expect(lastToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(lastToggle).toContainText('1 项等待审批')
    await expect(lastToggle).toContainText('1 项失败')
    await lastToggle.click()
    await expect(lastToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(lastToggle).toContainText('1 项等待审批')
    await expect(lastToggle.locator('.text-destructive')).toContainText('1 项失败')
    await page.getByRole('button', { name: '仅本次允许', exact: true }).click()
    await expect(answer).toContainText('操作分组检查已完成。')
    const toggle = answer.getByRole('button', { name: '调用过程', exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(groups).toHaveCount(2)
    for (const group of await groups.all())
      await expect(group.getByRole('button', { name: /^操作分组：/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      )
    await expect(answer.locator('[data-tool-details]')).toHaveCount(0)
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '操作分组', exact: true })
      .click()
    await toggle.click()
    await expect(groups).toHaveCount(2)
    await expect(lastToggle).toContainText('1 项失败')
    await expect(lastToggle).not.toContainText('等待审批')
    await input.fill('操作分组')
    await input.press('Enter')
    await expect.poll(() => modelEndpoint?.pendingProcess).toBe(1)
    modelEndpoint!.continueProcess()
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'true')
    await firstToggle.click()
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(answer).toContainText('第一组检查已完成')
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(input).toBeEnabled()
  })

  test('终端块展示实时输出、非零退出和历史命令结果，读取失败可重试', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    const stop = page.getByRole('button', { name: '停止生成', exact: true })
    const approval = page.getByRole('region', { name: '工具审批', exact: true })
    const terminal = answer.locator('.activity-terminal')
    const pendingCommand = answer.getByRole('button', { name: /^工具详情：运行命令 · 等待审批/ })
    const openDetails = answer.getByRole('button', { name: '调用过程', exact: true })
    await input.fill('命令取消步骤')
    await input.press('Enter')
    await expect(approval).toBeVisible()
    await pendingCommand.click()
    await approval.getByRole('button', { name: '仅本次允许', exact: true }).click()
    await expect(terminal.getByLabel('实时输出', { exact: true })).toContainText('command-started')
    await stop.click()
    await expect(answer.getByRole('group', { name: '执行状态', exact: true })).toContainText(
      '生成已停止',
    )

    await input.fill('命令非零步骤')
    await input.press('Enter')
    await approval.getByRole('button', { name: '仅本次允许', exact: true }).click()
    await expect(openDetails).toHaveAttribute('aria-expanded', 'false')
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '命令取消步骤', exact: true })
      .click()
    await openDetails.click()
    await answer.getByRole('button', { name: /^工具详情：已运行 / }).click()
    await expect(terminal.getByLabel('工具结果', { exact: true })).toHaveText(
      /command-out\s+\[stderr\]\s+command-err/,
    )
    const raw = answer.locator('.activity-command-record')
    await expect(raw.getByText('退出码 3', { exact: true })).toHaveClass('text-destructive')
    await expect(raw.getByText('工作目录', { exact: false })).not.toBeVisible()
    await raw.getByText('原始记录', { exact: true }).click()
    await expect(raw).toHaveAttribute('open', '')
    await expect(raw.getByText('工作目录', { exact: false })).toBeVisible()
    await expect(raw).toContainText('execution_boundary')

    const saved = await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      const conversation = overview.ok && overview.value.conversations[0]
      if (!conversation) throw new Error('缺少测试对话')
      const detail = await window.callum.getConversation(conversation.id)
      const run = detail.ok && detail.value.runs.at(-1)
      if (!run) throw new Error('缺少测试执行')
      const steps = await window.callum.listRunSteps(conversation.id, run.id, 0)
      const command = steps.ok && steps.value.steps.find((step) => step.name === 'run_command')
      if (!command) throw new Error('缺少命令步骤')
      return window.callum.getStepDetails(conversation.id, run.id, command.id)
    })
    if (!saved.ok) throw new Error(saved.error)
    // 仅替换本次隔离进程的详情回包，验证读取失败和长输出排版。
    await desktop.evaluate(
      ({ ipcMain }, { channel, value }) => {
        let attempts = 0
        const output = JSON.parse(value.output)
        output.result.stdout.data = Array.from(
          { length: 150 },
          (_, index) => `第 ${index + 1} 行输出`,
        ).join('\n')
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, _conversation, _run, stepId) => {
          if (stepId !== value.id || ++attempts === 1)
            return { ok: false, error: '受控命令结果读取失败' }
          return { ok: true, value: { ...value, output: JSON.stringify(output) } }
        })
      },
      { channel: IPC_CHANNELS.getStepDetails, value: saved.value },
    )
    const requests = modelEndpoint?.requests.length
    await raw.getByRole('button', { name: '刷新结果', exact: true }).click()
    const failure = answer.getByRole('alert').filter({ hasText: '受控命令结果读取失败' })
    await expect(failure).toBeVisible()
    await expect(raw).toHaveAttribute('open', '')
    await expect(terminal.getByLabel('工具结果', { exact: true })).toContainText('command-out')
    await failure.getByRole('button', { name: '重试', exact: true }).click()
    await expect(failure).toHaveCount(0)
    await expect(terminal.getByLabel('工具结果', { exact: true })).toContainText('第 150 行输出')
    expect(await terminal.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    )
    expect(modelEndpoint?.requests.length).toBe(requests)
  })
})

test.describe('独立推理取消与恢复', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')
  test('只有推理时实时展示，停止后保留部分内容，重载后可展开', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('思考等待')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    await expect(answer.getByLabel('思考内容')).toBeVisible()
    await expect(answer.getByLabel('思考内容')).toContainText('这是独立推理，等待后续结果。')
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(page.getByLabel('思考内容')).toHaveCount(0)
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '思考等待', exact: true })
      .click()
    await expect(answer.getByLabel('思考内容')).toContainText('这是独立推理，等待后续结果。')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(answer.getByRole('button', { name: '调用过程', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await page.reload()
    await expect(input).toBeEnabled()
    // 重新选择持久化会话，验证内容不是依赖内存中的增量缓存。
    await page.getByRole('button', { name: '思考等待', exact: true }).click()
    await answer.getByRole('button', { name: '调用过程', exact: true }).click()
    await answer.getByRole('button', { name: '思考过程', exact: true }).click()
    await expect(answer.getByLabel('思考内容')).toContainText('这是独立推理，等待后续结果。')
    await expect(answer.getByLabel('思考内容')).toContainText('执行未完成')
  })
})

test.describe('思考滚动与减少动态效果', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')
  test('长思考限制高度并渐隐，结束默认收起，减少动态效果时无动画', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('思考长内容')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    const viewport = answer.getByLabel('思考文本', { exact: true })
    await expect(viewport).toHaveCSS('max-height', '140px')
    await expect(viewport).toHaveAttribute('data-overflow', 'true')
    await expect(viewport).toHaveAttribute('data-at-end', 'true')
    expect(
      await viewport.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(140)
    expect(await viewport.evaluate((element) => getComputedStyle(element).maskImage)).toContain(
      'linear-gradient',
    )
    await viewport.hover()
    await page.mouse.wheel(0, -10000)
    await expect(viewport).toHaveAttribute('data-at-start', 'true')
    await expect(viewport).toHaveAttribute('data-at-end', 'false')
    modelEndpoint!.appendReasoning('\n\n阅读期间收到的新思考。')
    await expect(viewport).toContainText('阅读期间收到的新思考。')
    await expect(viewport).toHaveAttribute('data-at-start', 'true')
    await page.screenshot({
      path: '.artifacts/screenshots/reasoning-long-preview.png',
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    const toggle = answer.getByRole('button', { name: '调用过程', exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await toggle.click()
    const thinking = answer.getByRole('button', { name: '思考过程', exact: true })
    await expect(thinking).toHaveAttribute('aria-expanded', 'false')
    await thinking.click()
    await expect(viewport).toBeVisible()
    await expect(thinking.locator('svg')).toHaveCSS('transition-duration', '0s')
    await expect(thinking).toContainText('已思考')
    await thinking.press('Space')
    await expect(viewport).toHaveCount(0)
  })
})

test.describe('过程自动读取与固定分隔线', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('长过程自动双向读取，无分页提示，展开和收起都保留标题下的分隔线', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('长过程折叠')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    await expect(answer).toContainText('长过程检查已完成。')
    const timeline = answer.getByRole('region', { name: '调用过程', exact: true })
    const toggle = timeline.getByRole('button', { name: '调用过程', exact: true })
    const divider = timeline.locator(':scope > .activity-disclosure > .activity-separator')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(timeline.getByRole('region', { name: '过程概述', exact: true })).toHaveCount(0)
    await toggle.scrollIntoViewIfNeeded()
    await expect(divider).toHaveCSS('border-top-width', '1px')
    const collapsedHeader = await toggle.boundingBox()
    const collapsed = await divider.boundingBox()
    expect(collapsed).not.toBeNull()
    await toggle.click()
    const overview = timeline.getByRole('region', { name: '过程概述', exact: true })
    await expect(overview).toBeVisible()
    await expect(timeline.locator('.activity-reveal-enter-active')).toHaveCount(0)
    const expanded = await divider.boundingBox()
    expect(expanded).not.toBeNull()
    expect(expanded!.width).toBe(collapsed!.width)
    const header = await toggle.boundingBox()
    const collapsedGap = collapsed!.y - (collapsedHeader!.y + collapsedHeader!.height)
    const expandedGap = expanded!.y - (header!.y + header!.height)
    expect(Math.abs(expandedGap - collapsedGap)).toBeLessThan(1)
    expect(expandedGap).toBeGreaterThanOrEqual(0)
    expect(expandedGap).toBeLessThanOrEqual(8)
    await page.screenshot({
      path: '.artifacts/screenshots/process-divider-expanded.png',
      animations: 'disabled',
    })
    await expect(
      timeline.getByRole('button', { name: /更多过程|更早的过程|后续步骤|较早步骤|从头查看/ }),
    ).toHaveCount(0)
    await expect(timeline).not.toContainText('部分记录')
    await expect(timeline).not.toContainText('过程分页')

    const conversation = await page.evaluate(async () => {
      const result = await window.callum.getChatOverview(0)
      if (!result.ok || !result.value.conversations[0]) throw new Error('会话不存在')
      return result.value.conversations[0].id
    })
    const expected = await page.evaluate(async (conversationId) => {
      const detail = await window.callum.getConversation(conversationId)
      if (!detail.ok || !detail.value.runs[0]) throw new Error('执行不存在')
      const runId = detail.value.runs[0].id
      const ids: string[] = []
      let after = 0
      for (;;) {
        const result = await window.callum.listRunSteps(conversationId, runId, after)
        if (!result.ok) throw new Error(result.error)
        ids.push(
          ...result.value.steps.filter((step) => step.type === 'tool_call').map((step) => step.id),
        )
        if (!result.value.hasMore) return ids
        after = result.value.nextSequence
      }
    }, conversation)
    expect(expected).toHaveLength(220)
    const group = timeline.locator('[data-operation-group]').first()
    const groupToggle = group.getByRole('button', { name: /^操作分组：/ })
    // 超过一个窗口的长组不把局部数量伪装成整组次数。
    await expect(groupToggle).toContainText('操作记录')
    await expect(groupToggle).not.toContainText('次')
    await groupToggle.click()
    await expect(
      group.getByRole('button', { name: '工具详情：已读取 fixture.txt', exact: true }).first(),
    ).toBeVisible()
    await expect(group.locator('.activity-reveal-enter-active')).toHaveCount(0)
    const seen = new Set<string>()
    const loaded = async () =>
      overview
        .locator('[data-step-id]')
        .evaluateAll((elements) =>
          elements
            .filter((element) => !element.querySelector('[data-step-id]'))
            .map((element) => element.getAttribute('data-step-id')!),
        )
    ;(await loaded()).forEach((id) => seen.add(id))
    const scroller = page.locator('[data-conversation-scroll]')
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect
      .poll(async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        const ids = await loaded()
        ids.forEach((id) => seen.add(id))
        expect(ids.length).toBeLessThanOrEqual(150)
        return ids.includes(expected.at(-1)!)
      })
      .toBe(true)
    ;(await loaded()).forEach((id) => seen.add(id))
    expect((await loaded()).length).toBeLessThanOrEqual(150)
    // 到顶后即使没有更大的滚动空间，向上滚轮仍能触发前一批读取。
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await groupToggle.hover()
    await page.mouse.wheel(0, -10000)
    await expect
      .poll(async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = 0
        })
        const ids = await loaded()
        ids.forEach((id) => seen.add(id))
        expect(ids.length).toBeLessThanOrEqual(150)
        return ids.includes(expected[0]!)
      })
      .toBe(true)
    ;(await loaded()).forEach((id) => seen.add(id))
    expect((await loaded()).length).toBeLessThanOrEqual(150)
    expect(expected.every((id) => seen.has(id))).toBe(true)
    await expect(overview.getByRole('alert')).toHaveCount(0)
    await toggle.click()
    await expect(overview).toHaveCount(0)
    await expect(divider).toBeVisible()
    await page.screenshot({
      path: '.artifacts/screenshots/process-divider-collapsed.png',
      animations: 'disabled',
    })
    expect(errors).toEqual([])
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })
})

test.describe('运行中状态分隔线', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('已停止的上一轮和正在处理的下一轮都显示横线，完成后不重复', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    const answers = page.getByRole('article', { name: 'Callum 的回答', exact: true })
    async function expectLiveLine(): Promise<void> {
      const status = answers.last().getByRole('group', { name: '执行状态', exact: true })
      await expect(status).toContainText('正在处理')
      await expect(status).toHaveCount(1)
      const timeline = answers.last().getByRole('region', { name: '调用过程', exact: true })
      const header = timeline.locator(':scope > .activity-disclosure > .activity-heading')
      const divider = timeline.locator(':scope > .activity-disclosure > .activity-separator')
      await expect(header.getByRole('group', { name: '执行状态', exact: true })).toHaveCount(1)
      await expect(divider).toHaveCSS('border-top-width', '1px')
      const position = await timeline.evaluate((element) => {
        const header = element
          .querySelector(':scope > .activity-disclosure > .activity-heading')!
          .getBoundingClientRect()
        const divider = element
          .querySelector(':scope > .activity-disclosure > .activity-separator')!
          .getBoundingClientRect()
        const rows = element.querySelector('.activity-rows')!.getBoundingClientRect()
        return {
          headerBottom: header.bottom,
          dividerY: divider.y,
          dividerBottom: divider.bottom,
          rowsY: rows.y,
          dividerWidth: divider.width,
          width: element.getBoundingClientRect().width,
        }
      })
      expect(position.headerBottom).toBeLessThanOrEqual(position.dividerY)
      expect(position.dividerBottom).toBeLessThanOrEqual(position.rowsY)
      expect(Math.abs(position.dividerWidth - position.width)).toBeLessThan(1)
    }
    await expect(input).toBeEnabled()
    await input.fill('思考等待')
    await input.press('Enter')
    await expect(answers.last().getByLabel('思考内容')).toBeVisible()
    await expectLiveLine()
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(
      answers.first().getByRole('group', { name: '执行状态', exact: true }),
    ).toContainText('生成已停止')
    const previousLine = answers.first().locator('.activity-separator')
    await expect(previousLine).toBeVisible()
    await input.fill('思考等待')
    await input.press('Enter')
    await expect(answers).toHaveCount(2)
    await expect(answers.last().getByLabel('思考内容')).toBeVisible()
    await expectLiveLine()
    await expect(previousLine).toBeVisible()
    // 上一轮展开后，当前运行中的横线和历史分隔线均继续存在。
    await answers.first().getByRole('button', { name: '调用过程', exact: true }).click()
    await expect(
      answers.first().getByRole('region', { name: '过程概述', exact: true }),
    ).toBeVisible()
    await expect(previousLine).toBeVisible()
    await expectLiveLine()
    await answers
      .last()
      .getByRole('group', { name: '执行状态', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      path: '.artifacts/screenshots/process-running-divider.png',
      animations: 'disabled',
    })
    const liveOffset = await answers
      .last()
      .evaluate(
        (element) =>
          element.querySelector('.activity-heading')!.getBoundingClientRect().y -
          element.getBoundingClientRect().y,
      )
    modelEndpoint!.finishStream()
    await expect(
      answers.last().getByRole('group', { name: '执行状态', exact: true }),
    ).toContainText('已处理')
    const finishedOffset = await answers
      .last()
      .evaluate(
        (element) =>
          element.querySelector('.activity-heading')!.getBoundingClientRect().y -
          element.getBoundingClientRect().y,
      )
    expect(Math.abs(finishedOffset - liveOffset)).toBeLessThan(1)
    await expect(answers.last().locator('.activity-live-status')).toHaveCount(0)
    await expect(answers.last().locator('.activity-separator')).toHaveCount(1)
    await expect(answers.last().locator('.activity-separator')).toBeVisible()
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })
})

test.describe('长任务自动压缩', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')

  test('跨过请求消息边界后自动压缩并继续，原始工具结果与分隔线保留', async ({
    desktop,
    modelEndpoint,
  }) => {
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    modelEndpoint!.pauseCompaction()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('自动压缩长任务')
    await input.press('Enter')
    const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
    const compression = answer.locator('[data-compaction-status]')
    await expect.poll(() => modelEndpoint!.pendingCompaction, { timeout: 20_000 }).toBe(1)
    await expect(compression).toHaveCount(1)
    await expect(compression).toHaveText('正在压缩上下文 · 可能需要几分钟')
    await expect(compression.getByRole('button')).toHaveCount(0)
    await expect(compression.locator('.animate-spin, .activity-chevron')).toHaveCount(0)
    expect(
      await compression.evaluate((element) => element.closest('[data-operation-group]') === null),
    ).toBe(true)
    const aligned = await answer.evaluate((element) => ({
      row: element.querySelector('[data-compaction-status]')!.getBoundingClientRect().x,
      content: element.querySelector('.activity-rows')!.getBoundingClientRect().x,
      status: element.querySelector('.activity-heading')!.getBoundingClientRect().y,
      body: element.querySelector('.activity-rows')!.getBoundingClientRect().y,
    }))
    expect(Math.abs(aligned.row - aligned.content)).toBeLessThan(1)
    expect(aligned.status).toBeLessThan(aligned.body)
    await compression.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: '.artifacts/screenshots/compaction-running-light.png',
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByText('深色', { exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '自动压缩长任务', exact: true })
      .click()
    await expect(compression).toHaveText('正在压缩上下文 · 可能需要几分钟')
    modelEndpoint!.finishCompaction()
    await expect.poll(() => modelEndpoint!.pendingCompactionAnswer).toBe(1)
    await expect(compression).toHaveText('上下文已自动压缩')
    await expect(compression.locator('.activity-shimmer')).toHaveCount(0)
    await compression.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: '.artifacts/screenshots/compaction-completed-dark.png',
      animations: 'disabled',
    })
    expect(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    modelEndpoint!.finishCompactionTask()
    await expect(answer).toContainText('长任务自动压缩完成。', { timeout: 20_000 })
    await expect(answer.locator('.activity-separator')).toHaveCount(1)
    const toggle = answer.getByRole('button', { name: '调用过程', exact: true })
    await toggle.click()
    const scroller = page.locator('[data-conversation-scroll]')
    // 压缩记录可能处于历史分页之后，滚动时再读取，原始窗口仍保持有界。
    await expect
      .poll(async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        if (!(await compression.count())) {
          await scroller.hover()
          await page.mouse.wheel(0, 10000)
        }
        return compression.count()
      })
      .toBe(1)
    await expect(compression).toHaveText('上下文已自动压缩')
    await page.reload()
    await page
      .getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: '自动压缩长任务', exact: true })
      .click()
    await toggle.click()
    await expect
      .poll(async () => {
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        if (!(await compression.count())) {
          await scroller.hover()
          await page.mouse.wheel(0, 10000)
        }
        return compression.count()
      })
      .toBe(1)
    await expect(compression).toHaveText('上下文已自动压缩')
    const requests = modelEndpoint!.requests
    expect(requests.some((request) => request.summaryRequest)).toBe(true)
    expect(requests.some((request) => request.stream && request.contextSummary)).toBe(true)
    expect(requests.every((request) => request.messageCount <= 256)).toBe(true)
    const audit = await page.evaluate(async () => {
      const overview = await window.callum.getChatOverview(0)
      if (!overview.ok || !overview.value.conversations[0]) throw new Error('会话不存在')
      const conversationId = overview.value.conversations[0].id
      const detail = await window.callum.getConversation(conversationId)
      if (!detail.ok || !detail.value.runs[0]) throw new Error('执行不存在')
      const runId = detail.value.runs[0].id
      let after = 0,
        tools = 0,
        checkpoints = 0
      for (;;) {
        const result = await window.callum.listRunSteps(conversationId, runId, after)
        if (!result.ok) throw new Error(result.error)
        tools += result.value.steps.filter(
          (step) => step.type === 'tool_call' && step.status === 'completed',
        ).length
        checkpoints += result.value.steps.filter(
          (step) => step.type === 'context_compression' && step.status === 'completed',
        ).length
        if (!result.value.hasMore) return { tools, checkpoints }
        after = result.value.nextSequence
      }
    })
    expect(audit.tools).toBe(280)
    expect(audit.checkpoints).toBeGreaterThan(0)
    expect(errors).toEqual([])
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
      ),
    ).toBe(false)
  })
})

test.describe('上下文压缩异常状态', () => {
  test.use({ withModel: true })
  test.skip(!supportedBackend, '仅提供 macOS arm64 Go 程序')
  for (const outcome of ['failure', 'cancel', 'disconnect'] as const) {
    test(`压缩${outcome}保留实际状态，不显示成功或普通操作分组`, async ({
      desktop,
      modelEndpoint,
    }) => {
      const page = await desktop.firstWindow()
      modelEndpoint!.pauseCompaction()
      const input = page.getByRole('textbox', { name: '消息', exact: true })
      await expect(input).toBeEnabled()
      await input.fill('自动压缩长任务')
      await input.press('Enter')
      const answer = page.getByRole('article', { name: 'Callum 的回答', exact: true }).last()
      const compression = answer.locator('[data-compaction-status]')
      await expect.poll(() => modelEndpoint!.pendingCompaction, { timeout: 20_000 }).toBe(1)
      await expect(compression).toHaveText('正在压缩上下文 · 可能需要几分钟')
      if (outcome === 'disconnect') {
        await interruptTestBackend(desktop)
        await expect(compression).toContainText('连接已断开 · 上下文压缩状态待确认')
      } else {
        if (outcome === 'failure') modelEndpoint!.finishCompaction(false)
        else await page.getByRole('button', { name: '停止生成', exact: true }).click()
        await expect(answer.getByRole('group', { name: '执行状态', exact: true })).toContainText(
          outcome === 'failure' ? '回答失败' : '生成已停止',
        )
        await answer.getByRole('button', { name: '调用过程', exact: true }).click()
        await expect
          .poll(async () => {
            await page.locator('[data-conversation-scroll]').evaluate((element) => {
              element.scrollTop = element.scrollHeight
            })
            if (!(await compression.count())) {
              await page.locator('[data-conversation-scroll]').hover()
              await page.mouse.wheel(0, 10000)
            }
            return compression.count()
          })
          .toBe(1)
        await expect(compression).toContainText(
          outcome === 'failure' ? '上下文压缩失败' : '上下文压缩已取消',
        )
      }
      await expect(compression).not.toContainText('上下文已自动压缩')
      await expect(compression.locator('.activity-shimmer, .animate-spin')).toHaveCount(0)
      await expect(compression.getByRole('button')).toHaveCount(0)
      expect(
        await desktop.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
        ),
      ).toBe(false)
    })
  }
})
