import { expect, test } from '../fixtures/app.fixture'
import { TasksPage } from '../pages/tasks.page'

test.describe('任务侧栏', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 侧栏助手', rules: '负责回答 E2E 问题。' }, locale: 'en-US' })
  })

  test('重命名、标题搜索、全文搜索与分组视图', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 侧栏测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.renameTask('E2E 自动标题', 'E2E-重命名任务')
    await expect(tasks.taskItems.first()).toContainText('E2E-重命名任务')
    await expect(tasks.title).toHaveText('E2E-重命名任务')

    await tasks.searchInput.fill('E2E-重命名')
    await expect(tasks.taskItems).toHaveCount(1)

    await tasks.searchInput.fill('不存在的任务关键字')
    await expect(tasks.taskItems).toHaveCount(0)

    await tasks.searchInput.fill('')
    await expect(tasks.taskItems).toHaveCount(1)

    await tasks.searchContent('E2E 回复')
    await expect(tasks.taskItems).toHaveCount(1, { timeout: 20_000 })

    await tasks.switchTaskView('employee')
    await expect(window.getByText('E2E 侧栏助手').first()).toBeVisible()
    await expect(tasks.taskItems).toHaveCount(1)

    await tasks.switchTaskView('workspace')
    await expect(window.getByText('Default workspace').first()).toBeVisible()
  })

  test('导出对话为 Markdown', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 导出测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    // Electron 下 Playwright 不派发 page download 事件，改为拦截 a[download] 读取 Blob 内容，
    // 依旧走真实的导出处理函数（内容拼装 + Blob 生成）而非复制一份导出逻辑。
    await window.evaluate(() => {
      const w = window as any
      w.__waExported = []
      const originalClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.download) {
          fetch(this.href)
            .then((res) => res.text())
            .then((text) => w.__waExported.push({ name: this.download, text }))
            .catch(() => {})
          return
        }
        return originalClick.call(this)
      }
    })

    await tasks.exportTask('E2E 自动标题')
    await expect.poll(
      () => window.evaluate(() => (window as any).__waExported?.[0]?.name as string | undefined),
      { timeout: 10_000 },
    ).toContain('conversation-')

    const content = await window.evaluate(() => (window as any).__waExported?.[0]?.text as string)
    expect(content).toContain('请回复 E2E 导出测试')
    expect(content).toContain('E2E 回复')
  })

  test('通过右键菜单删除任务', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复 E2E 删除测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()
    await tasks.renameTask('E2E 自动标题', 'E2E-待删除任务')

    await tasks.deleteTaskViaContextMenu('E2E-待删除任务')

    await expect(tasks.taskItems).toHaveCount(0, { timeout: 20_000 })
    await expect(tasks.title).toHaveText('New Task')
  })

  test('多选批量删除任务', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('第一个任务 E2E')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.startNewTask()
    await tasks.send('第二个任务 E2E')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()
    await expect(tasks.taskItems).toHaveCount(2)

    await tasks.multiSelectDeleteByIndex([0, 1])

    await expect(tasks.taskItems).toHaveCount(0, { timeout: 20_000 })
  })
})
