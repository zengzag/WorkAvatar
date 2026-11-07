import { expect, test } from '../fixtures/app.fixture'

test.describe('应用启动', () => {
  test('首次启动进入新用户引导', async ({ app }) => {
    await app.seed({ onboarded: false, provider: false })

    await expect(app.window.getByTestId('onboarding-save-test')).toBeVisible()
    await expect(app.window.getByTestId('onboarding-skip')).toBeVisible()
  })

  test('已完成引导且存在员工时进入任务页', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 启动助手' } })

    await expect(app.window.getByTestId('task-sidebar')).toBeVisible()
    await expect(app.window.getByTestId('chat-input-editor')).toBeVisible()
  })
})

test.describe('最小对话闭环', () => {
  test('发送消息后渲染流式回复并落库为消息', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 对话助手' } })
    const { window, mock } = app

    const editor = window.getByTestId('chat-input-editor')
    await expect(editor).toBeVisible()
    await editor.fill('你好，请回复 E2E')

    await window.getByTestId('chat-send').click()

    const assistant = window.locator('[data-testid="message-bubble"][data-role="assistant"]')
    await expect(assistant.first()).toContainText('E2E 回复', { timeout: 30_000 })

    expect(mock.requests.length).toBeGreaterThan(0)
    expect(mock.requests[0].body.model).toBe('e2e-model')
  })
})
