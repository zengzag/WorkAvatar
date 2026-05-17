import Database from 'better-sqlite3'
import fs from 'fs'
import PathService from './path.service'
import { createLogger } from './logger'

const logger = createLogger('DB')

class DatabaseService {
  private db: Database.Database
  private static instance: DatabaseService

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

    // 启用WAL模式以提升并发读性能
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.initializeSchema()
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
  }

  private addColumnIfNotExists(table: string, column: string, definition: string): void {
    const result = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]
    const columnExists = result.some((c) => c.name === column)
    if (!columnExists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        workspace_path TEXT DEFAULT '',
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        avatar_type TEXT DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'draft',
        review_mode BOOLEAN NOT NULL DEFAULT 0,
        default_skill_id TEXT,
        llm_provider_id TEXT,
        llm_model TEXT,
        profile_json TEXT DEFAULT '',
        arch_version INTEGER NOT NULL DEFAULT 1,
        total_tasks INTEGER DEFAULT 0,
        total_approvals INTEGER DEFAULT 0,
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
        temperature REAL DEFAULT 0.3,
        max_tokens INTEGER DEFAULT 4096,
        timeout_ms INTEGER DEFAULT 60000,
        extra_headers_json TEXT,
        extra_body_json TEXT,
        is_default BOOLEAN DEFAULT 0,
        models_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        nodes_json TEXT NOT NULL DEFAULT '[]',
        edges_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        node_executions_json TEXT NOT NULL DEFAULT '{}',
        started_at INTEGER,
        completed_at INTEGER,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);

      CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
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

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]',
        env_json TEXT DEFAULT '{}',
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        status TEXT DEFAULT 'disconnected',
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

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

      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL NOT NULL DEFAULT 0,
        progress_text TEXT DEFAULT '',
        error TEXT,
        metadata_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        paused_at INTEGER,
        resumed_at INTEGER,
        speed REAL DEFAULT 0,
        eta INTEGER DEFAULT 0,
        stage TEXT DEFAULT '',
        detail TEXT DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_background_tasks_type ON background_tasks(type);

      CREATE TABLE IF NOT EXISTS employee_tasks (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        prompt TEXT NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        timeout_ms INTEGER DEFAULT 300000,
        extra_config_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_tasks_employee ON employee_tasks(employee_id);

      CREATE TABLE IF NOT EXISTS employee_schedules (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        task_ids_json TEXT NOT NULL DEFAULT '[]',
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_employee_schedules_employee ON employee_schedules(employee_id);

      CREATE TABLE IF NOT EXISTS employee_task_executions (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES employee_tasks(id) ON DELETE CASCADE,
        schedule_id TEXT REFERENCES employee_schedules(id) ON DELETE SET NULL,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'running',
        result_text TEXT,
        error_message TEXT,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        duration_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_employee_task_executions_employee ON employee_task_executions(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_task_executions_task ON employee_task_executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_employee_task_executions_status ON employee_task_executions(status);

      CREATE TABLE IF NOT EXISTS employee_kb_links (
        employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (employee_id, kb_id)
      );

      CREATE INDEX IF NOT EXISTS idx_employee_kb_links_employee ON employee_kb_links(employee_id);
      CREATE INDEX IF NOT EXISTS idx_employee_kb_links_kb ON employee_kb_links(kb_id);
    `)

    this.addColumnIfNotExists('employee_tasks', 'llm_provider_id', 'TEXT')
    this.addColumnIfNotExists('employee_tasks', 'llm_model', 'TEXT')
    this.addColumnIfNotExists('employee_tasks', 'enable_thinking', 'BOOLEAN NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('employee_tasks', 'run_mode', "TEXT NOT NULL DEFAULT 'recurring'")
    this.addColumnIfNotExists('employee_task_executions', 'segments_json', 'TEXT')
    this.addColumnIfNotExists('employee_schedules', 'run_mode', "TEXT NOT NULL DEFAULT 'recurring'")
    this.addColumnIfNotExists('employee_schedules', 'notify_on_complete', 'BOOLEAN NOT NULL DEFAULT 1')

    this.addColumnIfNotExists('llm_providers', 'embedding_model', 'TEXT DEFAULT \'text-embedding-3-small\'')
    this.addColumnIfNotExists('llm_providers', 'models_json', 'TEXT DEFAULT \'[]\'')
    this.addColumnIfNotExists('llm_providers', 'extra_body_json', 'TEXT')
    this.addColumnIfNotExists('employees', 'profile_json', 'TEXT DEFAULT \'')

    this.migrateEmployeeAddWorkspacePath()
    this.migrateWorkflowRemoveProjectId()

    this.recoverStuckDocs()
  }

  private migrateEmployeeAddWorkspacePath(): void {
    this.addColumnIfNotExists('employees', 'workspace_path', "TEXT DEFAULT ''")
    const tableInfo = this.db.prepare('PRAGMA table_info(employees)').all() as any[]
    const hasProjectId = tableInfo.some((c) => c.name === 'project_id')
    if (hasProjectId) {
      logger.info('Migrating employees: removing project_id column...')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS employees_new (
          id TEXT PRIMARY KEY,
          workspace_path TEXT DEFAULT '',
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          avatar_type TEXT DEFAULT 'default',
          status TEXT NOT NULL DEFAULT 'draft',
          review_mode BOOLEAN NOT NULL DEFAULT 0,
          default_skill_id TEXT,
          llm_provider_id TEXT,
          llm_model TEXT,
          profile_json TEXT DEFAULT '',
          arch_version INTEGER NOT NULL DEFAULT 1,
          total_tasks INTEGER DEFAULT 0,
          total_approvals INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO employees_new (id, workspace_path, name, description, avatar_type, status, review_mode, default_skill_id, llm_provider_id, llm_model, profile_json, arch_version, total_tasks, total_approvals, created_at, updated_at)
          SELECT id, '', name, description, avatar_type, status, review_mode, default_skill_id, llm_provider_id, llm_model, profile_json, arch_version, total_tasks, total_approvals, created_at, updated_at FROM employees;
        DROP TABLE employees;
        ALTER TABLE employees_new RENAME TO employees;
        CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
      `)
      logger.info('Migration completed: employees.project_id removed, workspace_path added')
    }
  }

  private migrateWorkflowRemoveProjectId(): void {
    const tableInfo = this.db.prepare('PRAGMA table_info(workflows)').all() as any[]
    const hasProjectId = tableInfo.some((c) => c.name === 'project_id')
    if (hasProjectId) {
      logger.info('Migrating workflows: removing project_id column...')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflows_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          nodes_json TEXT NOT NULL DEFAULT '[]',
          edges_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'draft',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO workflows_new (id, name, description, nodes_json, edges_json, status, created_at, updated_at)
          SELECT id, name, description, nodes_json, edges_json, status, created_at, updated_at FROM workflows;
        DROP TABLE workflows;
        ALTER TABLE workflows_new RENAME TO workflows;
      `)
      logger.info('Migration completed: workflows.project_id removed')
    }
  }

  private recoverStuckDocs(): void {
    const runningTasksResult = this.db.prepare(`
      UPDATE background_tasks
      SET status = 'paused'
      WHERE status IN ('running', 'pending')
    `).run()
    if (runningTasksResult.changes > 0) {
      logger.info(`Recovered ${runningTasksResult.changes} background task(s) from running/pending to paused status`)
    }
  }

  public getDb(): Database.Database {
    return this.db
  }

  public close(): void {
    this.db.close()
  }
}

export default DatabaseService
