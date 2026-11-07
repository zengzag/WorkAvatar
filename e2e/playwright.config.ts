import { defineConfig } from '@playwright/test'

/**
 * WorkAvatar UI 端到端测试配置。
 *
 * 运行前置：npm run build:e2e（主进程 + 渲染端 + 插件产物）
 * 运行：    npm run test:e2e
 * 报告：    npm run test:e2e:report
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: './support/global-setup.ts',

  // Electron 单实例锁与原生模块（sqlite / onnx）不适合并发，默认串行。
  // 需要提速时按 worker 拆 dataDir 后调大 workers。
  workers: 1,
  fullyParallel: false,

  timeout: 120_000,
  expect: { timeout: 15_000 },

  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'report/html', open: 'never' }],
    ['json', { outputFile: 'report/results.json' }],
    ['junit', { outputFile: 'report/junit.xml' }],
  ],

  outputDir: 'report/test-results',

  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'electron' }],
})
