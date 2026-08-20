// data-model 插件主进程入口

import fs from 'fs'
import path from 'path'
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

当前数据模型通过分层协议读写（工具已直接可用）：
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

你同时具备通用能力（与数字员工一致）：
- 任务工作区：每次会话分配独立任务文件夹，可读写文件（file_read / file_write / file_edit），增删改直接执行
- shell_exec：执行系统命令（python/node/git/pip/npm 等），用于脚本、数据处理、外部工具
- 需要时可用文件工具读写任务工作区内的临时文件，配合 shell 完成复杂任务

结构化 JSON 是完整交换格式，能表达 DBML 无法承载的布局位置、颜色、索引、枚举引用等。DBML 仅用于兼容用户提供的既有 schema。
命名规范：表名、字段名使用小写 snake_case。主键字段通常为 id (bigint, 自增)。外键字段命名如 user_id。`

function broadcast(event: string, payload?: unknown): void {
  ctxRef?.ipc.broadcast(event, payload)
}

// ====== 任务工作区目录（参考数字员工：<数据目录>/<插件根>/YYYYMMDD_HHmmss） ======
// 数据目录已按插件隔离（userData/plugin-data/data-model），根目录取其中的 tasks/
function taskRootDir(): string {
  return path.join(ctxRef!.paths.data, 'tasks')
}

/** 新对话创建独立任务目录（YYYYMMDD_HHmmss，碰撞时追加序号） */
function createTaskWorkspace(): string {
  const root = taskRootDir()
  fs.mkdirSync(root, { recursive: true })
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let dir = path.join(root, base)
  let i = 1
  while (fs.existsSync(dir)) {
    dir = path.join(root, `${base}_${i}`)
    i++
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 安全校验：目标路径必须位于任务根目录下，防止删除/打开任意路径 */
function isWithinTaskRoot(p: string): boolean {
  const root = path.resolve(taskRootDir())
  const target = path.resolve(p)
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
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

  ctx.ipc.handle('project-rename', (payload: any) => {
    const id = payload?.id
    const name = payload?.name
    if (!id || typeof name !== 'string' || !name.trim()) return { error: '缺少项目名称' }
    const trimmed = name.trim()
    projectStore.rename(id, trimmed)
    const model = modelSession.getModel()
    if (model && model.id === id) {
      modelSession.setModel({ ...model, name: trimmed, updatedAt: Date.now() }, null)
      broadcast('model-changed', { model: modelSession.getModel() })
    }
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

  // ====== 供应商（复用宿主数据能力） ======
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

  // ====== 对话（复用宿主通用对话引擎，不绑定员工） ======
  ctx.ipc.handle('chat-send', async (payload: any, signal?: AbortSignal) => {
    const execute = ctx.services.execute
    if (!execute) return { error: '宿主未提供 execute 能力' }
    const { providerId, modelId, messages, conversationId } = payload ?? {}
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

    // 新会话生成会话 id（插件分库持久化，不依赖宿主 conversations 表）
    const convId = conversationId || `dm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    // 任务工作区：新会话创建独立任务目录；已有会话沿用记录中的目录
    // 目录注入系统提示，使 agent 可通过文件工具读写该目录
    let workspacePath: string | null = null
    if (isNewConv) {
      try {
        workspacePath = createTaskWorkspace()
      } catch (e) {
        ctx.services.logger.warn('创建任务工作区失败:', e instanceof Error ? e.message : String(e))
      }
    } else {
      workspacePath = projectStore.getChatWorkspacePath(conversationId)
    }
    const system = workspacePath
      ? DATA_MODEL_SYSTEM_PROMPT + `\n\n当前任务工作区目录：${workspacePath}\n该目录为本次对话的专属任务文件夹，可用 file_read / file_write / file_edit / shell_exec 读取、写入、编辑其中的文件以完成建模与分析任务。`
      : DATA_MODEL_SYSTEM_PROMPT

    const persist = async (convId: string, msgs: unknown[]) => {
      try {
        projectStore.saveMessages(convId, msgs)
      } catch (e) {
        ctx.services.logger.warn('持久化对话消息失败:', e instanceof Error ? e.message : String(e))
      }
    }

    // 新会话先写用户消息（会话 id 由插件生成，execute 后补写助手回复）
    let lastConvId: string | null = isNewConv ? null : convId

    try {
      const result = await execute.execute(
        {
          kind: 'agent-chat',
          providerId: resolvedProviderId,
          modelId: resolvedModelId,
          messages,
          conversationId: convId,
          system,
          tools: createDataModelAgentTools(),
          useSkills: false,
          enableThinking: true,
          minimalMode: false,
          highPermission: false,
          enableBuiltinTools: true,
          workspacePath: workspacePath ?? undefined
        },
        {
          onChunk: (text) => { acc += text; broadcast('chat-event', { type: 'chunk', text }) },
          onThought: (thoughtChunk) => { thought += thoughtChunk; broadcast('chat-event', { type: 'thought', thought: thoughtChunk }) },
          onToolCall: (tc) => broadcast('chat-event', { type: 'tool-call', toolCall: tc }),
          onToolCallDelta: (delta) => broadcast('chat-event', { type: 'tool-call-delta', delta }),
          onToolResult: (tr) => broadcast('chat-event', { type: 'tool-result', ...tr }),
          onToolProgress: (p) => broadcast('chat-event', { type: 'tool-progress', ...p }),
          onDone: (metadata) => broadcast('chat-event', { type: 'done', metadata }),
          onError: (error) => {
            errText = error
            broadcast('chat-event', { type: 'error', error })
          }
        },
        mergedSignal
      )
      lastConvId = (result as { conversationId: string }).conversationId || convId

      // 持久化：读取现有消息 → 追加用户消息 + 助手回复
      if (lastConvId) {
        const existing = projectStore.getMessages(lastConvId)
        const userMsg = { id: lastMsg?.id, role: 'user' as const, content: lastMsg?.content ?? '' }
        const assistantMsg: Record<string, unknown> = { id: payload?.assistantId, role: 'assistant', content: acc }
        if (thought) assistantMsg.reasoning_content = thought
        if (errText) assistantMsg.content = (assistantMsg.content as string) + (acc ? `\n\n[错误] ${errText}` : `[错误] ${errText}`)
        const hasUser = existing.some((m) => (m as any).role === 'user' && (m as any).content === userMsg.content)
        await persist(lastConvId, [...(hasUser ? existing : [...existing, userMsg]), assistantMsg])
        // 记录数据模型对话（供历史列表）
        const title = lastMsg?.content?.slice(0, 40) || '数据模型对话'
        projectStore.saveChat({ conversationId: lastConvId, title, updatedAt: Date.now(), workspacePath })
        broadcast('chats-changed', { ts: Date.now() })
      }
      return { conversationId: lastConvId, workspacePath } as { conversationId: string; workspacePath: string | null }
    } finally {
      if (currentAbort === controller) currentAbort = null
    }
  })

  ctx.ipc.handle('chats-list', () => {
    return projectStore.listChats()
  })

  ctx.ipc.handle('chat-delete', (payload: any) => {
    const convId = payload?.conversationId
    if (!convId) return { error: '缺少 conversationId' }
    const ws = projectStore.getChatWorkspacePath(convId)
    projectStore.deleteChat(convId)
    broadcast('chats-changed', { ts: Date.now() })
    // 任务目录：空目录直接删除；非空目录保留并上报，由前端决定是否一并删除
    let taskDir: string | undefined
    let taskDirNonEmpty: boolean | undefined
    if (ws && isWithinTaskRoot(ws) && fs.existsSync(ws)) {
      try {
        if (fs.readdirSync(ws).length === 0) {
          fs.rmdirSync(ws)
        } else {
          taskDir = ws
          taskDirNonEmpty = true
        }
      } catch (e) {
        ctx.services.logger.warn('处理任务目录失败:', e instanceof Error ? e.message : String(e))
      }
    }
    return { ok: true, taskDir, taskDirNonEmpty }
  })

  // 删除对话的任务工作区目录（移至回收站，路径须位于任务根目录内）
  ctx.ipc.handle('chat-delete-task-dir', async (payload: any) => {
    const dir = payload?.path
    if (!dir) return { ok: false, error: '缺少路径' }
    if (!isWithinTaskRoot(dir)) return { ok: false, error: '路径不在任务工作区内，拒绝删除' }
    if (!fs.existsSync(dir)) return { ok: true }
    const { shell } = require('electron')
    try {
      if (typeof shell.trashItem === 'function') {
        await shell.trashItem(dir)
      } else {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    return { ok: true }
  })

  // 打开对话的任务工作区目录
  ctx.ipc.handle('chat-open-dir', (payload: any) => {
    const convId = payload?.conversationId
    const ws = convId ? projectStore.getChatWorkspacePath(convId) : null
    if (!ws || !fs.existsSync(ws)) return { ok: false, error: '任务工作区不存在' }
    try {
      const { shell } = require('electron')
      if (shell?.openPath) shell.openPath(ws)
    } catch { ctx.services.logger.warn('打开任务工作区失败:', ws) }
    return { ok: true }
  })

  ctx.ipc.handle('chat-cancel', () => {
    currentAbort?.abort()
    return { ok: true }
  })

  ctx.ipc.handle('chat-history', async (payload: any) => {
    if (!payload?.conversationId) return []
    return projectStore.getMessages(payload.conversationId)
  })

  ctx.ipc.handle('chat-delete-message', (payload: any) => {
    const convId = payload?.conversationId
    const msgId = payload?.msgId
    if (!convId || !msgId) return { error: '缺少参数' }
    const msgs = projectStore.getMessages(convId) as Array<{ id?: string; role?: string; content?: string }>
    let idx = msgs.findIndex((m) => m.id === msgId)
    // 兼容旧数据（无 id 字段）：按 role+content 兜底匹配
    if (idx === -1 && payload?.role && payload?.content !== undefined) {
      idx = msgs.findIndex((m) => m.role === payload.role && m.content === payload.content)
    }
    if (idx === -1) return { error: '消息不存在' }
    const next = [...msgs]
    next.splice(idx, 1)
    // 删除用户消息时同步删除紧随其后的助手回复（与宿主任务对话语义一致）
    if (msgs[idx].role === 'user' && next[idx] && next[idx].role === 'assistant') {
      next.splice(idx, 1)
    }
    projectStore.saveMessages(convId, next)
    return { ok: true }
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

  // 订阅模型变更事件，通知渲染端刷新下拉选项
  const events = ctx.services.events
  if (events) {
    const subscribe = (event: string, scope: 'providers') => {
      unsubscribeEvents.push(events.subscribe(event, () => broadcast('meta-changed', { scope, ts: Date.now() })))
    }
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
