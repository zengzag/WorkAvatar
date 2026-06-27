import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'

const logger = createLogger('IPC')

/**
 * 安全执行 IPC handler，捕获错误并返回可序列化的结果。
 * 成功时返回原始结果；失败时返回 { error: string }。
 * 深度净化确保返回值只包含可结构化克隆的简单类型。
 */
export function safeHandle(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await handler(...args)
      // 深度净化：确保返回值只包含可结构化克隆的简单类型
      return JSON.parse(JSON.stringify(result))
    } catch (err: any) {
      logger.error(`IPC handler error [${channel}]:`, err?.message || err)
      // 返回纯字符串错误信息，避免 Error 对象不可克隆
      return { error: String(err?.message || err) }
    }
  })
}
