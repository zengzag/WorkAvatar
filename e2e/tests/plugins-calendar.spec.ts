import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'

test.describe('插件：日历', () => {
  test('新建日程后出现在日历视图中', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 日历助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('calendar')
    await expect(window.getByRole('button', { name: /New Event/ })).toBeVisible({ timeout: 30_000 })

    await window.getByRole('button', { name: /New Event/ }).click()
    const modal = window.locator('.ant-modal:visible')
    await expect(modal).toContainText('New Event')
    await modal.locator('#title').fill('E2E 日历日程')
    await modal.getByRole('button', { name: 'Save' }).click()

    await expect(modal).toHaveCount(0)
    await expect(window.getByText('E2E 日历日程').first()).toBeVisible({ timeout: 20_000 })
  })

  test('新建待办后出现在任务列表', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 日历助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('calendar')
    await expect(window.getByRole('button', { name: /New Task/ })).toBeVisible({ timeout: 30_000 })

    await window.getByRole('button', { name: /New Task/ }).click()
    const modal = window.locator('.ant-modal:visible')
    await modal.locator('#title').fill('E2E 日历待办')
    await modal.getByRole('button', { name: 'Save' }).click()

    await expect(modal).toHaveCount(0)
    await expect(window.getByText('E2E 日历待办').first()).toBeVisible({ timeout: 20_000 })
  })
})
