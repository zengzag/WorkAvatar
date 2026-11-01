import { createLogger } from './logger'

const logger = createLogger('Startup')

/**
 * 主进程启动计时：performance.now() 在 Node/Electron 主进程中以进程启动为 0，
 * 因此累计值即「进程启动至今」，delta 即「距上一阶段」。
 */
const bootElapsedMs = performance.now()
let lastMarkElapsedMs = bootElapsedMs

/** 记录启动阶段耗时（写日志文件），用于定位启动慢的具体环节 */
export function startupMark(stage: string, detail?: string): void {
  const now = performance.now()
  const delta = now - lastMarkElapsedMs
  lastMarkElapsedMs = now
  const parts = [`Δ${delta.toFixed(0)}ms`, `累计${now.toFixed(0)}ms`]
  if (detail) parts.push(detail)
  logger.info(`[Startup] ${stage} | ${parts.join(' | ')}`)
}

/** 主进程模块图加载完成时刻（含 electron 引导与全部 import 求值） */
export const mainBootElapsedMs = bootElapsedMs
