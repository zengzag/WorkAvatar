/**
 * 渲染进程日志工具：把 console 输出转发到主进程写入日志文件，
 * 保证 release 包中渲染进程的关键日志也能落盘便于排查。
 *
 * - 通过 window.electronAPI.app.log（fire-and-forget IPC）转发，不阻塞 UI
 * - 保留原 console 行为（devtools 仍可见）
 * - 对参数做安全序列化，避免循环引用与不可克隆对象导致 IPC 报错
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function safeStringify(value: unknown): string {
  if (value == null) return String(value)
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(safeStringify).join(' ')
}

function forward(level: LogLevel, args: unknown[]): void {
  try {
    const api = (window as any).electronAPI
    if (!api?.app?.log) return
    const message = formatArgs(args)
    if (!message) return
    api.app.log(level, message)
  } catch {
    // 转发失败不影响渲染进程运行
  }
}

/**
 * 挂载 console 钩子：在保留原 console 行为的同时，把日志转发到主进程文件。
 * 应在应用入口（main.tsx）尽早调用一次。
 */
export function installConsoleForwarder(): void {
  if ((console as any).__forwarderInstalled) return
  ;(console as any).__forwarderInstalled = true

  const origLog = console.log.bind(console)
  const origInfo = console.info.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  const origDebug = console.debug?.bind(console) ?? origLog.bind(console)

  console.log = (...args: unknown[]) => {
    origLog(...args)
    forward('info', args)
  }
  console.info = (...args: unknown[]) => {
    origInfo(...args)
    forward('info', args)
  }
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    forward('warn', args)
  }
  console.error = (...args: unknown[]) => {
    origError(...args)
    forward('error', args)
  }
  console.debug = (...args: unknown[]) => {
    origDebug(...args)
    forward('debug', args)
  }
}
