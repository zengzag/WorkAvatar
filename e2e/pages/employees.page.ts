import { expect, type Locator, type Page } from '@playwright/test'

/** 数字员工库 */
export class EmployeesPage {
  constructor(readonly page: Page) {}

  get cards(): Locator { return this.page.getByTestId('employee-card') }
  get searchInput(): Locator { return this.page.getByTestId('employee-search') }
  get createButton(): Locator { return this.page.getByTestId('employee-create') }
  get emptyCreateButton(): Locator { return this.page.getByTestId('employee-create-empty') }

  cardByName(name: string): Locator {
    return this.cards.filter({ hasText: name }).first()
  }

  async search(keyword: string): Promise<void> {
    await this.searchInput.fill(keyword)
  }

  async clearSearch(): Promise<void> {
    await this.searchInput.fill('')
  }

  async openCreateWizard(): Promise<void> {
    if (await this.createButton.isVisible().catch(() => false)) {
      await this.createButton.click()
    } else {
      await this.emptyCreateButton.click()
    }
    await expect(this.page.getByTestId('wizard-quick-create')).toBeVisible()
  }

  async quickCreate(): Promise<void> {
    await this.openCreateWizard()
    await this.page.getByTestId('wizard-quick-create').click()
    await expect(this.createButton).toBeVisible()
  }

  async openSettings(name: string): Promise<void> {
    await this.cardByName(name).click()
    await expect(this.page.locator('.employee-settings-drawer')).toBeVisible()
  }

  /** 卡片右键菜单（…）里的删除入口 */
  async deleteByName(name: string): Promise<void> {
    const card = this.cardByName(name)
    await card.hover()
    await card.locator('.emp-card-actions button, button').last().click()
    await this.page.getByRole('menuitem', { name: /Delete/ }).click()
    await this.page.locator('.ant-modal-confirm').getByRole('button', { name: /Delete/ }).click()
    await expect(this.page.locator('.ant-modal-confirm')).toHaveCount(0, { timeout: 15_000 })
  }
}
