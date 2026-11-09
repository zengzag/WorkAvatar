import { expect, test } from '../fixtures/app.fixture'
import { TasksPage } from '../pages/tasks.page'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

test.describe('任务附件', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 附件助手', rules: '负责分析图片与文件。' }, locale: 'en-US' })
  })

  test('图片附件以多模态消息发送', async ({ app }) => {
    const { window, mock } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.typeMessage('请看这张图片 E2E')
    await window.locator('.wa-composer input[type=file]').setInputFiles({
      name: 'e2e.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    })
    await expect(window.locator('img[alt="e2e.png"]')).toBeVisible()
    await tasks.sendButton.click()

    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    // 自动标题请求也会携带首条用户文本，这里按图片内容定位真正的多模态对话请求
    const streamRequest = [...mock.requests]
      .reverse()
      .find((request) => JSON.stringify(request.body?.messages ?? []).includes('image_url'))
    expect(streamRequest).toBeTruthy()
    const lastUser = [...(streamRequest?.body?.messages ?? [])].reverse().find((message: any) => message.role === 'user')
    const serialized = JSON.stringify(lastUser?.content)
    expect(serialized).toContain('image_url')
    expect(serialized).toContain('data:image/png')
  })

  test('普通文件以路径令牌随消息发送', async ({ app }) => {
    const { window, mock } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.typeMessage('请分析附件 E2E')
    await window.locator('.wa-composer input[type=file]').setInputFiles({
      name: 'e2e-attachment.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# E2E 附件\n\n这是端到端测试附件。', 'utf-8'),
    })
    await expect(tasks.editor).toContainText('e2e-attachment.md')
    await tasks.sendButton.click()

    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await expect(tasks.userMessages.last()).toContainText('e2e-attachment.md')
    const streamRequest = [...mock.requests].reverse().find((request) => request.body?.stream === true)
    expect(JSON.stringify(streamRequest?.body?.messages ?? [])).toContain('e2e-attachment.md')
  })
})
