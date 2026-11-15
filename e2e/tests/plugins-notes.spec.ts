import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'

// 1x1 透明 PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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

  test('快速打开、全文搜索与格式工具栏', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 笔记助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('notes')
    await expect(window.getByText('No notes yet. Create your first note')).toBeVisible({ timeout: 30_000 })

    await window.getByTestId('notes-create-inline').click()
    const nameInput = window.getByTestId('notes-inline-name')
    await nameInput.fill('Searchable Note')
    await nameInput.press('Enter')

    const editor = window.locator('.vditor-ir pre.vditor-reset').first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.click()
    await window.keyboard.type('UniqueSearchToken 用于全文检索的唯一内容')
    await window.keyboard.press('Control+s')
    await expect(window.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20_000 })

    // 编辑器精简工具栏可见
    await expect(window.getByTestId('notes-toolbar-bold')).toBeVisible()

    // 快速打开（Ctrl+P）
    await window.keyboard.press('Control+p')
    const searchInput = window.getByTestId('notes-search-input')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('Searchable')
    await expect(window.getByTestId('notes-search-result').first()).toBeVisible({ timeout: 10_000 })
    await searchInput.press('Enter')
    await expect(window.locator('.vditor-ir pre.vditor-reset').first()).toBeVisible()

    // 全文搜索（Ctrl+Shift+F）
    await window.keyboard.press('Control+Shift+F')
    const contentInput = window.getByTestId('notes-search-input')
    await expect(contentInput).toBeVisible()
    await contentInput.fill('UniqueSearchToken')
    const hit = window.getByTestId('notes-search-result').first()
    await expect(hit).toBeVisible({ timeout: 15_000 })
    await hit.click()
    await expect(window.locator('.vditor-ir pre.vditor-reset').first()).toBeVisible()
  })

  test('相对图片通过 app-file 协议正常显示', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 笔记助手' }, locale: 'en-US' })
    const { window } = app
    const dataDir = app.dataDir
    const vault = path.join(dataDir, 'notes')
    fs.mkdirSync(path.join(vault, 'attachments'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'attachments', 'pixel.png'), PNG_1PX)
    fs.writeFileSync(path.join(vault, 'Image Note.md'), '# Image\n\n![pixel](attachments/pixel.png)\n', 'utf-8')

    await new AppShellPage(window).openPluginRoute('notes')
    await expect(window.getByText('Image Note.md').first()).toBeVisible({ timeout: 30_000 })
    await window.getByText('Image Note.md').first().click()

    const image = window.locator('.vditor-ir img').first()
    await expect(image).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const src = await image.getAttribute('src')
    expect(src).toMatch(/^app-file:/)

    // 工具栏图片按钮：选择本地图片后落盘 attachments 并插入
    await window.getByTestId('notes-image-input').setInputFiles({
      name: 'inserted.png',
      mimeType: 'image/png',
      buffer: PNG_1PX,
    })
    const inserted = window.locator('.vditor-ir img').last()
    await expect(inserted).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => inserted.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect(await inserted.getAttribute('src')).toMatch(/attachments\/inserted_/)

    // 阅读模式同样解析相对图片
    await window.getByText('Read', { exact: true }).click()
    const previewImage = window.locator('.notes-preview img').first()
    await expect(previewImage).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => previewImage.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  test('表格插入、浮动工具栏、选中气泡与链接面板', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 笔记助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('notes')
    await window.getByTestId('notes-create-inline').click()
    const nameInput = window.getByTestId('notes-inline-name')
    await nameInput.fill('Editor Features')
    await nameInput.press('Enter')

    const editor = window.locator('.vditor-ir pre.vditor-reset').first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.click()
    await window.keyboard.type('hello world')

    // 选中文本出现浮动格式条，点击加粗
    await window.keyboard.press('Control+a')
    await expect(window.getByTestId('notes-selection-toolbar')).toBeVisible()
    await window.getByTestId('notes-bubble-bold').click()
    await expect(editor.locator('strong').first()).toBeVisible()

    // 插入表格
    await window.getByTestId('notes-toolbar-table').click()
    await expect(window.getByRole('dialog')).toBeVisible()
    await window.getByRole('button', { name: 'OK' }).click()
    const table = editor.locator('table').first()
    await expect(table).toBeVisible()

    // 点击单元格出现表格浮动工具栏，插入行
    await table.locator('td').first().click()
    await expect(window.getByTestId('notes-table-toolbar')).toBeVisible()
    await window.getByTestId('notes-table-row-below').click()
    await expect(editor.locator('table').first().locator('tr')).toHaveCount(4)

    // 末尾单元格 Tab 自动补行
    const lastRow = editor.locator('table').first().locator('tr').last()
    await lastRow.locator('td, th').last().click()
    await window.keyboard.press('Tab')
    await expect(editor.locator('table').first().locator('tr')).toHaveCount(5)

    // Ctrl+K 插入链接
    await editor.click()
    await window.keyboard.press('Control+k')
    await expect(window.getByTestId('notes-link-url')).toBeVisible()
    await window.getByTestId('notes-link-text').fill('Example')
    await window.getByTestId('notes-link-url').fill('example.com')
    await window.getByRole('button', { name: 'OK' }).click()
    await expect(editor).toContainText('Example')
  })

  test('粘贴 URL 覆盖选中文字生成 Markdown 链接', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 笔记助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('notes')
    await window.getByTestId('notes-create-inline').click()
    const nameInput = window.getByTestId('notes-inline-name')
    await nameInput.fill('URL Paste')
    await nameInput.press('Enter')

    const editor = window.locator('.vditor-ir pre.vditor-reset').first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.click()
    await window.keyboard.type('Example Link')
    await window.keyboard.press('Control+a')
    await editor.evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'https://example.com/target')
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }))
    })

    const link = editor.locator('[data-type="a"]').first()
    await expect(link).toBeVisible({ timeout: 10_000 })
    await expect(link).toContainText('Example Link')
    expect(await link.innerHTML()).toContain('example.com/target')
  })

  test('粘贴 TSV 自动生成 Markdown 表格', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 笔记助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openPluginRoute('notes')
    await window.getByTestId('notes-create-inline').click()
    const nameInput = window.getByTestId('notes-inline-name')
    await nameInput.fill('TSV Paste')
    await nameInput.press('Enter')

    const editor = window.locator('.vditor-ir pre.vditor-reset').first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.click()
    await editor.evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Name\tValue\nAlpha\t1\nBeta\t2')
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }))
    })

    const table = editor.locator('table').first()
    await expect(table).toBeVisible({ timeout: 10_000 })
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(table).toContainText('Alpha')
    await expect(table).toContainText('Beta')

    // 表格单元格内继续粘贴 TSV：按单元格填充而不是插入纯文本
    await table.locator('td').first().click()
    await editor.evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Updated\tNew\nX\tY')
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }))
    })
    const updatedTable = editor.locator('table').first()
    await expect(updatedTable).toContainText('Updated')
    await expect(updatedTable).toContainText('New')
    await expect(updatedTable).toContainText('X')

    // 从 Excel/网页复制的 HTML 表格也按单元格贴入
    await updatedTable.locator('td').first().click()
    await editor.evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/html', '<table><tr><td>HtmlA</td><td>HtmlB</td></tr><tr><td>HtmlC</td><td>HtmlD</td></tr></table>')
      data.setData('text/plain', 'HtmlA\tHtmlB\nHtmlC\tHtmlD')
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }))
    })
    await expect(editor.locator('table').first()).toContainText('HtmlA')
    await expect(editor.locator('table').first()).toContainText('HtmlD')
  })
})
