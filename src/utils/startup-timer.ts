/**
 * 渲染进程启动计时：performance.now() 以页面导航开始为 0，
 * 累计值 ≈ 导航开始至今（含 preload、入口模块下载与执行）。
 * 日志经 console 转发写入主进程日志文件，与主进程 [Startup] 日志按时间戳对齐。
 */
const originElapsedMs = performance.now()
let lastMarkElapsedMs = originElapsedMs

export function startupMark(stage: string, detail?: string): void {
  const now = performance.now()
  const delta = now - lastMarkElapsedMs
  lastMarkElapsedMs = now
  const parts = [`Δ${delta.toFixed(0)}ms`, `累计${now.toFixed(0)}ms`]
  if (detail) parts.push(detail)
  console.info(`[Startup] ${stage} | ${parts.join(' | ')}`)
}
