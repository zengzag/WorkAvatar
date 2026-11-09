import { expect, type Page } from '@playwright/test'

/** 等待应用壳层（侧边导航或引导页）渲染完成 */
export async function waitForAppBoot(page: Page): Promise<void> {
  await page.waitForSelector('#root', { state: 'attached', timeout: 60_000 })
  await expect(page.locator('#boot-splash')).toHaveCount(0, { timeout: 60_000 })
}

/** 等待左侧导航可用（非引导页） */
export async function waitForShell(page: Page): Promise<void> {
  await waitForAppBoot(page)
  await expect(page.locator('[data-nav-key="tasks"]')).toBeVisible({ timeout: 30_000 })
}

export async function gotoRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((target) => { window.location.hash = target }, hash)
}
