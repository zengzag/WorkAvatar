import { expect, type Locator, type Page } from '@playwright/test'

/** 任务页（对话工作台） */
export class TasksPage {
  constructor(readonly page: Page) {}

  get editor(): Locator { return this.page.getByTestId('chat-input-editor') }
  get sendButton(): Locator { return this.page.getByTestId('chat-send') }
  get stopButton(): Locator { return this.page.getByTestId('chat-stop') }
  get sidebar(): Locator { return this.page.getByTestId('task-sidebar') }
  get newTaskButton(): Locator { return this.page.getByTestId('task-sidebar-new') }
  get searchInput(): Locator { return this.page.getByTestId('task-sidebar-search').locator('input') }
  get taskItems(): Locator { return this.page.getByTestId('task-item') }
  get assistantMessages(): Locator { return this.page.locator('[data-testid="message-bubble"][data-role="assistant"]') }
  get userMessages(): Locator { return this.page.locator('[data-testid="message-bubble"][data-role="user"]') }
  get title(): Locator { return this.page.getByTestId('task-title') }
  get queue(): Locator { return this.page.getByTestId('chat-queue') }

  async expectReady(): Promise<void> {
    await expect(this.editor).toBeVisible()
  }

  async startNewTask(): Promise<void> {
    if (await this.newTaskButton.isVisible().catch(() => false)) {
      await this.newTaskButton.click()
    }
    await expect(this.editor).toBeVisible()
  }

  async typeMessage(text: string): Promise<void> {
    await this.editor.click()
    await this.editor.fill(text)
    await expect(this.editor).toHaveText(text)
  }

  async send(text: string): Promise<void> {
    await this.typeMessage(text)
    await this.sendButton.click()
  }

  async waitForReplyContains(text: string, timeout = 45_000): Promise<void> {
    await expect(this.assistantMessages.last()).toContainText(text, { timeout })
  }

  async waitForIdle(): Promise<void> {
    await expect(this.stopButton).toHaveCount(0, { timeout: 60_000 })
    await expect(this.assistantMessages.last()).toHaveAttribute('data-streaming', 'false', { timeout: 60_000 })
  }

  async selectExecutionMode(mode: 'pureChat' | 'manual' | 'fullAllow'): Promise<void> {
    const labels = { pureChat: 'Pure Chat', manual: 'Manual Approval', fullAllow: 'Full Allow' }
    await this.page.getByTestId('chat-mode-trigger').click()
    const option = this.page.locator(`[data-testid="chat-mode-option"][data-mode="${mode}"]`)
    await expect(option).toBeVisible()
    await option.click()
    await expect(this.page.getByTestId('chat-mode-trigger')).toContainText(labels[mode])
    await this.page.getByTestId('chat-mode-trigger').click()
  }

  async expectModeLocked(mode: 'pureChat' | 'manual' | 'fullAllow'): Promise<void> {
    await this.page.getByTestId('chat-mode-trigger').click()
    await expect(this.page.locator(`[data-testid="chat-mode-option"][data-mode="${mode}"]`)).toHaveAttribute('data-disabled', 'true')
    await this.page.getByTestId('chat-mode-trigger').click()
  }

  async selectEmployeeByName(name: string): Promise<void> {
    await this.page.getByTestId('chat-employee-trigger').click()
    const option = this.page.getByTestId('chat-employee-option').filter({ hasText: name })
    await expect(option).toBeVisible()
    await option.click()
  }

  async selectComposerModel(modelId: string): Promise<void> {
    await this.page.getByTestId('chat-model-trigger').click()
    await this.page.locator(`[data-testid="chat-model-option"][data-model-id="${modelId}"]`).click()
  }

  async openTaskByTitle(title: string): Promise<void> {
    const item = this.taskItems.filter({ hasText: title }).first()
    await expect(item).toBeVisible()
    await item.click()
  }

  async openTaskById(id: string): Promise<void> {
    const item = this.page.locator(`[data-testid="task-item"][data-task-id="${id}"]`)
    await expect(item).toBeVisible()
    await item.click()
  }

  toolCallSegments(toolName?: string): Locator {
    return toolName
      ? this.page.locator(`[data-testid="tool-call-segment"][data-tool-name="${toolName}"]`)
      : this.page.getByTestId('tool-call-segment')
  }

  // ---- 消息操作 ----
  lastAssistant(): Locator { return this.assistantMessages.last() }
  lastUser(): Locator { return this.userMessages.last() }

  async copyLastAssistant(): Promise<void> {
    const bubble = this.lastAssistant()
    await bubble.hover()
    await bubble.getByTestId('message-copy').click()
  }

  async regenerateLastAssistant(): Promise<void> {
    const bubble = this.lastAssistant()
    await bubble.hover()
    await bubble.getByTestId('message-regenerate').click()
  }

  async switchModelAndRegenerate(modelId: string): Promise<void> {
    const bubble = this.lastAssistant()
    await bubble.hover()
    await bubble.getByTestId('message-switch-model').click()
    await this.page.locator(`[data-testid="message-switch-model-option"][data-model-id="${modelId}"]`).click()
  }

  async editLastUserMessage(newText: string): Promise<void> {
    const bubble = this.lastUser()
    await bubble.hover()
    await bubble.getByTestId('message-edit').click()
    const input = bubble.getByTestId('message-edit-input')
    await input.fill(newText)
    await bubble.getByTestId('message-edit-submit').click()
  }

  async deleteLastAssistant(): Promise<void> {
    const bubble = this.lastAssistant()
    await bubble.hover()
    await bubble.getByTestId('message-delete').click()
    await this.page.locator('.ant-popover:visible').getByRole('button', { name: /Confirm|OK/ }).click()
  }

  // ---- 任务侧栏 ----
  queueAction(name: 'Edit' | 'Delete' | 'Send now'): Locator {
    return this.queue.getByRole('button', { name })
  }

  async editQueued(text: string, index = 0): Promise<void> {
    await this.queueAction('Edit').nth(index).click()
    const textarea = this.queue.locator('textarea')
    await textarea.fill(text)
    await textarea.press('Enter')
  }

  async deleteQueued(index = 0): Promise<void> {
    await this.queueAction('Delete').nth(index).click()
  }

  async sendQueuedNow(index = 0): Promise<void> {
    await this.queueAction('Send now').nth(index).click()
  }

  async openTaskContextMenu(title: string, item: RegExp): Promise<void> {
    const task = this.taskItems.filter({ hasText: title }).first()
    await task.click({ button: 'right' })
    await this.page.getByRole('menuitem', { name: item }).click()
  }

  async renameTask(title: string, newTitle: string): Promise<void> {
    const task = this.taskItems.filter({ hasText: title }).first()
    await task.hover()
    await task.getByTestId('task-rename').click()
    const input = this.page.getByTestId('task-rename-input')
    await input.fill(newTitle)
    await input.press('Enter')
  }

  async deleteTask(title: string): Promise<void> {
    const task = this.taskItems.filter({ hasText: title }).first()
    await task.hover()
    await task.getByTestId('task-delete').click()
    await this.page.getByTestId('task-delete-confirm').click()
  }

  async switchTaskView(view: 'list' | 'employee' | 'workspace'): Promise<void> {
    await this.page.getByTestId('task-sidebar-view').click()
    await this.page.locator(`[data-testid="task-view-option"][data-view="${view}"]`).click()
  }

  async deleteTaskViaContextMenu(title: string): Promise<void> {
    const task = this.taskItems.filter({ hasText: title }).first()
    await task.hover()
    await task.click({ button: 'right' })
    await this.page.getByRole('menuitem', { name: /Delete/ }).click()
    await task.hover()
    await task.getByTestId('task-delete-confirm').click()
  }

  async multiSelectDelete(titles: string[]): Promise<void> {
    await this.page.getByTestId('task-sidebar-view').click()
    await this.page.getByTestId('task-multi-select').click()
    for (const title of titles) {
      await this.taskItems.filter({ hasText: title }).first().click()
    }
    await this.page.getByTestId('task-batch-delete').click()
  }

  async multiSelectDeleteByIndex(indexes: number[]): Promise<void> {
    await this.page.getByTestId('task-sidebar-view').click()
    await this.page.getByTestId('task-multi-select').click()
    for (const index of indexes) {
      await this.taskItems.nth(index).click()
    }
    await this.page.getByTestId('task-batch-delete').click()
  }

  async exportTask(title: string): Promise<void> {
    await this.openTaskContextMenu(title, /Export/)
  }

  async searchContent(keyword: string): Promise<void> {
    await this.searchInput.fill(keyword)
    await this.searchInput.press('Enter')
  }

  // ---- 工作区面板 ----
  async openWorkspacePanel(): Promise<void> {
    await this.page.getByTestId('workspace-panel-toggle').click()
    await expect(this.page.getByTestId('workspace-panel')).toBeVisible()
  }

  async openWorkspaceFiles(): Promise<void> {
    await this.page.getByTestId('workspace-start-files').click()
  }

  async openWorkspaceTerminal(): Promise<void> {
    await this.page.getByTestId('workspace-start-terminal').click()
    await expect(this.page.getByTestId('task-terminal')).toBeVisible()
  }

  async runTerminalCommand(command: string): Promise<void> {
    const terminal = this.page.getByTestId('task-terminal')
    await terminal.click()
    await this.page.keyboard.type(command)
    await this.page.keyboard.press('Enter')
  }

  // ---- 权限确认 / 委托 ----
  get interactionCard(): Locator { return this.page.getByTestId('task-interaction-card') }
  get delegationSegments(): Locator { return this.page.getByTestId('delegation-segment') }

  async approveOnce(): Promise<void> {
    await expect(this.interactionCard).toBeVisible()
    const allow = this.interactionCard.getByTestId('interaction-allow-once')
    if (await allow.count()) await allow.click()
    else await this.interactionCard.getByTestId('interaction-confirm').click()
  }

  async rejectInteraction(): Promise<void> {
    await expect(this.interactionCard).toBeVisible()
    await this.interactionCard.getByTestId('interaction-reject').click()
  }
}
