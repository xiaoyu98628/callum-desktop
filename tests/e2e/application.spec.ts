import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

const test = base.extend<{ desktop: ElectronApplication }>({
  desktop: async ({ playwright }, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'callum-desktop-e2e-'))
    let application: ElectronApplication | undefined
    try {
      application = await playwright._electron.launch({
        args: [projectRoot],
        env: { ...process.env, CALLUM_USER_DATA_DIR: profile },
      })
      await use(application)
    } finally {
      try {
        await application?.close()
      } finally {
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
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
  expect(bridge.methods).toEqual(['getAppInfo'])
  expect(bridge.info.name).toBe('Callum')
  expect(bridge.info.version).toBe('0.1.0')
  expect(await desktop.evaluate(({ app }) => app.getPath('userData'))).toContain(
    'callum-desktop-e2e-',
  )
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
  await expect(page.getByText('对话功能尚未开放，暂不可发送消息。')).toBeVisible()

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
