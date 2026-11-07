import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'

test.describe('插件：自动化任务', () => {
  test('创建自动化任务后显示在任务列表', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 自动化助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('automation')
    const newTask = window.getByRole('button', { name: /New Task/ }).first()
    await expect(newTask).toBeVisible({ timeout: 30_000 })

    await newTask.click()
    const modal = window.locator('.ant-modal:visible')
    await modal.locator('#title').fill('E2E 自动化任务')
    await modal.locator('#prompt').fill('输出 E2E 自动化任务执行结果')
    await modal.getByRole('button', { name: /Create/ }).click()

    await expect(modal).toHaveCount(0)
    await expect(window.getByText('E2E 自动化任务').first()).toBeVisible({ timeout: 20_000 })
  })
})
