import { expect, type Page } from '@playwright/test'

/** 新用户引导：模型配置 → 创建员工 → 完成 */
export class OnboardingPage {
  constructor(readonly page: Page) {}

  async expectStepModel(): Promise<void> {
    await expect(this.page.getByTestId('onboarding-save-test')).toBeVisible()
  }

  async chooseProviderType(label: string): Promise<void> {
    await this.page.locator('#provider_type').click()
    // 下拉列表为虚拟滚动，直接按文本查找会因选项未渲染而失败；用 showSearch 过滤后再选
    await this.page.keyboard.type(label)
    const option = this.page.locator('.ant-select-dropdown:visible .ant-select-item-option:visible').filter({ hasText: label }).first()
    await expect(option).toBeVisible()
    await option.click()
  }

  async fillModelForm(input: { baseUrl: string; model: string; apiKey?: string }): Promise<void> {
    await this.page.locator('#api_key').fill(input.apiKey || 'e2e-key')
    await this.page.locator('#base_url').fill(input.baseUrl)
    await this.page.locator('#model').fill(input.model)
  }

  async saveAndTest(): Promise<void> {
    await this.page.getByTestId('onboarding-save-test').click()
  }

  async goNext(): Promise<void> {
    await this.page.getByTestId('onboarding-next').click()
  }

  async fillEmployee(input: { name: string; rules: string }): Promise<void> {
    await this.page.locator('#name').fill(input.name)
    await this.page.locator('#rules').fill(input.rules)
  }

  async createEmployee(): Promise<void> {
    await this.page.getByTestId('onboarding-create-employee').click()
  }

  async start(): Promise<void> {
    await this.page.getByTestId('onboarding-start').click()
  }
}
