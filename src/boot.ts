/**
 * 渲染进程启动垫片：先让 index.html 的静态启动骨架完成首帧，再加载应用入口。
 * 入口 bundle（antd + 业务代码）的解析/执行是同步长任务，会阻塞首帧；
 * 直接静态加载时窗口要等 JS 跑完才第一次绘制。
 */
function loadApp(): void {
  void import('./main').catch((err) => {
    console.error('[Startup] 应用入口加载失败:', err)
  })
}

let started = false
function start(): void {
  if (started) return
  started = true
  loadApp()
}

requestAnimationFrame(() => requestAnimationFrame(start))
// 窗口尚未显示时 rAF 可能被节流，定时器兜底
setTimeout(start, 500)
