import { expect, test } from '../fixtures/app.fixture'
import { AppShellPage } from '../pages/app-shell.page'
import { EmployeesPage } from '../pages/employees.page'

test.describe('数字员工管理', () => {
  test('列表展示、按关键字过滤与清空搜索', async ({ app }) => {
    await app.seed({
      employee: { name: 'E2E-Alpha', rules: '负责 Alpha 业务。' },
      locale: 'en-US',
    })
    const { window } = app
    const shell = new AppShellPage(window)
    const employees = new EmployeesPage(window)

    await shell.openEmployees()
    await expect(employees.cardByName('E2E-Alpha')).toBeVisible()

    await employees.search('E2E-Alpha')
    await expect(employees.cards.filter({ hasText: 'E2E-Alpha' })).toHaveCount(1)

    await employees.search('不存在的员工关键字')
    await expect(employees.cards).toHaveCount(0)

    await employees.clearSearch()
    await expect(employees.cardByName('E2E-Alpha')).toBeVisible()
  })

  test('通过创建向导快速创建员工', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E-Beta', rules: '负责 Beta 业务。' }, locale: 'en-US' })
    const { window } = app
    const shell = new AppShellPage(window)
    const employees = new EmployeesPage(window)

    await shell.openEmployees()
    const before = await employees.cards.count()

    await employees.quickCreate()

    await expect.poll(async () => employees.cards.count(), { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(employees.cardByName('New Employee')).toBeVisible()
  })

  test('编辑员工名称后列表即时刷新', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E-Gamma', rules: '负责 Gamma 业务。' }, locale: 'en-US' })
    const { window } = app
    const shell = new AppShellPage(window)
    const employees = new EmployeesPage(window)

    await shell.openEmployees()
    await employees.openSettings('E2E-Gamma')

    const drawer = window.locator('.employee-settings-drawer')
    await drawer.getByTestId('employee-settings-name').fill('E2E-Gamma-已改名')
    await drawer.getByTestId('employee-settings-save').click()

    await expect(employees.cardByName('E2E-Gamma-已改名')).toBeVisible({ timeout: 20_000 })
  })

  test('删除员工后从列表移除', async ({ app }) => {
    await app.seed({ employee: { name: 'E2E-Delta', rules: '负责 Delta 业务。' }, locale: 'en-US' })
    const { window } = app
    const shell = new AppShellPage(window)
    const employees = new EmployeesPage(window)

    await shell.openEmployees()
    await expect(employees.cardByName('E2E-Delta')).toBeVisible()

    await employees.deleteByName('E2E-Delta')

    await expect(employees.cardByName('E2E-Delta')).toHaveCount(0, { timeout: 20_000 })
  })
})
