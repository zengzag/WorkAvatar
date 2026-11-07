import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'

test.describe('本地资料库（KMS）', () => {
  test('空状态与设置入口可用', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 资料助手' }, locale: 'en-US' })
    const { window } = app

    await new AppShellPage(window).openKms()
    await expect(window.getByTestId('kms-search-input')).toBeVisible()
    await expect(window.getByText('No results found')).toBeVisible()

    await window.getByTestId('kms-settings-open').click()
    const drawer = window.locator('.ant-drawer:visible')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('Index', { exact: true }).first()).toBeVisible()
  })

  test('建立索引后可通过关键词搜索到文档', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E 资料助手' }, locale: 'en-US' })
    const { window } = app

    const docsDir = test.info().outputPath('kms-docs')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(
      path.join(docsDir, 'e2e-kms-doc-1.md'),
      '# 项目说明\n\ne2ekmsunique 是本文件独有的检索关键词。\n',
      'utf-8',
    )

    await window.evaluate(async (dirPath) => {
      const api = (window as any).electronAPI
      await api.kms.addDir({ dirPath, recursive: true })
      await api.kms.buildIndex(undefined, false)
    }, docsDir)

    await expect.poll(async () => {
      const stats = await window.evaluate(async () => {
        const api = (window as any).electronAPI
        return api.kms.getStats()
      })
      return stats?.files?.total ?? 0
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0)

    await new AppShellPage(window).openKms()

    await window.getByTestId('kms-search-mode').click()
    await window.locator('.ant-select-item-option-content').filter({ hasText: 'Keyword' }).first().click()

    await window.getByTestId('kms-search-input').fill('e2ekmsunique')
    await window.getByTestId('kms-search-submit').click()

    await expect(window.getByText('e2e-kms-doc-1.md').first()).toBeVisible({ timeout: 30_000 })
    await expect(window.getByText('e2ekmsunique').first()).toBeVisible()
  })
})
