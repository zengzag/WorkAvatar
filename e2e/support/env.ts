import fs from 'node:fs'
import path from 'node:path'

/** 项目根目录（e2e 目录的上一级） */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/** Electron 主进程产物入口（npm run build:e2e 生成） */
export const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist-electron', 'main', 'index.js')

/** 渲染端构建产物目录 */
export const RENDERER_DIST = path.join(PROJECT_ROOT, 'dist')

export function assertBuiltArtifacts(): void {
  const missing: string[] = []
  if (!fs.existsSync(MAIN_ENTRY)) missing.push(path.relative(PROJECT_ROOT, MAIN_ENTRY))
  if (!fs.existsSync(path.join(RENDERER_DIST, 'index.html'))) {
    missing.push(path.relative(PROJECT_ROOT, path.join(RENDERER_DIST, 'index.html')))
  }
  if (missing.length > 0) {
    throw new Error(
      `缺少 E2E 运行所需的构建产物：${missing.join(', ')}\n` +
      '请先执行 npm run build:e2e（构建主进程、渲染端与插件）。',
    )
  }
}
