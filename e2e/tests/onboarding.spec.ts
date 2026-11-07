import { expect, test } from '../fixtures/app.fixture'
import { OnboardingPage } from '../pages/onboarding.page'

test.describe('新用户引导', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ onboarded: false, provider: false, locale: 'en-US', theme: 'light' })
  })

  test('完成模型配置与员工创建后进入任务页', async ({ app }) => {
    const { window } = app
    const onboarding = new OnboardingPage(window)

    await onboarding.expectStepModel()
    await onboarding.chooseProviderType('OpenAI Compatible API')
    await onboarding.fillModelForm({ baseUrl: app.mock.baseUrl, model: 'e2e-model' })
    await onboarding.saveAndTest()

    await expect(window.getByText('Model Service Ready')).toBeVisible({ timeout: 30_000 })

    await onboarding.goNext()
    await onboarding.fillEmployee({ name: '引导员工', rules: '你负责整理会议纪要。' })
    await onboarding.createEmployee()

    await expect(window.getByTestId('onboarding-start')).toBeVisible({ timeout: 30_000 })
    await onboarding.start()

    await expect(window.getByTestId('chat-employee-trigger')).toContainText('引导员工', { timeout: 30_000 })
    await expect(window.getByTestId('chat-input-editor')).toBeVisible()
    expect(app.mock.requests.some((request) => request.path.includes('/models'))).toBe(true)
  })

  test('必填校验：未填写模型时阻止提交', async ({ app }) => {
    const onboarding = new OnboardingPage(app.window)
    await onboarding.expectStepModel()

    await onboarding.saveAndTest()

    await expect(app.window.getByText('Please enter a model name')).toBeVisible()
  })

  test('异常场景：不可达的服务地址给出失败提示并保留已填内容', async ({ app }) => {
    const { window } = app
    const onboarding = new OnboardingPage(window)

    await onboarding.chooseProviderType('OpenAI Compatible API')
    await onboarding.fillModelForm({ baseUrl: 'http://127.0.0.1:1/v1', model: 'unreachable-model' })
    await onboarding.saveAndTest()

    await expect(window.getByText('Save or connection failed')).toBeVisible({ timeout: 30_000 })
    await expect(window.locator('#model')).toHaveValue('unreachable-model')
    await expect(window.locator('#base_url')).toHaveValue('http://127.0.0.1:1/v1')
  })

  test('跳过引导后直接进入任务页', async ({ app }) => {
    const { window } = app
    await window.getByTestId('onboarding-skip').click()

    await expect(window.getByTestId('task-sidebar')).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId('chat-input-editor')).toBeVisible()
  })
})
