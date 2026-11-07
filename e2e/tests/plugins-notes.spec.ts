import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'

test.describe('插件：笔记', () => {
  test('创建笔记、编辑内容并保存', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 笔记助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('notes')
    await expect(window.getByText('No notes yet. Create your first note')).toBeVisible({ timeout: 30_000 })

    await window.getByTestId('notes-create-inline').click()
    const nameInput = window.getByTestId('notes-inline-name')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('E2E 笔记')
    await nameInput.press('Enter')

    const editor = window.locator('.vditor-ir pre.vditor-reset').first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.click()
    await window.keyboard.type('E2E-NOTE-CONTENT 笔记正文')

    await window.keyboard.press('Control+s')
    await expect(window.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20_000 })

    await expect(window.getByText('E2E 笔记.md', { exact: true }).first()).toBeVisible()
  })
})
