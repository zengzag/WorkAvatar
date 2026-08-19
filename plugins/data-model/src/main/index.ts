// data-model 插件主进程入口

import type { PluginContext, PluginMainModule } from '../../../plugin-sdk/src'
import { projectStore } from './project-store'
import { modelSession } from './model-session'
import { createDataModelAgentTools } from './agent-tools'
import { importDbml, exportDbml } from './dbml-service'

let ctxRef: PluginContext | null = null
let currentAbort: AbortController | null = null
let unsubscribeEvents: Array<() => void> = []

// 数据模型对话专用系统提示词：指导 agent 使用分层协议编辑当前模型
const DATA_MODEL_SYSTEM_PROMPT = `你是一个数据建模助手，正在帮助用户创建和编辑一个数据模型（ER 图）。

当前数据模型通过分层协议读写（均为按需工具，可先调用 list_available_tools 查看）：
- 读取：get_model_meta（轻量元信息概览，先调用避免全量读取）/ get_model_json（完整结构化 JSON，含布局/索引/枚举引用；tables 参数可只读指定表）
- 写入：set_model_json（完整 JSON 替换/合并）/ patch_model（增量操作：addTable/updateTable/removeTable、addField/updateField/removeField、addRelationship/removeRelationship、addEnum/removeEnum、addIndex/removeIndex）/ import_dbml（DBML 文本导入）/ import_dbml_file（DBML 文件导入）
- 文件：export_model_file（导出完整工程文件）/ import_model_file（从工程文件导入）

工作范式：
1. 开始前先调用 get_model_meta 了解模型现状（表/关系/枚举清单）
2. 需要完整内容时调用 get_model_json 获取结构化 JSON（模型很大时可用 tables 参数只读关心的表，或用 export_model_file 导出文件经文件读写全量内容）
3. 用户描述需求后：局部增删改用 patch_model 增量操作（无需传全量 JSON）；整体重建用 set_model_json（mode=replace）
4. 若用户提供了 DBML/SQL DDL 文本或文件，用 import_dbml / import_dbml_file 导入
5. 每次修改后简要说明做了什么
6. 若用户要求"新建/清空重来"，用 set_model_json 传入全新的 JSON（mode=replace）整体替换

结构化 JSON 是完整交换格式，能表达 DBML 无法承载的布局位置、颜色、索引、枚举引用等。DBML 仅用于兼容用户提供的既有 schema。
命名规范：表名、字段名使用小写 snake_case。主键字段通常为 id (bigint, 自增)。外键字段命名如 user_id。`

function broadcast(event: string, payload?: unknown): void {
  ctxRef?.ipc.broadcast(event, payload)
}

function registerIpc(ctx: PluginContext): void {
  // ====== 项目 ======
  ctx.ipc.handle('project-list', () => projectStore.list())

  ctx.ipc.handle('project-create', (payload: any) => {
    const model = projectStore.createBlank(payload?.name)
    modelSession.setModel(model, null)
    return { model }
  })

  ctx.ipc.handle('project-open', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: '缺少项目 id' }
    const rec = projectStore.get(id)
    if (!rec) return { error: '项目不存在' }
    modelSession.setModel(rec.model, null)
    return { model: rec.model }
  })

  ctx.ipc.handle('project-delete', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: '缺少项目 id' }
    projectStore.delete(id)
    return { ok: true }
  })

  ctx.ipc.handle('project-save', () => {
    const model = modelSession.getModel()
    if (!model) return { error: '当前无数据模型' }
    projectStore.save(model)
    return { ok: true }
  })

  // ====== 模型 ======
  ctx.ipc.handle('model-get', () => ({ model: modelSession.getModel() }))

  ctx.ipc.handle('model-sync', (payload: any) => {
    if (!payload?.model) return { error: '缺少模型' }
    modelSession.setModel(payload.model)
    return { ok: true }
  })

  // ====== DBML ======
  ctx.ipc.handle('dbml-import', (payload: any) => {
    if (!payload?.dbml) return { error: '缺少 DBML 文本' }
    try {
      const model = importDbml(payload.dbml, payload.name ?? 'DBML 导入')
      return { model }
    } catch (e) {
      const err = e as any
      const diag = Array.isArray(err?.diags) && err.diags.length > 0
        ? err.diags.map((d: any) => d.message).join('; ')
        : (err?.message ?? String(e))
      return { error: `DBML 解析失败: ${diag}` }
    }
  })

  ctx.ipc.handle('dbml-export', () => {
    const model = modelSession.getModel()
    if (!model) return { error: '当前无数据模型' }
    return { dbml: exportDbml(model) }
  })

  // ====== 员工 / 供应商（复用宿主数据能力） ======
  ctx.ipc.handle('employees-list', async () => {
    const data = ctx.services.data
    if (!data) return []
    const employees = await data.query('employees')
    return employees
  })

  ctx.ipc.handle('providers-list', async () => {
    const data = ctx.services.data
    if (!data) return []
    const providers = await data.query('llmProviders')
    return providers
  })

  // ====== 设置 ======
  ctx.ipc.handle('settings-get', () => ({ settings: projectStore.getSettings() }))

  ctx.ipc.handle('settings-set', (payload: any) => {
    projectStore.setSettings(payload?.settings ?? {})
    return { ok: true }
  })

  ctx.ipc.handle('data-dir', () => ({ dataDir: ctx.paths.data }))

  ctx.ipc.handle('data-dir-open', () => {
    const { shell } = require('electron')
    shell.openPath(ctx.paths.data)
    return { ok: true }
  })

  // ====== 项目导出 / 导入（.dmv.json 文件） ======
  ctx.ipc.handle('project-export-file', async (payload: any) => {
    const model = payload?.model
    if (!model) return { error: '当前无数据模型' }
    const { dialog } = require('electron')
    const res = await dialog.showSaveDialog({
      title: '导出数据模型',
      defaultPath: `${model.name || 'model'}.dmv.json`,
      filters: [{ name: '数据模型文件', extensions: ['dmv.json', 'json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    const fs = require('fs')
    fs.writeFileSync(res.filePath, JSON.stringify({ version: 1, model, updatedAt: Date.now() }, null, 2), 'utf-8')
    return { ok: true, path: res.filePath }
  })

  ctx.ipc.handle('project-import-file', async () => {
    const { dialog } = require('electron')
    const res = await dialog.showOpenDialog({
      title: '导入数据模型',
      properties: ['openFile'],
      filters: [{ name: '数据模型文件', extensions: ['dmv.json', 'json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { error: '已取消' }
    const fs = require('fs')
    try {
      const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'))
      const model = raw?.model ?? raw
      if (!model?.tables || !model?.id) return { error: '文件格式不正确' }
      projectStore.save(model)
      modelSession.setModel(model, null)
      return { model }
    } catch (e) {
      return { error: `导入失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  // ====== 对话（复用宿主 agent） ======
  ctx.ipc.handle('chat-send', async (payload: any, signal?: AbortSignal) => {
    const execute = ctx.services.execute
    if (!execute) return { error: '宿主未提供 execute 能力' }
    const { employeeId, providerId, modelId, messages, conversationId } = payload ?? {}
    if (!employeeId) return { error: '缺少 employeeId' }
    if (!messages || messages.length === 0) return { error: '缺少 messages' }

    // 解析 provider：显式传入 > 插件默认 > 宿主默认 provider > 首个 provider
    let resolvedProviderId = providerId
    let resolvedModelId = modelId
    if (!resolvedProviderId) {
      const settings = projectStore.getSettings()
      resolvedProviderId = settings.defaultProviderId
      resolvedModelId = resolvedModelId ?? settings.defaultModelId
    }
    if (!resolvedProviderId) {
      const data = ctx.services.data
      if (data) {
        const providers = await data.query('llmProviders') as any[]
        const def = providers.find((p) => p.is_default) ?? providers[0]
        resolvedProviderId = def?.id
        if (!resolvedModelId) resolvedModelId = def?.model
      }
    }
    if (!resolvedProviderId) return { error: 'chat.error.noProvider' }

    const controller = new AbortController()
    currentAbort = controller
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const lastMsg = messages[messages.length - 1]
    const isNewConv = !conversationId

    let acc = ''
    let thought = ''
    let errText = ''

    const persist = async (convId: string, msgs: unknown[]) => {
      const data = ctx.services.data
      if (!data) return
      try {
        await data.mutate('conversations', 'update', {
          id: convId,
          messages_json: JSON.stringify(msgs),
          message_count: msgs.length
        })
      } catch (e) {
        ctx.services.logger.warn('持久化对话消息失败:', e instanceof Error ? e.message : String(e))
      }
    }

    // 新会话先写用户消息（会话 id 由宿主生成，需在 execute 返回后补写）
    let lastConvId: string | null = isNewConv ? null : conversationId

    try {
      const result = await execute.execute(
        {
          kind: 'agent-chat',
          employeeId,
          providerId: resolvedProviderId,
          modelId: resolvedModelId,
          messages,
          conversationId,
          system: DATA_MODEL_SYSTEM_PROMPT,
          useSkills: false,
          enableThinking: true,
          minimalMode: false,
          highPermission: false
        },
        {
          onChunk: (text) => { acc += text; broadcast('chat-event', { type: 'chunk', text }) },
          onThought: (thoughtChunk) => { thought += thoughtChunk; broadcast('chat-event', { type: 'thought', thought: thoughtChunk }) },
          onToolCall: (tc) => broadcast('chat-event', { type: 'tool-call', toolCall: tc }),
          onDone: (metadata) => broadcast('chat-event', { type: 'done', metadata }),
          onError: (error) => {
            errText = error
            broadcast('chat-event', { type: 'error', error })
          }
        },
        mergedSignal
      )
      lastConvId = (result as { conversationId: string }).conversationId

      // 持久化：读取现有消息 → 追加用户消息 + 助手回复
      if (lastConvId) {
        const data = ctx.services.data
        const existing = data ? (await data.query('messages', { filter: { conversationId: lastConvId } }) as unknown[]) : []
        const userMsg = { role: 'user' as const, content: lastMsg?.content ?? '' }
        const assistantMsg: Record<string, unknown> = { role: 'assistant', content: acc }
        if (thought) assistantMsg.reasoning_content = thought
        if (errText) assistantMsg.content = (assistantMsg.content as string) + (acc ? `\n\n[错误] ${errText}` : `[错误] ${errText}`)
        const hasUser = existing.some((m) => (m as any).role === 'user' && (m as any).content === userMsg.content)
        await persist(lastConvId, [...(hasUser ? existing : [...existing, userMsg]), assistantMsg])
        // 记录数据模型对话（供历史列表）
        const title = lastMsg?.content?.slice(0, 40) || '数据模型对话'
        projectStore.saveChat({ conversationId: lastConvId, employeeId, title, updatedAt: Date.now() })
        broadcast('chats-changed', { ts: Date.now() })
      }
      return { conversationId: lastConvId } as { conversationId: string }
    } finally {
      if (currentAbort === controller) currentAbort = null
    }
  })

  ctx.ipc.handle('chats-list', (payload: any) => {
    return projectStore.listChats(payload?.employeeId)
  })

  ctx.ipc.handle('chat-delete', (payload: any) => {
    const convId = payload?.conversationId
    if (!convId) return { error: '缺少 conversationId' }
    projectStore.deleteChat(convId)
    broadcast('chats-changed', { ts: Date.now() })
    return { ok: true }
  })

  ctx.ipc.handle('chat-cancel', () => {
    currentAbort?.abort()
    return { ok: true }
  })

  ctx.ipc.handle('chat-history', async (payload: any) => {
    const data = ctx.services.data
    if (!data || !payload?.conversationId) return []
    const messages = await data.query('messages', { filter: { conversationId: payload.conversationId } })
    return messages
  })
}

export const migrations = []

export function activate(ctx: PluginContext): void {
  ctxRef = ctx
  projectStore.init(ctx)
  modelSession.init(ctx)

  // 加载最近项目，无则创建空白项目
  const projects = projectStore.list()
  if (projects.length > 0) {
    modelSession.setModel(projects[0].model, null)
  } else {
    const model = projectStore.createBlank()
    modelSession.setModel(model, null)
  }

  registerIpc(ctx)
  ctx.contributions.registerAgentTools(createDataModelAgentTools())

  // 订阅员工/模型变更事件，通知渲染端刷新下拉选项
  const events = ctx.services.events
  if (events) {
    const subscribe = (event: string, scope: 'employees' | 'providers') => {
      unsubscribeEvents.push(events.subscribe(event, () => broadcast('meta-changed', { scope, ts: Date.now() })))
    }
    subscribe('employee:created', 'employees')
    subscribe('employee:updated', 'employees')
    subscribe('employee:deleted', 'employees')
    subscribe('model:renamed', 'providers')
    subscribe('provider:changed', 'providers')
  }

  ctx.services.logger.info('data-model 插件激活完成')
}

export function deactivate(): void {
  currentAbort?.abort()
  currentAbort = null
  unsubscribeEvents.forEach((unsub) => { try { unsub() } catch { /* ignore */ } })
  unsubscribeEvents = []
  ctxRef = null
}

const mod: PluginMainModule = { migrations, activate, deactivate }
export default mod
