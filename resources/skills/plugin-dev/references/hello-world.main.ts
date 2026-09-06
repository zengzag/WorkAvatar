/**
 * Hello World 能力参考插件 — 主进程入口（单文件、分节注释，第三方可直接对照抄写）。
 *
 * 覆盖能力：
 *  - migrations + 插件 SQLite 分库（ctx.storage.openSqlite）
 *  - 插件 KV（ctx.storage.get/set/delete/keys）
 *  - IPC 注册与渲染端广播（ctx.ipc.handle / ctx.ipc.broadcast）
 *  - 事件总线（ctx.services.events.subscribe/publish；注意 publish 强制加 plugin:<id>: 前缀）
 *  - 贡献点：命令 / agent 工具 / 消息快捷操作 / 文件关联 / 全局快捷键
 *  - 系统能力：定时任务 / 系统通知 / 子窗口 / 原生模块租借
 *  - 宿主数据与执行：services.data.query / services.execute（llm-chat）
 *  - 协作：共享 KV（services.shared）与跨插件 RPC（services.bus）
 */
import { randomUUID } from 'node:crypto'
import type {
  PluginContext,
  PluginDatabase,
  PluginMigration,
  PluginMigrationContext,
} from '@workavatar/plugin-sdk'

// ====== 数据迁移（宿主在 activate 前按序执行，写 plugin_migrations 版本记录）
// 单测直接调用 activate 时宿主不会跑 migrations，测试须手动执行（见插件单测示例）。
export const migrations: PluginMigration[] = [
  {
    version: '1-init-schema',
    description: '初始化留言表',
    run(ctx: PluginMigrationContext): void {
      ctx.storage.openSqlite('index').exec(`
        CREATE TABLE IF NOT EXISTS hello_messages (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
    },
  },
]

// ====== 模块级状态（activate 期间持有，deactivate 释放） ======

let pluginCtx: PluginContext | null = null
let count = 0
let schedulerJobId: string | null = null
let memoDb: PluginDatabase | null = null
/** 需要在 deactivate 时手动释放的订阅/注册取消函数（宿主也会兜底清理，双侧幂等） */
const disposers: Array<() => void> = []

export function activate(ctx: PluginContext): void {
  pluginCtx = ctx
  const logger = ctx.services.logger
  logger.info('hello-world v1.1.0 插件激活')

  // 懒打开插件 SQLite 分库（index.db，WAL 模式；表由 migrations 建好）
  const getMemoDb = (): PluginDatabase => {
    if (!memoDb) memoDb = ctx.storage.openSqlite('index')
    return memoDb
  }

  // ====== 1. IPC：greet / count（基础调用 + 广播到渲染端） ======
  ctx.ipc.handle('greet', (payload: unknown) => {
    const name = (payload as { name?: string })?.name ?? 'World'
    return { message: `Hello, ${name}!` }
  })

  ctx.ipc.handle('count', () => {
    count += 1
    // 主进程 → 渲染端广播（渲染端经 bridge.onEvent('count-changed') 订阅刷新 UI）
    ctx.ipc.broadcast('count-changed', { count })
    return { count }
  })

  // ====== 2. 插件 KV：ctx.storage（存于插件自己的库，不写内核 settings） ======
  ctx.ipc.handle('kv-get', async (payload: unknown) => {
    const key = String((payload as { key?: string })?.key ?? '')
    const value = await ctx.storage.get(key)
    return { key, value: value === undefined ? null : value }
  })
  ctx.ipc.handle('kv-set', async (payload: unknown) => {
    const { key, value } = payload as { key?: string; value?: unknown }
    await ctx.storage.set(String(key ?? ''), value)
    return { ok: true }
  })
  ctx.ipc.handle('kv-keys', async () => ({ keys: await ctx.storage.keys() }))
  ctx.ipc.handle('kv-delete', async (payload: unknown) => {
    await ctx.storage.delete(String((payload as { key?: string })?.key ?? ''))
    return { ok: true }
  })

  // ====== 3. 插件 SQLite 分库（openSqlite + migrations）：留言增/查/计数 ======
  ctx.ipc.handle('memo-add', (payload: unknown) => {
    const content = String((payload as { content?: string })?.content ?? '').trim()
    if (!content) return { ok: false, error: 'helloWorld.err.memoEmpty' }
    const id = randomUUID()
    getMemoDb()
      .prepare('INSERT INTO hello_messages (id, content, created_at) VALUES (?, ?, ?)')
      .run(id, content, Date.now())
    return { ok: true, id }
  })
  ctx.ipc.handle('memo-list', () => {
    const rows = getMemoDb()
      .prepare('SELECT id, content, created_at FROM hello_messages ORDER BY created_at DESC LIMIT 50')
      .all()
    return { list: rows }
  })
  ctx.ipc.handle('memo-count', () => {
    const row = getMemoDb().prepare('SELECT COUNT(*) AS n FROM hello_messages').get() as { n: number }
    return { count: Number(row.n ?? 0) }
  })

  // ====== 4. 事件总线：订阅宿主内核事件（原始事件名）+ 发布插件事件 ======
  // subscribe 用原始名；publish 由宿主强制加 plugin:example-hello-world: 前缀，
  // 其他插件请 subscribe('plugin:example-hello-world:hello-ping') 才能收到。
  const unsubEvent = ctx.services.events?.subscribe('conversation:deleted', (id: unknown) => {
    logger.info('收到宿主事件 conversation:deleted', id)
  })
  if (unsubEvent) disposers.push(unsubEvent)

  ctx.ipc.handle('publish-ping', () => {
    ctx.services.events?.publish('hello-ping', { ts: Date.now() })
    return { ok: true }
  })

  // ====== 5. 系统能力 ======

  // 定时任务（按需启停，避免 activate 即长驻定时器）：every(30s) 广播 tick 给渲染端
  ctx.ipc.handle('scheduler-start', () => {
    if (schedulerJobId) return { ok: true, jobId: schedulerJobId, running: true }
    schedulerJobId = ctx.services.scheduler?.every(30_000, () => {
      ctx.ipc.broadcast('tick', { ts: Date.now() })
    }) ?? null
    return { ok: true, jobId: schedulerJobId }
  })
  ctx.ipc.handle('scheduler-stop', () => {
    if (schedulerJobId) {
      ctx.services.scheduler?.cancel(schedulerJobId)
      schedulerJobId = null
    }
    return { ok: true }
  })

  // 系统通知
  ctx.ipc.handle('notify', (payload: unknown) => {
    const { title, body } = payload as { title?: string; body?: string }
    const sent = ctx.services.notification?.notify({
      title: title ?? 'Hello World',
      body: body ?? 'Hello World Plugin',
    }) ?? false
    return { sent }
  })

  // 子窗口（contentPath 相对插件根目录，随 resources/ 打包；窗口自动纳入广播目标）
  ctx.ipc.handle('window-open', () => {
    const win = ctx.services.windows?.create({
      width: 420,
      height: 320,
      title: 'Hello World Window',
      contentPath: 'resources/demo.html',
    })
    return { id: win?.id ?? null }
  })

  // 原生模块租借：只能借宿主白名单内的模块（plugin-sdk/host-native-dependencies.json）
  ctx.ipc.handle('native-borrow', () => {
    const Database = ctx.services.native?.borrow('better-sqlite3') as
      | (new (path: string) => { prepare(sql: string): { get(): unknown }; close(): void })
      | undefined
    if (typeof Database !== 'function') {
      return { ok: false, error: 'helloWorld.err.nativeUnavailable' }
    }
    const db = new Database(':memory:')
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    db.close()
    return { ok: true, sqliteVersion: row.v }
  })
  ctx.ipc.handle('host-native-modules', () => ctx.services.host.listNativeModules())

  // ====== 6. 宿主数据与执行 ======

  // services.data.query：实体须在 capabilities.data.entities 白名单内（只读）
  ctx.ipc.handle('data-conversations', async () => {
    const rows = (await ctx.services.data?.query(
      'conversations',
      { limit: 5 },
    )) as Array<{ id?: string; title?: string }> | undefined
    return {
      list: (rows ?? []).map((r) => ({ id: r?.id, title: r?.title ?? '(untitled)' })),
    }
  })

  // services.execute：统一执行入口（kind 须在 capabilities.execute.kinds 白名单内）。
  // 未配置模型供应商时宿主抛错，此处转为返回错误文案（渲染端优雅展示，属预期示范）
  ctx.ipc.handle('execute-llm', async (payload: unknown) => {
    const prompt = String((payload as { prompt?: string })?.prompt ?? '你好')
    try {
      const output = await ctx.services.execute?.execute({ kind: 'llm-chat', prompt })
      return { ok: true, output }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ====== 7. 协作：共享 KV + 跨插件 RPC ======

  // services.shared：只写本插件命名空间（capabilities.collaboration.shared.write）
  ctx.ipc.handle('shared-set', async (payload: unknown) => {
    const { key, value } = payload as { key?: string; value?: unknown }
    await ctx.services.shared?.set(String(key ?? ''), value)
    return { ok: true }
  })
  ctx.ipc.handle('shared-get', async (payload: unknown) => {
    const key = String((payload as { key?: string })?.key ?? '')
    const value = await ctx.services.shared?.get(key)
    return { key, value: value === undefined ? null : value }
  })

  // services.bus：respond 注册可被其他插件调用的方法（宿主存为 'example-hello-world:echo'）。
  // 本例通过自身 call 白名单（collaboration.call）自调用一次，演示请求-响应链路；
  // 真实场景由其他插件在它们的 collaboration.call 里声明 'example-hello-world:echo' 后再调用。
  const unbus = ctx.services.bus?.respond('echo', (payload: unknown) => ({
    pong: (payload as { message?: string })?.message || 'pong',
  }))
  if (unbus) disposers.push(unbus)

  ctx.ipc.handle('bus-echo', async (payload: unknown) => {
    const message = String((payload as { message?: string })?.message ?? '')
    const result = await ctx.services.bus?.call('example-hello-world:echo', { message })
    return { result }
  })

  // ====== 8. 贡献点 ======

  // 命令：渲染端可直接 bridge.invoke('command:hello')（挂在 plugin:<id>:command:<id>，无需在 manifest.ipc 声明）
  ctx.contributions.registerCommand({
    id: 'hello',
    title: 'helloWorld.command',
    handler: () => ({ message: 'Hello from command!' }),
  })

  // agent 工具：注册后进宿主 ToolRegistry，可分配给数字员工。
  // 演示两种形态：hello_memo_add 按需（onDemand，经 list_available_tools 发现）；
  // hello_memo_query 常驻 LLM tools 数组。
  ctx.contributions.registerAgentTools([
    {
      id: 'hello_memo_add',
      name: 'hello_memo_add',
      title: 'helloWorld.tool.addTitle',
      description: 'helloWorld.tool.addDesc',
      summary: 'helloWorld.tool.addTitle',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'helloWorld.tool.addParamContent' } },
        required: ['content'],
      },
      permission: 'safe',
      onDemand: true,
      handler: (args: Record<string, unknown>) => {
        const content = String(args?.content ?? '').trim()
        if (!content) return { ok: false, error: '内容为空' }
        const id = randomUUID()
        getMemoDb()
          .prepare('INSERT INTO hello_messages (id, content, created_at) VALUES (?, ?, ?)')
          .run(id, content, Date.now())
        return { ok: true, id }
      },
    },
    {
      id: 'hello_memo_query',
      name: 'hello_memo_query',
      title: 'helloWorld.tool.queryTitle',
      description: 'helloWorld.tool.queryDesc',
      summary: 'helloWorld.tool.queryTitle',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number' } },
      },
      handler: (args: Record<string, unknown>, context) => {
        const limit = Math.min(Number(args?.limit) || 10, 50)
        context.onProgress?.({ step: 'list', limit })
        const rows = getMemoDb()
          .prepare('SELECT id, content, created_at FROM hello_messages ORDER BY created_at DESC LIMIT ?')
          .all(limit)
        return { count: rows.length, items: rows }
      },
    },
  ])

  // 消息快捷操作：出现在对话消息气泡的操作菜单中，返回 success 文案（i18n key）
  ctx.contributions.registerMessageActions([
    {
      id: 'extract-todo',
      title: 'helloWorld.action.extractTodo',
      target: 'assistant',
      handler: () => ({ success: 'helloWorld.action.extracted' }),
    },
  ])

  // 文件关联：系统"打开方式"打开 .wahello 文件时路由到本插件（渲染端经 hostCapabilities.subscribeExternalFiles 接收）
  ctx.contributions.registerFileAssociations([
    { extension: '.wahello', description: 'helloWorld.fileAssoc.desc' },
  ])

  // 全局快捷键：accelerator 被宿主/其他插件占用时注册会被忽略（宿主 warn），属正常现象
  ctx.contributions.registerGlobalShortcuts([
    {
      accelerator: 'CommandOrControl+Shift+H',
      handler: () => {
        ctx.ipc.broadcast('shortcut-pressed', { ts: Date.now() })
      },
    },
  ])
}

export function deactivate(): void {
  const ctx = pluginCtx
  if (schedulerJobId && ctx) {
    try { ctx.services.scheduler?.cancel(schedulerJobId) } catch { /* ignore */ }
    schedulerJobId = null
  }
  for (const fn of disposers.splice(0)) {
    try { fn() } catch { /* ignore */ }
  }
  if (memoDb) {
    try { memoDb.close() } catch { /* ignore */ }
    memoDb = null
  }
  pluginCtx = null
  count = 0
}