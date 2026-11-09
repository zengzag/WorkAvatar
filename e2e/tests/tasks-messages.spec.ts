import { expect, test } from '../fixtures/app.fixture'
import { TasksPage } from '../pages/tasks.page'

test.describe('任务消息操作', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 消息助手', rules: '负责回答 E2E 问题。' }, locale: 'en-US' })
  })

  test('复制、删除消息，并自动生成任务标题', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 复制测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    // 首条消息后自动标题（Mock 对标题生成请求返回固定标题）
    await expect(tasks.taskItems.first()).toContainText('E2E 自动标题', { timeout: 20_000 })

    await tasks.copyLastAssistant()
    await expect.poll(
      () => app.electronApp.evaluate(({ clipboard }) => clipboard.readText()),
      { timeout: 10_000 },
    ).toContain('E2E 回复')

    await tasks.deleteLastAssistant()
    await expect(tasks.assistantMessages).toHaveCount(0, { timeout: 20_000 })
    await expect(tasks.userMessages).toHaveCount(1)
  })

  test('重新生成产生分支，并可在分支间切换', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 重生成测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.regenerateLastAssistant()
    await expect(tasks.lastAssistant().getByTestId('message-branch-label')).toHaveText('2/2', { timeout: 30_000 })
    await tasks.waitForIdle()
    await expect(tasks.lastAssistant()).toContainText('E2E 回复')

    await tasks.lastAssistant().getByTestId('message-branch-prev').click()
    await expect(tasks.lastAssistant().getByTestId('message-branch-label')).toHaveText('1/2')

    await tasks.lastAssistant().getByTestId('message-branch-next').click()
    await expect(tasks.lastAssistant().getByTestId('message-branch-label')).toHaveText('2/2')
  })

  test('编辑用户消息后重新提交，助手回复基于新内容', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('原始问题 E2E')
    await tasks.waitForReplyContains('原始问题 E2E')
    await tasks.waitForIdle()

    await tasks.editLastUserMessage('修改后的问题 E2E')
    await expect(tasks.userMessages.last()).toContainText('修改后的问题 E2E')
    await expect(tasks.assistantMessages.last()).toContainText('修改后的问题 E2E', { timeout: 30_000 })
    await tasks.waitForIdle()
  })

  test('切换模型重新生成使用新模型', async ({ app }) => {
    await app.seed({
      employee: { name: 'E2E 消息助手' },
      locale: 'en-US',
      extraProvider: { name: 'E2E Alt Provider', modelId: 'e2e-alt-model' },
    })
    const { window, mock } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 切换模型测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.switchModelAndRegenerate('e2e-alt-model')
    await expect(tasks.lastAssistant().getByTestId('message-branch-label')).toHaveText('2/2', { timeout: 30_000 })
    await tasks.waitForIdle()

    await expect.poll(() => {
      const streamRequests = mock.requests.filter((request) => request.body?.stream === true)
      return streamRequests.at(-1)?.body?.model
    }, { timeout: 30_000 }).toBe('e2e-alt-model')
  })

  test('思考过程、Token 用量与上下文占用均可见', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[thinking]] 请展示 E2E 思考过程')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await expect(tasks.lastAssistant().getByTestId('thinking-segment')).toBeVisible()
    await expect(tasks.lastAssistant().getByTestId('token-usage')).toBeVisible()
    await expect(tasks.lastAssistant().getByTestId('context-usage')).toBeVisible()
  })

  test('压缩上下文后追加摘要消息', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 压缩测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()
    await expect(tasks.assistantMessages).toHaveCount(1)

    await tasks.lastAssistant().getByTestId('context-usage').hover()
    const compact = window.getByTestId('context-compact')
    await expect(compact).toBeVisible()
    await compact.click()

    await expect(tasks.assistantMessages).toHaveCount(2, { timeout: 45_000 })
    await expect(tasks.assistantMessages.last()).toContainText('E2E 回复')
  })
})
