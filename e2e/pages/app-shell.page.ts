import { expect, type Page } from '@playwright/test'

/** 应用外壳：左侧导航 + 路由切换 */
export class AppShellPage {
  constructor(readonly page: Page) {}

  private nav(key: string) {
    return this.page.locator(`[data-nav-key="${key}"]`)
  }

  async openTasks(): Promise<void> {
    await this.nav('tasks').click()
    await expect(this.page.getByTestId('task-sidebar')).toBeVisible()
  }

  async openEmployees(): Promise<void> {
    await this.nav('employees').click()
    await expect(this.page.getByTestId('employee-create')).toBeVisible()
  }

  async openKms(): Promise<void> {
    await this.nav('kms').click()
    await expect(this.page.getByTestId('kms-search-input')).toBeVisible()
  }

  async openSettings(): Promise<void> {
    await this.nav('settings').click()
    await expect(this.page.locator('.settings-tabs')).toBeVisible()
  }

  async openPluginRoute(pluginId: string): Promise<void> {
    await this.page.evaluate((id) => { window.location.hash = `#/plugin/${id}` }, pluginId)
  }

  async goto(hash: string): Promise<void> {
    await this.page.evaluate((target) => { window.location.hash = target }, hash)
  }

  async expectTheme(theme: 'light' | 'dark'): Promise<void> {
    await expect(this.page.locator('html')).toHaveAttribute('data-theme', theme)
  }
}
