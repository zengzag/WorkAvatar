import { expect, test } from '../fixtures/app.fixture'
import { waitForShell } from '../support/waits'
import { TasksPage } from '../pages/tasks.page'

test.describe('任务对话工作台', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 任务助手', rules: '你负责回答 E2E 测试问题。' }, locale: 'en-US' })
  })

  test('发送消息 → 流式回复 → 会话出现在任务列表并可回看', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('请回复：第一条 E2E 消息')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await expect(tasks.userMessages.last()).toContainText('第一条 E2E 消息')
    await expect(tasks.taskItems).toHaveCount(1, { timeout: 20_000 })

    await window.reload({ waitUntil: 'domcontentloaded' })
    await waitForShell(window)
    const restored = new TasksPage(window)
    await expect(restored.taskItems).toHaveCount(1, { timeout: 30_000 })

    await restored.taskItems.first().click()
    await expect(restored.userMessages.last()).toContainText('第一条 E2E 消息', { timeout: 30_000 })
    await expect(restored.assistantMessages.last()).toContainText('E2E 回复')
  })

  test('停止生成：中断慢速输出并标记为已中断', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[slow-stream]] 请慢慢输出一段内容')
    await expect(tasks.stopButton).toBeVisible()
    await expect(tasks.assistantMessages.last()).toContainText('E2E', { timeout: 30_000 })

    await tasks.stopButton.click()

    await expect(tasks.stopButton).toHaveCount(0, { timeout: 20_000 })
    await expect(window.getByText('Interrupted', { exact: true })).toBeVisible()
  })

  test('回复中发送消息进入队列，并在结束后自动续发', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[slow-stream]] 第一条慢消息')
    await expect(tasks.stopButton).toBeVisible()

    await tasks.send('第二条排队消息')
    await expect(tasks.queue).toBeVisible()
    await expect(tasks.queue).toContainText('Queued messages (1)')

    await expect(tasks.queue).toHaveCount(0, { timeout: 30_000 })
    await expect(tasks.userMessages).toHaveCount(2, { timeout: 30_000 })
    await expect(tasks.assistantMessages).toHaveCount(2, { timeout: 45_000 })
    await expect(tasks.userMessages.last()).toContainText('第二条排队消息')
    await expect(tasks.assistantMessages.last()).toContainText('E2E 回复', { timeout: 45_000 })
  })

  test('工具调用：执行 file_list 并展示工具调用段', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[tool:file_list]] 请列出当前工作区文件')
    await tasks.waitForReplyContains('E2E 回复')
    await expect(tasks.toolCallSegments('file_list')).toHaveCount(1)
    await tasks.waitForIdle()

    const toolResults = app.mock.requests
      .flatMap((request) => request.body?.messages ?? [])
      .filter((message: any) => message.role === 'tool' || message.role === 'toolResult')
    expect(toolResults.length).toBeGreaterThan(0)
  })

  test('异常场景：模型失败后原地重试成功', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    app.mock.failNext(1)
    await tasks.send('请回复一条可重试的消息')

    const retry = window.getByTestId('message-retry')
    await expect(retry).toBeVisible({ timeout: 45_000 })

    await retry.click()
    await expect(retry).toHaveCount(0, { timeout: 45_000 })
    await expect(tasks.assistantMessages.last()).toContainText('E2E 回复', { timeout: 45_000 })
  })

  test('纯对话模式首次发送后冻结执行模式，且请求不携带工具', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.selectExecutionMode('pureChat')
    await tasks.send('纯对话模式测试')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    // 自动标题同样走流式请求且不带工具，需排除后才校验真实对话请求
    const streamRequest = [...app.mock.requests].reverse().find((request) => request.body?.stream === true
      && !JSON.stringify(request.body?.messages?.[0]?.content || '').includes('title generator'))
    expect(streamRequest).toBeTruthy()
    expect(streamRequest!.body.tools ?? []).toHaveLength(0)

    await tasks.expectModeLocked('manual')
  })

  test('排队消息支持编辑与删除', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[slow-stream]] 排队编辑源消息')
    await expect(tasks.stopButton).toBeVisible()
    await tasks.send('待编辑的排队消息')
    await expect(tasks.queue).toContainText('待编辑的排队消息')

    await tasks.editQueued('已编辑的排队消息')
    await expect(tasks.queue).toContainText('已编辑的排队消息')
    await expect(tasks.queue).not.toContainText('待编辑的排队消息')

    await tasks.deleteQueued()
    await expect(tasks.queue).toHaveCount(0)

    await tasks.waitForIdle()
    await expect(tasks.userMessages).toHaveCount(1)
  })

  test('立即发送排队消息会中断当前回复并优先发送该条', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[slow-stream]] 会被中断的慢消息')
    await expect(tasks.stopButton).toBeVisible()
    await tasks.send('立即发送的排队消息')
    await expect(tasks.queue).toContainText('立即发送的排队消息')

    await tasks.sendQueuedNow()
    await expect(tasks.userMessages.last()).toContainText('立即发送的排队消息', { timeout: 30_000 })
    await expect(tasks.userMessages).toHaveCount(2, { timeout: 30_000 })
    await expect(tasks.assistantMessages.last()).toContainText('E2E 回复', { timeout: 45_000 })
    await tasks.waitForIdle()
  })

  test('多任务之间切换保留各自消息与标题', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('第一个任务的专属内容')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()
    await expect(tasks.taskItems).toHaveCount(1)
    const firstId = await tasks.taskItems.first().getAttribute('data-task-id')

    await tasks.startNewTask()
    await tasks.send('第二个任务的专属内容')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()
    await expect(tasks.taskItems).toHaveCount(2)
    const ids = await tasks.taskItems.evaluateAll((items) => items.map((item) => item.getAttribute('data-task-id')))
    const secondId = ids.find((id) => id !== firstId)

    await tasks.openTaskById(firstId || '')
    await expect(tasks.userMessages.last()).toContainText('第一个任务的专属内容')
    await expect(tasks.userMessages).toHaveCount(1)

    await tasks.openTaskById(secondId || '')
    await expect(tasks.userMessages.last()).toContainText('第二个任务的专属内容')
  })

  test('新建任务时可切换数字员工并归入对应分组', async ({ app }) => {
    const { window } = app
    await window.evaluate(async () => {
      const api = (window as any).electronAPI
      await api.employee.create({
        name: 'E2E 第二员工',
        description: '第二个端到端测试员工',
        rules: '你是第二个 E2E 员工。',
        profile_json: '',
      })
    })

    const tasks = new TasksPage(window)
    await tasks.expectReady()
    await tasks.startNewTask()
    await tasks.selectEmployeeByName('E2E 第二员工')
    await tasks.send('由第二名员工回答 E2E')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.switchTaskView('employee')
    const group = window.getByText('E2E 第二员工').first()
    await expect(group).toBeVisible()
    await expect(tasks.taskItems).toHaveCount(1)
    await expect(tasks.taskItems.first()).toContainText('E2E')
  })

  test('新建任务可选择模型，请求使用所选模型', async ({ app }) => {
    await app.seed({
      employee: { name: 'E2E 任务助手' },
      locale: 'en-US',
      extraProvider: { name: 'E2E Alt Provider', modelId: 'e2e-alt-model' },
    })
    const { window, mock } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.startNewTask()
    await tasks.selectComposerModel('e2e-alt-model')
    await tasks.send('使用备选模型回复 E2E')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    const chatRequest = [...mock.requests].reverse().find((request) => request.body?.stream === true
      && !JSON.stringify(request.body?.messages?.[0]?.content || '').includes('title generator'))
    expect(chatRequest?.body?.model).toBe('e2e-alt-model')
  })
})
