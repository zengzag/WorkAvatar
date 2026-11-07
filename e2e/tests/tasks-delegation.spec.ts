import { expect, test } from '../fixtures/app.fixture'
import { TasksPage } from '../pages/tasks.page'

test.describe('任务委派与子任务', () => {
  test('主管委派子员工后展示委托卡与子任务详情', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 主管', rules: '负责拆解并委派任务。' }, locale: 'en-US' })
    const { window } = app

    const subEmployee = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      return api.employee.create({
        name: 'E2E 子员工',
        description: '负责执行 E2E 子任务',
        rules: '你是 E2E 子员工，只负责完成被委派的子任务。',
        profile_json: '',
      })
    }) as { id: string; name: string }

    const tasks = new TasksPage(window)
    await tasks.expectReady()
    await tasks.selectEmployeeByName('E2E 主管')

    await tasks.send(`[[tool:delegate:${subEmployee.id}]] 请把子任务交给子员工`)
    await tasks.waitForReplyContains('E2E 回复', 90_000)
    await tasks.waitForIdle()

    const delegation = tasks.delegationSegments.first()
    await expect(delegation).toBeVisible({ timeout: 30_000 })
    await expect(delegation).toHaveAttribute('data-target', 'E2E 子员工')
    await expect(delegation).toHaveAttribute('data-status', 'completed')

    await delegation.click()
    await expect(delegation).toContainText('E2E 回复')

    await tasks.lastAssistant().getByTestId('message-delegation-drawer').click()
    const drawer = window.locator('.subtask-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('E2E 子员工')
  })
})
