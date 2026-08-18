import Database from 'better-sqlite3'
import fs from 'fs'
import PathService from './path.service'
import { createLogger } from './logger'
import { extractMessagePreview } from './common-utils'
// 【LEGACY】日历/语音迁出遗留兼容（见 services/plugin/legacy，可整体移除）
import {
  migrateCalendarLegacyColumns,
  migrateCalendarRecurrenceRule as legacyMigrateCalendarRecurrence,
} from './plugin/legacy'

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
        for (const c of oldConvos) {
          try {
            const messages = JSON.parse(c.messages_json)
            if (Array.isArray(messages) && messages.length > 50) {
              const trimmedMessages = messages.slice(-50)
              updateStmt.run(JSON.stringify(trimmedMessages), trimmedMessages.length, c.id)
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

  private addColumnIfNotExists(table: string, column: string, definition: string): boolean {
    const result = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]
    const columnExists = result.some((c) => c.name === column)
    if (!columnExists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      return true
    }
    return false
  }

  private dropColumnIfExists(table: string, column: string): void {
    const result = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]
    const columnExists = result.some((c) => c.name === column)
    if (columnExists) {
      this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    }
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
        messages_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
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
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
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
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_memories_employee ON employee_memories(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_pinned ON employee_memories(employee_id, is_pinned);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_key ON employee_memories(employee_id, key);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_updated ON employee_memories(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_emp_pin_updated ON employee_memories(employee_id, is_pinned, updated_at DESC);

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

      -- 日历日程表：用户与智能体创建的日程事件
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        location TEXT DEFAULT '',
        -- unix 秒
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        -- 颜色标签：blue/green/orange/red/purple/default
        color TEXT NOT NULL DEFAULT 'default',
        -- 重复规则 JSON，空串表示不重复
        recurrence_rule TEXT DEFAULT '',
        -- 多个提醒偏移（分钟）JSON 数组，如 [0, -10, -60]
        reminders_json TEXT DEFAULT '[]',
        -- 创建者 employee_id（用户手动创建则为空）
        employee_id TEXT,
        -- 来源：user / agent
        source TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_end ON calendar_events(end_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_emp ON calendar_events(employee_id);

      -- 日历 TODO 任务表
      CREATE TABLE IF NOT EXISTS calendar_todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        -- 截止时间 unix 秒，可空表示无截止
        due_at INTEGER,
        -- 优先级：none / low / medium / high
        priority TEXT NOT NULL DEFAULT 'none',
        -- 状态：pending / in_progress / completed
        status TEXT NOT NULL DEFAULT 'pending',
        recurrence_rule TEXT DEFAULT '',
        reminders_json TEXT DEFAULT '[]',
        completed_at INTEGER,
        employee_id TEXT,
        source TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_todos_due ON calendar_todos(due_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_todos_status ON calendar_todos(status);
      CREATE INDEX IF NOT EXISTS idx_calendar_todos_priority ON calendar_todos(priority);
      CREATE INDEX IF NOT EXISTS idx_calendar_todos_emp ON calendar_todos(employee_id);

      -- 日历提醒队列表：scheduler 扫描此表触发通知
      CREATE TABLE IF NOT EXISTS calendar_reminders (
        id TEXT PRIMARY KEY,
        -- event / todo
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        -- 触发时间 unix 秒
        trigger_at INTEGER NOT NULL,
        -- 已触发时间 unix 秒，NULL 表示未触发
        fired_at INTEGER,
        -- 通知负载 JSON：title / body / clickTarget / clickId
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_reminders_trigger ON calendar_reminders(trigger_at, fired_at);
      CREATE INDEX IF NOT EXISTS idx_calendar_reminders_target ON calendar_reminders(target_type, target_id);

      -- 日历外部同步映射表：本地记录与远端（如 Outlook）对象的对应关系
      CREATE TABLE IF NOT EXISTS calendar_sync_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- 同步目标：outlook
        target TEXT NOT NULL,
        -- event / todo
        local_type TEXT NOT NULL,
        local_id TEXT NOT NULL,
        -- 远端对象 id（Outlook event id / todoTask id）
        remote_id TEXT NOT NULL,
        -- 最近一次成功同步的本地 updated_at，用于增量判断
        synced_updated_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_map_unique ON calendar_sync_map(target, local_type, local_id);

      -- 自动化任务表：定时调度数字员工执行提示词任务
      CREATE TABLE IF NOT EXISTS automation_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        prompt TEXT NOT NULL,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT,
        high_permission INTEGER NOT NULL DEFAULT 0,
        start_at INTEGER NOT NULL,
        recurrence_rule TEXT DEFAULT '',
        is_enabled INTEGER NOT NULL DEFAULT 1,
        notify_on_complete INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT DEFAULT '[]',
        last_run_at INTEGER,
        next_run_at INTEGER,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_automation_tasks_enabled ON automation_tasks(is_enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automation_tasks_employee ON automation_tasks(employee_id);
      CREATE INDEX IF NOT EXISTS idx_automation_tasks_status ON automation_tasks(last_status);

      -- 自动化执行历史表：每次任务执行的记录
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
        conversation_id TEXT,
        employee_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        triggered_by TEXT NOT NULL DEFAULT 'scheduler',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_conv ON automation_runs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
    `)

    this.addColumnIfNotExists('llm_providers', 'embedding_model', 'TEXT DEFAULT \'text-embedding-3-small\'')
    this.addColumnIfNotExists('llm_providers', 'models_json', 'TEXT DEFAULT \'[]\'')
    this.addColumnIfNotExists('llm_providers', 'extra_body_json', 'TEXT')
    this.addColumnIfNotExists('employees', 'profile_json', "TEXT DEFAULT ''")

    // 规则（系统提示词）：旧版 description 兼作系统提示词，新增列时一次性回填迁移
    if (this.addColumnIfNotExists('employees', 'rules', "TEXT DEFAULT ''")) {
      this.migrateEmployeeRules()
    }

    this.addColumnIfNotExists('employees', 'memory_enabled', 'BOOLEAN NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('employees', 'last_active_at', 'INTEGER')

    this.addColumnIfNotExists('conversations', 'summary', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('conversations', 'minimal_mode', 'BOOLEAN NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('conversations', 'last_message_at', 'INTEGER')
    this.addColumnIfNotExists('conversations', 'system_prompt', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('conversations', 'memory_extracted_at', 'INTEGER')
    this.addColumnIfNotExists('conversations', 'memory_extracted_message_count', 'INTEGER NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('conversations', 'context_stats_json', "TEXT DEFAULT '{}'")
    // 任务工作区目录（每个任务独立子目录），空字符串表示未分配（旧对话回退到员工工作区）
    this.addColumnIfNotExists('conversations', 'workspace_path', "TEXT DEFAULT ''")
    // 父会话 ID：委托产生的子会话记录其主管会话 ID，用于级联删除与列表过滤
    this.addColumnIfNotExists('conversations', 'parent_conversation_id', "TEXT DEFAULT ''")
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)`)

    this.migrateConversationLastMessageAt()

    this.addColumnIfNotExists('employee_memories', 'last_referenced_at', 'INTEGER')
    this.addColumnIfNotExists('employee_memories', 'importance', "TEXT NOT NULL DEFAULT 'normal'")
    this.addColumnIfNotExists('employee_memories', 'deleted_at', 'INTEGER')

    // 【LEGACY】日历/语音迁出遗留：旧库列兼容（可整体移除，见 plugin/legacy）
    migrateCalendarLegacyColumns(
      (t, c, d) => this.addColumnIfNotExists(t, c, d),
      (t, c) => this.dropColumnIfExists(t, c),
    )

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_emp_lastmsg ON conversations(employee_id, last_message_at);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_last_ref ON employee_memories(last_referenced_at);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_importance ON employee_memories(importance);
      CREATE INDEX IF NOT EXISTS idx_employee_memories_deleted ON employee_memories(employee_id, deleted_at);
    `)

    this.migrateEmployeeAddWorkspacePath()
    this.migrateEmployeeDropStatus()
    this.migrateEmployeeLastActiveAt()

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS employee_memories_fts USING fts5(
        key,
        topic,
        content,
        memory_id UNINDEXED,
        employee_id UNINDEXED,
        tokenize='unicode61',
        prefix='2,3'
      );
    `)
    this.migrateEmployeeMemoriesFTS()

    this.db.exec(`
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
    this.migrateConversationsFTS()

    // Skills v2: 对齐 agentskills.io 开放标准 + Claude Code 扩展字段
    this.addColumnIfNotExists('installed_skills', 'license', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('installed_skills', 'compatibility', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('installed_skills', 'allowed_tools_json', "TEXT DEFAULT '[]'")
    this.addColumnIfNotExists('installed_skills', 'metadata_json', "TEXT DEFAULT '{}'")
    this.addColumnIfNotExists('installed_skills', 'context', "TEXT DEFAULT 'inherit'")
    this.addColumnIfNotExists('installed_skills', 'agent', "TEXT DEFAULT ''")
    this.addColumnIfNotExists('installed_skills', 'source', "TEXT DEFAULT 'global'")
    this.addColumnIfNotExists('installed_skills', 'disable_model_invocation', "BOOLEAN NOT NULL DEFAULT 0")
    this.addColumnIfNotExists('installed_skills', 'user_invocable', "BOOLEAN NOT NULL DEFAULT 1")
    this.addColumnIfNotExists('installed_skills', 'hooks_json', "TEXT DEFAULT '[]'")

    this.migrateEmployeeToolMode()
    this.cleanupObsoleteEmployeeTools()
    // 【LEGACY】日历迁出遗留：旧库 recurrence_rule 数据模型迁移（可整体移除，见 plugin/legacy）
    legacyMigrateCalendarRecurrence(this.db)
  }

  /**
   * 清理 employee_tools 表中已废弃工具的遗留行：
   * - KMS 系列：kms_knowledge_card / kms_collection_overview / kms_get_toc / kms_get_paragraphs
   *   （kms_get_content 已通过 view 参数合并 toc/paragraphs，知识卡片/合集摘要已自动附加到 kms_search）
   * - 旧命名：office_exec（已重命名为 javascript_exec，有兼容映射但仍需清除旧行）
   * 使用 settings 版本化确保只执行一次。
   */
  private cleanupObsoleteEmployeeTools(): void {
    const CLEANUP_VERSION = 'v1'
    const versionRow = this.db.prepare("SELECT value FROM settings WHERE key = 'obsolete_employee_tools_cleanup_version'").get() as { value: string } | undefined
    if (versionRow?.value === CLEANUP_VERSION) return

    const obsoleteIds = [
      'kms_knowledge_card',
      'kms_collection_overview',
      'kms_get_toc',
      'kms_get_paragraphs',
      'office_exec',
    ]
    const placeholders = obsoleteIds.map(() => '?').join(',')
    const info = this.db.prepare(`DELETE FROM employee_tools WHERE tool_id IN (${placeholders})`).run(...obsoleteIds)
    if (info.changes > 0) {
      logger.info(`Cleaned up ${info.changes} obsolete employee_tools rows: ${obsoleteIds.join(', ')}`)
    }

    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES ('obsolete_employee_tools_cleanup_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()"
    ).run(CLEANUP_VERSION)
  }

  /**
   * 工具三态迁移：employee_tools 增加 tool_mode 列（on/on_demand/off），
   * 历史数据按原 is_enabled 与工具类型回填（常驻工具→on，按需工具→on_demand，关闭→off）
   */
  private migrateEmployeeToolMode(): void {
    const added = this.addColumnIfNotExists('employee_tools', 'tool_mode', "TEXT NOT NULL DEFAULT 'on'")
    if (!added) return

    const onDemandIds = [
      'date_time',
      'kms_search', 'kms_get_content', 'kms_list_collections',
      'javascript_exec',
      'calendar_event_list', 'calendar_event_create', 'calendar_event_update', 'calendar_event_delete',
      'calendar_todo_list', 'calendar_todo_create', 'calendar_todo_update', 'calendar_todo_delete',
      'calendar_todo_complete', 'calendar_todo_stats',
      'search_conversations', 'list_conversations', 'get_conversation_detail',
    ]
    const placeholders = onDemandIds.map(() => '?').join(',')
    this.db.prepare(
      `UPDATE employee_tools SET tool_mode = CASE
         WHEN is_enabled = 0 THEN 'off'
         WHEN tool_id IN (${placeholders}) THEN 'on_demand'
         ELSE 'on' END`
    ).run(...onDemandIds)
  }

  private migrateEmployeeMemoriesFTS(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM employee_memories_fts').get() as { n: number }
    if (count.n > 0) return
    const rows = this.db.prepare('SELECT id, employee_id, key, topic, content FROM employee_memories').all() as any[]
    if (rows.length === 0) return
    const insert = this.db.prepare(
      'INSERT INTO employee_memories_fts (key, topic, content, memory_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = this.db.transaction((items: any[]) => {
      for (const r of items) insert.run(r.key, r.topic, r.content, r.id, r.employee_id)
    })
    tx(rows)
    logger.info(`Migrated ${rows.length} employee_memories rows to FTS5 table`)
  }

  private migrateConversationsFTS(): void {
    // 版本化重建：当 preview 提取逻辑变更时，通过版本号触发全量重建
    const CONV_FTS_VERSION = 'v2'
    const versionRow = this.db.prepare("SELECT value FROM settings WHERE key = 'conversations_fts_version'").get() as { value: string } | undefined
    const currentVersion = versionRow?.value

    if (currentVersion === CONV_FTS_VERSION) return

    // 全量重建：清空后重新索引所有对话
    this.db.exec('DELETE FROM conversations_fts')
    const rows = this.db.prepare('SELECT id, employee_id, title, summary, messages_json FROM conversations').all() as any[]
    if (rows.length > 0) {
      const insert = this.db.prepare(
        'INSERT INTO conversations_fts (title, summary, content_preview, conversation_id, employee_id) VALUES (?, ?, ?, ?, ?)'
      )
      const tx = this.db.transaction((items: any[]) => {
        for (const r of items) {
          const preview = extractMessagePreview(r.messages_json)
          insert.run(r.title || '', r.summary || '', preview, r.id, r.employee_id)
        }
      })
      tx(rows)
    }

    // 记录版本号
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES ('conversations_fts_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()"
    ).run(CONV_FTS_VERSION)

    logger.info(`Rebuilt conversations_fts (${rows.length} rows) at version ${CONV_FTS_VERSION}`)
  }

  private migrateEmployeeAddWorkspacePath(): void {
    this.addColumnIfNotExists('employees', 'workspace_path', "TEXT DEFAULT ''")
    const tableInfo = this.db.prepare('PRAGMA table_info(employees)').all() as any[]
    const hasProjectId = tableInfo.some((c) => c.name === 'project_id')
    if (hasProjectId) {
      logger.info('Migrating employees: removing project_id column...')
      // 事务保护：DROP TABLE + RENAME 中途崩溃会导致数据丢失
      const migrateTx = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS employees_new (
            id TEXT PRIMARY KEY,
            workspace_path TEXT DEFAULT '',
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            avatar_type TEXT DEFAULT 'default',
            default_skill_id TEXT,
            profile_json TEXT DEFAULT '',
            arch_version INTEGER NOT NULL DEFAULT 1,
            total_tasks INTEGER DEFAULT 0,
            total_approvals INTEGER DEFAULT 0,
            memory_enabled BOOLEAN NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          );
          INSERT INTO employees_new (id, workspace_path, name, description, avatar_type, default_skill_id, profile_json, arch_version, total_tasks, total_approvals, memory_enabled, created_at, updated_at)
            SELECT id, '', name, description, avatar_type, default_skill_id, profile_json, arch_version, total_tasks, total_approvals, memory_enabled, created_at, updated_at FROM employees;
          DROP TABLE employees;
          ALTER TABLE employees_new RENAME TO employees;
        `)
      })
      migrateTx()
      logger.info('Migration completed: employees.project_id removed, workspace_path added')
    }
  }

  /** 移除 employees.status 字段及其索引（数字员工不再有"运行中"状态概念） */
  private migrateEmployeeDropStatus(): void {
    const tableInfo = this.db.prepare('PRAGMA table_info(employees)').all() as any[]
    const hasStatus = tableInfo.some((c) => c.name === 'status')
    if (!hasStatus) return
    logger.info('Migrating employees: dropping status column...')
    this.db.exec('DROP INDEX IF EXISTS idx_employees_status')
    this.dropColumnIfExists('employees', 'status')
    logger.info('Migration completed: employees.status column dropped')
  }

  private migrateConversationLastMessageAt(): void {
    const result = this.db.prepare('UPDATE conversations SET last_message_at = updated_at WHERE last_message_at IS NULL').run()
    if (result.changes > 0) {
      logger.info(`Migration: set last_message_at for ${result.changes} conversations`)
    }
  }

  /**
   * rules 列回填迁移：旧版系统提示词来源为 profile_json.roleDescription（优先）或 description，
   * 迁移后 description 转为纯描述用途（旧内容保留，可由用户重新生成简短描述）。
   */
  private migrateEmployeeRules(): void {
    try {
      const rows = this.db.prepare(
        "SELECT id, description, profile_json FROM employees WHERE rules IS NULL OR rules = ''"
      ).all() as Array<{ id: string; description?: string | null; profile_json?: string | null }>
      if (rows.length === 0) return

      const stmt = this.db.prepare('UPDATE employees SET rules = ? WHERE id = ?')
      const tx = this.db.transaction(() => {
        let applied = 0
        for (const r of rows) {
          let source = ''
          try {
            const profile = r.profile_json ? JSON.parse(r.profile_json) : null
            source = profile?.roleDescription || ''
          } catch { /* ignore invalid JSON */ }
          if (!source) source = (r.description || '').trim()
          if (source) {
            stmt.run(source, r.id)
            applied++
          }
        }
        logger.info(`Migration: employees.rules backfilled for ${applied}/${rows.length} rows`)
      })
      tx()
    } catch (err: any) {
      logger.warn('Migration: employees.rules backfill failed:', err?.message || err)
    }
  }

  private migrateEmployeeLastActiveAt(): void {
    const staleRows = this.db.prepare(
      `SELECT e.id AS emp_id, MAX(COALESCE(c.last_message_at, c.created_at)) AS latest
       FROM employees e
       LEFT JOIN conversations c ON c.employee_id = e.id
       WHERE e.last_active_at IS NULL
       GROUP BY e.id`
    ).all() as Array<{ emp_id: string; latest: number | null }>
    if (staleRows.length === 0) return
    const stmt = this.db.prepare('UPDATE employees SET last_active_at = ? WHERE id = ?')
    const tx = this.db.transaction((rows: typeof staleRows) => {
      let applied = 0
      for (const r of rows) {
        const val = r.latest ?? null
        stmt.run(val, r.emp_id)
        if (val !== null) applied++
      }
      logger.info(`Migration: employees.last_active_at initialised for ${rows.length} rows (${applied} have conversations)`)
    })
    tx(staleRows)
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
