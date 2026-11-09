import fs from 'node:fs'
import { test as base, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'
import { MAIN_ENTRY, PROJECT_ROOT } from '../support/env'
import {
  reloadSeededApplication,
  seedApplication,
  type SeedEmployeeOptions,
  type SeedOptions,
} from '../support/seed'
import { startMockLlmServer, type MockLlmServer } from './mock-llm-server'

export interface SeedAppOptions extends Omit<SeedOptions, 'provider' | 'extraProvider'> {
  /** true（默认）= 自动接入本地 Mock LLM；false = 不创建供应商；对象 = 覆盖 Mock 配置 */
  provider?: boolean | { modelId?: string; name?: string }
  /** 额外的非默认供应商（baseUrl 自动指向 Mock 服务） */
  extraProvider?: { modelId?: string; name?: string } | null
}

export interface WorkAvatarApp {
  electronApp: ElectronApplication
  window: Page
  mock: MockLlmServer
  dataDir: string
  seed: (options?: SeedAppOptions) => Promise<void>
}

interface Fixtures {
  app: WorkAvatarApp
}

/**
 * 每个测试独占一个 Electron 实例与数据目录。
 *
 * Electron 原生模块（sqlite / onnx / 托盘）对并发实例并不友好，因此统一串行执行；
 * 需要并行时按 worker 维度拆分数据目录即可（配置里已保留 workers 扩展点）。
 */
export const test = base.extend<Fixtures>({
  app: async ({}, use, testInfo) => {
    const mock = await startMockLlmServer()
    const dataDir = testInfo.outputPath('user-data')
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(dataDir, { recursive: true })

    const rendererLogs: string[] = []
    let electronApp: ElectronApplication | undefined

    try {
      electronApp = await electron.launch({
        args: [MAIN_ENTRY],
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          WORKAVATAR_E2E: '1',
          WORKAVATAR_DATA_DIR: dataDir,
          ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        },
        timeout: 120_000,
      })

      const window = await electronApp.firstWindow({ timeout: 120_000 })
      window.on('pageerror', (error) => { rendererLogs.push(`[pageerror] ${error.stack || error.message}`) })
      window.on('console', (message) => {
        if (message.type() === 'error') rendererLogs.push(`[console.error] ${message.text()}`)
      })

      await window.waitForLoadState('domcontentloaded')

      const seed = async (options: SeedAppOptions = {}): Promise<void> => {
        const provider = options.provider === false
          ? null
          : {
              baseUrl: mock.baseUrl,
              ...(typeof options.provider === 'object' ? options.provider : {}),
            }
        const extraProvider = options.extraProvider
          ? { ...options.extraProvider, baseUrl: mock.baseUrl }
          : null
        await seedApplication(window, { ...options, provider, extraProvider })
        await reloadSeededApplication(window, options.onboarded === false ? '#/onboarding' : '#/tasks')
        await window.waitForSelector('#root', { state: 'attached', timeout: 60_000 })
      }

      await use({ electronApp, window, mock, dataDir, seed })
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && rendererLogs.length > 0) {
        await testInfo.attach('renderer-log', {
          body: rendererLogs.join('\n'),
          contentType: 'text/plain',
        })
      }
      if (electronApp) {
        await electronApp.close().catch(() => {
          electronApp?.process().kill()
        })
      }
      await mock.close()
    }
  },
})

export { expect }

export type { SeedEmployeeOptions }
