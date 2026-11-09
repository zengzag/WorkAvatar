import { expect, type Locator, type Page } from '@playwright/test'

/** 设置页（左侧 Tab + 内容区） */
export class SettingsPage {
  constructor(readonly page: Page) {}

  async openTab(key: string, fallbackLabel: RegExp): Promise<void> {
    const tab = this.page.locator(`.settings-tabs .ant-tabs-tab[data-node-key="${key}"]`)
    if (await tab.count()) {
      await tab.click()
    } else {
      await this.page.getByRole('tab', { name: fallbackLabel }).click()
    }
  }

  // ---- LLM 供应商 ----
  get providerRows(): Locator { return this.page.getByTestId('llm-provider-row') }
  get addProviderButton(): Locator { return this.page.getByTestId('settings-add-provider') }

  providerRow(name: string): Locator {
    return this.providerRows.filter({ hasText: name }).first()
  }

  async addProvider(input: { name: string; baseUrl: string; model: string }): Promise<void> {
    await this.addProviderButton.click()
    const modal = this.page.getByRole('dialog', { name: /Add LLM Provider/ })
    await expect(modal).toBeVisible()

    await modal.locator('#name').fill(input.name)
    await modal.locator('#base_url').fill(input.baseUrl)
    await modal.locator('#api_key').fill('e2e-key')

    await modal.getByRole('button', { name: /Add Model/ }).click()
    const modelModal = this.page.getByRole('dialog', { name: 'Add Model', exact: true })
    await expect(modelModal).toBeVisible()
    await modelModal.locator('#name').fill(input.model)
    await modelModal.locator('#model').fill(input.model)
    await modelModal.getByRole('button', { name: /^(OK|Save)$/ }).click()
    await expect(modelModal).toHaveCount(0)

    await modal.getByRole('button', { name: /^(OK|Save)$/ }).click()
    await expect(this.providerRow(input.name)).toBeVisible()
  }

  async testConnection(providerName: string): Promise<void> {
    await this.providerRow(providerName).getByRole('button', { name: /Test/ }).click()
    await expect(this.page.locator('.ant-message').last()).toContainText(/Connection successful/, { timeout: 20_000 })
  }

  async deleteProvider(providerName: string): Promise<void> {
    const row = this.providerRow(providerName)
    await row.locator('button.ant-btn-dangerous').click()
    await this.page.locator('.ant-popover:visible').getByRole('button', { name: /^(OK|Yes)$/ }).click()
    await expect(this.providerRow(providerName)).toHaveCount(0)
  }

  // ---- 外观 ----
  async setTheme(theme: 'Light' | 'Dark' | 'System'): Promise<void> {
    await this.page.getByTestId('settings-theme-mode').getByText(theme, { exact: true }).click()
  }

  async setLanguage(locale: '中文' | 'English'): Promise<void> {
    await this.page.getByTestId('settings-locale').getByText(locale, { exact: true }).click()
  }

  async setFontSize(level: 'Small' | 'Medium' | 'Large' | 'Extra Large'): Promise<void> {
    await this.page.getByTestId('settings-font-size').getByText(level, { exact: true }).click()
  }

  // ---- 插件 ----
  get pluginCards(): Locator { return this.page.getByTestId('plugin-card') }

  pluginCard(pluginId: string): Locator {
    return this.page.locator(`[data-testid="plugin-card"][data-plugin-id="${pluginId}"]`)
  }

  async togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
    const card = this.pluginCard(pluginId)
    await expect(card).toBeVisible()
    const toggle = card.getByTestId('plugin-toggle')
    if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) {
      await toggle.click()
    }
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
  }
}
