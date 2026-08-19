// 主进程数模镜像会话：持有当前模型，应用工具并广播变更

import type { PluginContext } from '../../../plugin-sdk/src'
import type { DataModel } from '../shared/domain'
import { getToolByName, type ToolResult } from '../shared/model-tools'
import { importDbml } from './dbml-service'

export interface ModelChangedPayload {
  model: DataModel
  /** undefined: 不改动 filePath；null: 重置为未保存 */
  filePath?: string | null
}

class ModelSession {
  private current: DataModel | null = null
  private currentFilePath: string | null = null
  private ctx: PluginContext | null = null

  init(ctx: PluginContext): void {
    this.ctx = ctx
  }

  setModel(model: DataModel | null, filePath?: string | null): void {
    this.current = model ? clone(model) : null
    if (filePath !== undefined) this.currentFilePath = filePath
  }

  getModel(): DataModel | null {
    return this.current ? clone(this.current) : null
  }

  getFilePath(): string | null {
    return this.currentFilePath
  }

  applyTool(name: string, args: unknown): { result: ToolResult } {
    const tool = getToolByName(name)
    if (!tool) return { result: { ok: false, error: `未知工具: ${name}` } }
    if (!this.current) {
      return { result: { ok: false, error: '当前无数据模型（请先新建或打开项目）' } }
    }
    try {
      const { model, result } = tool.execute(this.current, args, {
        parseDbml: (dbml, n) => importDbml(dbml, n),
        readFile: (p) => require('fs').readFileSync(p, 'utf-8'),
        writeFile: (p, content) => require('fs').writeFileSync(p, content, 'utf-8')
      })
      this.current = model
      this.broadcast()
      return { result }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { result: { ok: false, error: `工具执行异常: ${msg}` } }
    }
  }

  private broadcast(filePath?: string | null): void {
    if (!this.current || !this.ctx) return
    const payload: ModelChangedPayload = filePath === undefined ? { model: this.current } : { model: this.current, filePath }
    this.ctx.ipc.broadcast('model-changed', payload)
  }
}

function clone<T>(m: T): T {
  return JSON.parse(JSON.stringify(m)) as T
}

export const modelSession = new ModelSession()
