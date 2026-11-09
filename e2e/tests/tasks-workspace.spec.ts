import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures/app.fixture'
import { TasksPage } from '../pages/tasks.page'

async function latestWorkspacePath(window: any): Promise<string> {
  const conversations = await window.evaluate(async () => {
    const api = (window as any).electronAPI
    return api.conversation.listAll({ limit: 1 })
  })
  return conversations[0].workspace_path as string
}

test.describe('任务工作区与权限', () => {
  test.beforeEach(async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 工作区助手', rules: '负责写入与执行 E2E 任务。' }, locale: 'en-US' })
  })

  test('工作区内写入后可在文件树预览产物', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[tool:file_write_local]] 写入工作区产物')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.openWorkspacePanel()
    await tasks.openWorkspaceFiles()

    const file = window.locator('[data-testid="workspace-file"]').filter({ hasText: 'e2e-artifact.txt' }).first()
    await expect(file).toBeVisible({ timeout: 20_000 })
    await file.click()

    await expect(window.getByText('E2E-ARTIFACT-CONTENT').first()).toBeVisible({ timeout: 20_000 })
  })

  test('工作区外写入需确认，允许后落盘', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[tool:file_write]] 写入工作区外文件')
    await expect(tasks.interactionCard).toBeVisible({ timeout: 30_000 })
    await expect(tasks.interactionCard).toContainText('e2e-permission.txt')

    await tasks.approveOnce()
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    const workspacePath = await latestWorkspacePath(window)
    const target = path.resolve(workspacePath, '../e2e-permission.txt')
    await expect.poll(() => fs.existsSync(target), { timeout: 20_000 }).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe('E2E-PERMISSION-CONTENT')
  })

  test('拒绝授权时工具返回错误且不落盘', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('[[tool:file_write]] 请求被拒绝的写入')
    await expect(tasks.interactionCard).toBeVisible({ timeout: 30_000 })
    await tasks.rejectInteraction()
    await tasks.waitForIdle()

    await expect(tasks.toolCallSegments('file_write')).toHaveAttribute('data-status', 'error')
    const workspacePath = await latestWorkspacePath(window)
    expect(fs.existsSync(path.resolve(workspacePath, '../e2e-permission.txt'))).toBe(false)
  })

  test('完全允许模式下同类写入不再弹确认', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.selectExecutionMode('fullAllow')
    await tasks.send('[[tool:file_write]] 完全允许模式写入')
    await tasks.waitForReplyContains('E2E 回复', 45_000)
    await tasks.waitForIdle()

    await expect(tasks.interactionCard).toHaveCount(0)
    const workspacePath = await latestWorkspacePath(window)
    const target = path.resolve(workspacePath, '../e2e-permission.txt')
    await expect.poll(() => fs.existsSync(target), { timeout: 20_000 }).toBe(true)
  })

  test('工作区终端执行命令并展示输出', async ({ app }) => {
    const { window } = app
    const tasks = new TasksPage(window)
    await tasks.expectReady()

    await tasks.send('准备终端 E2E')
    await tasks.waitForReplyContains('E2E 回复')
    await tasks.waitForIdle()

    await tasks.openWorkspacePanel()
    await tasks.openWorkspaceTerminal()
    await tasks.runTerminalCommand('echo E2E-TERMINAL')

    await expect(window.locator('.xterm-rows')).toContainText('E2E-TERMINAL', { timeout: 20_000 })
  })
})
