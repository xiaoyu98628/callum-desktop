import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test as base, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { backendExecutable, resourceRoot, seedModel, supportedBackend } from '../helpers/backend'
import { startModelServer } from '../helpers/model-server'
import { ChatService } from '../../src/main/backend/chat-service'
import { MARKDOWN_CODE, MARKDOWN_CODE_START } from '../helpers/markdown-fixture'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

const test = base.extend<{
  desktop: ElectronApplication
  profile: string
  withModel: boolean
  withEndpoint: boolean
  modelEndpoint: Awaited<ReturnType<typeof startModelServer>> | null
}>({
  withModel: [false, { option: true }],
  withEndpoint: [false, { option: true }],
  profile: async ({ playwright }, use) => {
    void playwright
    const profile = await mkdtemp(join(tmpdir(), 'callum-desktop-e2e-'))
    try {
      await use(profile)
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  modelEndpoint: async ({ withModel, withEndpoint, profile }, use) => {
    if (!withModel && !withEndpoint) {
      await use(null)
      return
    }
    const file = join(profile, 'fixture.txt')
    await writeFile(file, 'controlled-file', { mode: 0o600 })
    const endpoint = await startModelServer(file, 'fixture-ui-key')
    try {
      if (withModel) await seedModel(profile, endpoint.baseUrl)
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
        env: { ...process.env, CALLUM_USER_DATA_DIR: profile },
      })
      application.on('close', () => {
        closed = true
      })
      await use(application)
    } finally {
      if (!closed) await application?.close()
    }
  },
})

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
    'openWebLink',
    'getModelCatalog',
    'saveModelProvider',
    'deleteModelProvider',
    'saveModel',
    'setModelEnabled',
    'deleteModel',
    'getChatOverview',
    'getConversation',
    'getEarlierMessages',
    'sendMessage',
    'cancelRun',
    'decideApproval',
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
  const workspace = page.getByRole('region', { name: '工作区', exact: true })
  const conversations = page.getByRole('region', { name: '对话', exact: true })
  await expect(workspace.getByText('暂无工作区', { exact: true })).toBeVisible()
  await expect(conversations.getByText('暂无对话', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '添加工作区' })).toBeDisabled()
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
  await expect(workspace.getByText('暂无工作区', { exact: true })).toBeVisible()
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

  test('输入默认单行，自动向上增高并在删除、发送、恢复草稿及窗口缩放时适配', async ({
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
          singleLineHeight:
            parseFloat(style.lineHeight) +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom),
          maxHeight: parseFloat(style.maxHeight),
          top: rect.top,
          bottom: rect.bottom,
          clientHeight: textarea.clientHeight,
          scrollHeight: textarea.scrollHeight,
          overflowY: style.overflowY,
        }
      })
    await expect(input).toHaveAttribute('rows', '1')
    const initial = await geometry()
    expect(initial.inputHeight).toBeCloseTo(initial.singleLineHeight, 0)
    await page.screenshot({ path: '.artifacts/screenshots/composer-single-line.png' })
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
      .getByRole('region', { name: '对话', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await expect(input).toHaveValue(wrappedText)
    await expect.poll(async () => (await geometry()).inputHeight).toBe(wideHeight)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page
      .getByRole('region', { name: '对话', exact: true })
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
    await input.fill('等待甲')
    await input.press('Enter')
    await expect(page.getByText('仅属于等待甲的内容', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成' })).toBeEnabled()
    await expect(page.getByRole('combobox', { name: '模型', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    await page
      .getByRole('region', { name: '对话', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await expect(page.getByText('仅属于等待甲的内容', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await input.fill('第二个会话')
    await input.press('Enter')
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
    await expect(page.getByText('仅属于等待甲的内容', { exact: true })).not.toBeVisible()
    await page
      .getByRole('region', { name: '对话', exact: true })
      .getByRole('button', { name: '你好', exact: true })
      .click()
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.getByText('生成已停止', { exact: true })).toBeVisible()
    await expect.poll(() => modelEndpoint?.cancelled).toBeGreaterThan(0)
    await page.reload()
    await page
      .getByRole('region', { name: '对话', exact: true })
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

  test('审批展示固定操作，批准后用完整回答替换中间文本', async ({
    desktop,
    modelEndpoint,
    profile,
  }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('需要审批')
    await input.press('Enter')
    await expect(page.getByRole('heading', { name: '允许 read_file 吗？' })).toBeVisible()
    await expect(page.locator('pre')).toContainText(join(profile, 'fixture.txt'))
    expect(modelEndpoint?.requests.filter((request) => request.lastRole === 'tool')).toHaveLength(0)
    await page.reload()
    await page
      .getByRole('region', { name: '对话', exact: true })
      .getByRole('button', { name: '需要审批', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: '允许 read_file 吗？' })).toBeVisible()
    await page.getByRole('button', { name: '允许本次操作' }).click()
    await expect(page.getByText('已读取测试文件。', { exact: true })).toBeVisible()
    await expect(page.getByText('准备检查文件。', { exact: true })).not.toBeVisible()
    await expect(page.getByRole('button', { name: '允许本次操作' })).not.toBeVisible()
    expect(
      modelEndpoint?.requests.some(
        (request) => request.lastRole === 'tool' && request.text.includes('controlled-file'),
      ),
    ).toBe(true)
    await page.screenshot({ path: '.artifacts/screenshots/conversation-approved.png' })
  })

  test('失败不会当成成功，长消息在小窗口正常换行', async ({ desktop }) => {
    const page = await desktop.firstWindow()
    const input = page.getByRole('textbox', { name: '消息', exact: true })
    await expect(input).toBeEnabled()
    await input.fill('失败')
    await input.press('Enter')
    await expect(page.getByRole('alert')).toContainText(/失败|暂不可用/)
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(860, 620),
    )
    await input.fill('长内容' + 'a'.repeat(3000))
    await input.press('Enter')
    await expect(page.getByText('你好，这是受控回答。', { exact: true })).toBeVisible()
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
      .getByRole('region', { name: '对话', exact: true })
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
      .getByRole('region', { name: '对话', exact: true })
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
    await expect(answer.getByRole('heading', { name: 'Markdown 示例', exact: true })).toBeVisible()
    await expect(answer.locator('strong')).toHaveText('粗体')
    await expect(answer.locator('blockquote')).toContainText('引用内容')
    await expect(answer.locator('li')).toHaveCount(4)
    await expect(answer.locator('ul ul')).toHaveCount(1)
    await expect(answer.locator('code .hljs-keyword').first()).toHaveText('const')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
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
    const sidebar = page.getByRole('region', { name: '对话', exact: true })
    const conversation = sidebar.getByRole('button').first()
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
      answer.locator('script, img, iframe, svg, style, form, [onclick], [onerror]'),
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
