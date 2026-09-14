import Database from 'better-sqlite3'
import fs from 'fs'
import PathService from './path.service'
import { createLogger } from './logger'
import { extractMessagePreview } from './common-utils'

const logger = createLogger('DB')

class DatabaseService {
  private db: Database.Database
  private static instance: DatabaseService
  private checkpointTimer: NodeJS.Timeout | null = null

  private constructor() {
    const pathService = PathService.getInstance()
    const basePath = pathService.getDataDir()
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true })
    }
    const dbPath = pathService.getDbPath()
    this.db = new Database(dbPath, {
      readonly: false,
      timeout: 5000
    })

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    // 设置 WAL 自动检查点阈值（每 1000 页自动 checkpoint）
    this.db.pragma('wal_autocheckpoint = 1000')

    this.initializeSchema()
    this.cleanupOldConversations()
    this.startPeriodicCheckpoint()
  }

  /** 定期手动 checkpoint，防止 WAL 文件无限增长 */
  private startPeriodicCheckpoint(): void {
    const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000 // 5 分钟
    this.checkpointTimer = setInterval(() => {
      try {
        this.db.pragma('wal_checkpoint(PASSIVE)')
      } catch (err: any) {
        logger.warn('WAL checkpoint failed:', err?.message || err)
      }
    }, CHECKPOINT_INTERVAL_MS)
    if (this.checkpointTimer.unref) this.checkpointTimer.unref()
  }

  /**
   * 启动时清理过期对话，防止 conversations.messages_json 无限增长。
   * - 30 天前的空对话（message_count = 0）：直接删除（用户创建但未发送任何消息的废弃对话）
   * - 180 天前且 messages_json > 2MB 的对话：保留最近 50 条消息，裁剪更早的历史
   */
  private cleanupOldConversations(): void {
    const now = Math.floor(Date.now() / 1000)

    // 1. 删除 30 天前的空对话（同步清理 FTS5 记录）
    try {
      const cutoff = now - 30 * 86400
      const emptyConvos = this.db.prepare(
        `SELECT id FROM conversations
         WHERE message_count = 0 AND messages_json = '[]' AND created_at < ?
           AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)`
      ).all(cutoff) as any[]
      if (emptyConvos.length > 0) {
        const delTx = this.db.transaction(() => {
          for (const c of emptyConvos) {
            this.db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(c.id)
            this.db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id)
          }
        })
        delTx()
        logger.info(`启动清理：删除 ${emptyConvos.length} 条 30 天前空对话`)
      }
    } catch (err: any) {
      logger.warn('启动清理空对话失败:', err?.message || err)
    }

    // 2. 裁剪 180 天前的大对话（messages_json > 2MB），保留最近 50 条消息
    try {
      const cutoff = now - 180 * 86400
      const sizeThreshold = 2 * 1024 * 1024
      const oldConvos = this.db.prepare(
        `SELECT id, messages_json FROM conversations
         WHERE updated_at < ? AND length(messages_json) > ?`
      ).all(cutoff, sizeThreshold) as any[]

      let trimmed = 0
      const updateStmt = this.db.prepare(
        'UPDATE conversations SET messages_json = ?, message_count = ? WHERE id = ?'
      )
      const trimTx = this.db.transaction(() => {
        const ftsUpdate = this.db.prepare(
          `UPDATE conversations_fts SET content_preview = ? WHERE conversation_id = ?`
        )
        for (const c of oldConvos) {
          try {
            const messages = JSON.parse(c.messages_json)
            if (Array.isArray(messages) && messages.length > 50) {
              const trimmedMessages = messages.slice(-50)
              const trimmedJson = JSON.stringify(trimmedMessages)
              updateStmt.run(trimmedJson, trimmedMessages.length, c.id)
              // 同步 FTS 摘要预览，避免搜索结果展示与实际内容永久不一致
              ftsUpdate.run(extractMessagePreview(trimmedJson), c.id)
              trimmed++
            }
          } catch { /* skip invalid JSON */ }
        }
      })
      trimTx()
      if (trimmed > 0) {
        logger.info(`启动清理：裁剪 ${trimmed} 条 180 天前大对话（保留最近 50 条消息）`)
      }
    } catch (err: any) {
      logger.warn('启动清理大对话失败:', err?.message || err)
    }
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        workspace_path TEXT DEFAULT '',
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        rules TEXT DEFAULT '',
        avatar_type TEXT DEFAULT 'default',
        default_skill_id TEXT,
        profile_json TEXT DEFAULT '',
        arch_version INTEGER NOT NULL DEFAULT 1,
        total_tasks INTEGER DEFAULT 0,
        total_approvals INTEGER DEFAULT 0,
        memory_enabled BOOLEAN NOT NULL DEFAULT 0,
        last_active_at INTEGER,
        -- 委托能力设置：{"enabled":bool,"targetIds":[],"acceptDelegation":bool}，空串表示未配置（全默认）
        delegation_json TEXT DEFAULT '',
        -- 注册员工（内置/插件）的影子记录标记：仅作外键占位，不参与员工列表展示
        is_registered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        config_json TEXT NOT NULL DEFAULT '{}',
        prompt_template TEXT,
        rules_json TEXT DEFAULT '[]',
        test_cases_json TEXT DEFAULT '[]',
        input_schema_json TEXT,
        output_schema_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
        title TEXT DEFAULT '',
        summary TEXT DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        minimal_mode BOOLEAN NOT NULL DEFAULT 0,
        system_prompt TEXT DEFAULT '',
        memory_extracted_at INTEGER,
        memory_extracted_message_count INTEGER NOT NULL DEFAULT 0,
        context_stats_json TEXT DEFAULT '{}',
        -- 对话绑定的默认模型（输入框模型按钮）：各任务独立，JSON 形如 {"providerId":"","modelId":""}
        default_model_json TEXT DEFAULT '',
        -- 对话绑定的资料库合集 ID 列表：各任务独立，JSON 形如 ["id1","id2"]，空数组表示不限范围
        collection_ids_json TEXT DEFAULT '',
        -- 任务工作区目录（每个任务独立子目录）
        workspace_path TEXT DEFAULT '',
        -- 父会话 ID：委托产生的子会话记录其主管会话 ID，用于级联删除与列表过滤
        parent_conversation_id TEXT DEFAULT '',
        last_message_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS feedbacks (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        rating TEXT NOT NULL,
        note TEXT,
        original_output TEXT,
        corrected_output TEXT,
        is_used_for_training BOOLEAN DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS llm_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        base_url TEXT,
        model TEXT NOT NULL,
        embedding_model TEXT DEFAULT 'text-embedding-3-small',
        temperature REAL DEFAULT 0.7,
        max_tokens INTEGER DEFAULT 4096,
        timeout_ms INTEGER DEFAULT 60000,
        extra_headers_json TEXT,
        extra_body_json TEXT,
        is_default BOOLEAN DEFAULT 0,
        models_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_skills_employee ON skills(employee_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_employee ON conversations(employee_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_emp_lastmsg ON conversations(employee_id, last_message_at);
      CREATE INDEX IF NOT EXISTS idx_feedbacks_skill ON feedbacks(skill_id);

      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'builtin',
        config_json TEXT NOT NULL DEFAULT '{}',
        is_builtin BOOLEAN NOT NULL DEFAULT 0,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS employee_tools (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL,
        -- 工具启用模式：on（常驻）/ on_demand（按需）/ off（关闭）
        tool_mode TEXT NOT NULL DEFAULT 'on',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_tools_unique ON employee_tools(employee_id, tool_id);

      CREATE INDEX IF NOT EXISTS idx_employee_tools_employee ON employee_tools(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_tools_tool ON employee_tools(tool_id);

      CREATE TABLE IF NOT EXISTS installed_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        version TEXT DEFAULT '1.0.0',
        author TEXT DEFAULT '',
        tags_json TEXT DEFAULT '[]',
        install_path TEXT NOT NULL,
        manifest_json TEXT DEFAULT '{}',
        skill_md_content TEXT DEFAULT '',
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        license TEXT DEFAULT '',
        compatibility TEXT DEFAULT '',
        allowed_tools_json TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        context TEXT DEFAULT 'inherit',
        agent TEXT DEFAULT '',
        source TEXT DEFAULT 'global',
        disable_model_invocation BOOLEAN NOT NULL DEFAULT 0,
        user_invocable BOOLEAN NOT NULL DEFAULT 1,
        hooks_json TEXT DEFAULT '[]',
        -- 插件来源技能（source='plugin'）：记录所属插件 id，用于按插件生命周期上下线
        plugin_id TEXT DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS employee_skills (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        config_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_skills_employee ON employee_skills(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_skills_skill ON employee_skills(skill_id);

      CREATE TABLE IF NOT EXISTS employee_memories (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        topic TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        is_pinned BOOLEAN NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'auto',
        last_referenced_at INTEGER,
        importance TEXT NOT NULL DEFAULT 'normal',
        deleted_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_memories_employee ON employee_memories(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_pinned ON employee_memories(employee_id, is_pinned);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_key ON employee_memories(employee_id, key);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_updated ON employee_memories(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_pin_updated ON employee_memories(employee_id, is_pinned, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_last_ref ON employee_memories(last_referenced_at);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_importance ON employee_memories(importance);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_deleted ON employee_memories(employee_id, deleted_at);

      -- 数字员工 MCP server 配置表
      -- 每条记录是一个员工接入的外部 MCP server，agent 初始化时按 employee_id 拉取启用的 server 并注入其工具
      CREATE TABLE IF NOT EXISTS employee_mcp_servers (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        -- 传输类型：stdio（启动子进程） / streamableHttp（HTTP+SSE） / sse（旧版 SSE）
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        -- stdio 模式字段
        command TEXT,
        args_json TEXT DEFAULT '[]',
        env_json TEXT DEFAULT '{}',
        -- HTTP/SSE 模式字段
        url TEXT,
        headers_json TEXT DEFAULT '{}',
        -- 状态与缓存
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        status TEXT DEFAULT 'unknown',
        last_error TEXT,
        -- 缓存最近一次拉取的工具清单（JSON 数组），避免每次 agent 创建都连接 server
        tools_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_mcp_servers_employee ON employee_mcp_servers(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_mcp_servers_enabled ON employee_mcp_servers(employee_id, is_enabled);

      -- 员工委托权限白名单：supervisor 可委托给 target，默认无记录=禁止
      CREATE TABLE IF NOT EXISTS employee_delegate_permissions (
        id TEXT PRIMARY KEY,
        supervisor_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_delegate_perm_unique ON employee_delegate_permissions(supervisor_id, target_id);
      CREATE INDEX IF NOT EXISTS idx_delegate_perm_supervisor ON employee_delegate_permissions(supervisor_id);

      -- 子会话运行记录（多智能体运行时）：每次委托/派发一个 run，状态机与结构化结果落库
      CREATE TABLE IF NOT EXISTS sub_agent_runs (
        run_id TEXT PRIMARY KEY,
        parent_conversation_id TEXT NOT NULL,
        employee_id TEXT NOT NULL DEFAULT '',
        parent_run_id TEXT DEFAULT '',
        -- 关联的子会话 ID：多轮追问（followup）按其加载历史轮次上下文
        conversation_id TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        inputs_json TEXT DEFAULT '{}',
        result_json TEXT DEFAULT '{}',
        usage_json TEXT DEFAULT '{}',
        error TEXT,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_parent ON sub_agent_runs(parent_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_started ON sub_agent_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_conv ON sub_agent_runs(conversation_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS employee_memories_fts USING fts5(
        key,
        topic,
        content,
        memory_id UNINDEXED,
        employee_id UNINDEXED,
        tokenize='unicode61',
        prefix='2,3'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        title,
        summary,
        content_preview,
        conversation_id UNINDEXED,
        employee_id UNINDEXED,
        tokenize='unicode61',
        prefix='2,3'
      );
    `)
  }

  public getDb(): Database.Database {
    return this.db
  }

  public close(): void {
    // 先清除定时器，避免关闭后定时器仍触发访问已关闭的 DB
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer)
      this.checkpointTimer = null
    }
    // 关闭前执行 TRUNCATE checkpoint，确保 WAL 内容写回主库文件
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err: any) {
      logger.warn('关闭前 checkpoint 失败:', err?.message || err)
    }
    this.db.close()
  }
}

export default DatabaseService
