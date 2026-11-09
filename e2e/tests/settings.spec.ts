import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'
import { SettingsPage } from '../pages/settings.page'

test.describe('设置中心', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 设置助手' }, locale: 'en-US', theme: 'dark' })
  })

  test('模型供应商：展示、连通性测试', async ({ app }) => {
    const { window } = app
    await new AppShellPage(window).openSettings()
    const settings = new SettingsPage(window)

    await expect(settings.providerRow('E2E Mock Provider')).toBeVisible()
    await settings.testConnection('E2E Mock Provider')
  })

  test('模型供应商：新增与删除', async ({ app }) => {
    const { window, mock } = app
    await new AppShellPage(window).openSettings()
    const settings = new SettingsPage(window)

    await settings.addProvider({
      name: 'E2E 新增供应商',
      baseUrl: mock.baseUrl,
      model: 'e2e-extra-model',
    })
    await expect(settings.providerRow('E2E 新增供应商')).toBeVisible()

    await settings.deleteProvider('E2E 新增供应商')
  })

  test('外观：明暗主题与界面语言持久化', async ({ app }) => {
    const { window } = app
    const shell = new AppShellPage(window)
    await shell.openSettings()
    const settings = new SettingsPage(window)

    await settings.openTab('appearance', /Appearance/)
    await settings.setTheme('Light')
    await shell.expectTheme('light')

    await settings.setLanguage('中文')
    await expect(window.locator('html')).toHaveAttribute('data-locale', 'zh-CN')

    await window.reload({ waitUntil: 'domcontentloaded' })
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 30_000 })
    await expect(window.locator('html')).toHaveAttribute('data-locale', 'zh-CN', { timeout: 30_000 })
  })

  test('插件管理：停用与重新启用插件', async ({ app }) => {
    const { window } = app
    await new AppShellPage(window).openSettings()
    const settings = new SettingsPage(window)

    await settings.openTab('plugins', /Plugins/)
    const card = settings.pluginCard('notes')
    await expect(card).toBeVisible()

    await settings.togglePlugin('notes', false)
    await expect(card).toContainText('Disabled', { timeout: 20_000 })

    await settings.togglePlugin('notes', true)
    await expect(card).toContainText(/Running|Active/, { timeout: 20_000 })
  })

  test('通用设置：重新运行新用户引导', async ({ app }) => {
    const { window } = app
    await new AppShellPage(window).openSettings()
    const settings = new SettingsPage(window)

    await settings.openTab('general', /General/)
    await window.getByTestId('settings-rerun-onboarding').click()

    await expect(window.getByTestId('onboarding-next')).toBeVisible()
    await expect(window.getByText('Model Service Ready')).toBeVisible()
  })
})
