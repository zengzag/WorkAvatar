import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

class DatabaseService {
  private db: Database.Database
  private static instance: DatabaseService

  private constructor() {
    const isDev = !app.isPackaged
    const basePath = isDev
      ? path.join(process.cwd(), '.workavatar-data')
      : app.getPath('userData')
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true })
    }
    const dbPath = path.join(basePath, 'workavatar.db')
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
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        root_path TEXT NOT NULL,
        llm_provider_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        original_name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        parsed_json TEXT,
        thumbnail_text TEXT,
        rule_count INTEGER DEFAULT 0,
        qa_count INTEGER DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS file_annotations (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

      CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
      CREATE INDEX IF NOT EXISTS idx_file_annotations_file ON file_annotations(file_id);
      CREATE INDEX IF NOT EXISTS idx_employees_project ON employees(project_id);
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

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        root_path TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
        original_name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        hash TEXT NOT NULL,
        content_text TEXT,
        parsed_json TEXT,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        parse_error TEXT,
        parse_progress REAL NOT NULL DEFAULT 0,
        parse_stage TEXT DEFAULT '',
        parse_detail TEXT DEFAULT '',
        processed_pages INTEGER DEFAULT 0,
        total_pages INTEGER DEFAULT 0,
        processed_chunks INTEGER DEFAULT 0,
        total_chunks INTEGER DEFAULT 0,
        parse_speed REAL DEFAULT 0,
        parse_eta INTEGER DEFAULT 0,
        parse_state_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS kb_project_links (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_documents_hash ON kb_documents(hash);
      CREATE INDEX IF NOT EXISTS idx_kb_project_links_kb ON kb_project_links(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_project_links_project ON kb_project_links(project_id);

      CREATE TABLE IF NOT EXISTS wiki_compile_cache (
        id TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        source_slug TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        kb_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_wiki_compile_cache_hash ON wiki_compile_cache(source_hash);

      CREATE TABLE IF NOT EXISTS kb_chapters (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        chapter_index INTEGER NOT NULL DEFAULT 0,
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        summary TEXT,
        keywords_json TEXT DEFAULT '[]',
        entities_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_chapters_document ON kb_chapters(document_id);
      CREATE INDEX IF NOT EXISTS idx_kb_chapters_kb ON kb_chapters(kb_id);

      CREATE TABLE IF NOT EXISTS kb_document_summaries (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL UNIQUE REFERENCES kb_documents(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '',
        key_entities_json TEXT DEFAULT '[]',
        timeline_json TEXT DEFAULT '[]',
        keywords_json TEXT DEFAULT '[]',
        main_topics_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_document_summaries_kb ON kb_document_summaries(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_document_summaries_doc ON kb_document_summaries(document_id);

      CREATE TABLE IF NOT EXISTS kb_global_summaries (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL UNIQUE REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        summary TEXT NOT NULL DEFAULT '',
        key_topics_json TEXT DEFAULT '[]',
        key_entities_json TEXT DEFAULT '[]',
        global_timeline_json TEXT DEFAULT '[]',
        vector_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_global_summaries_kb ON kb_global_summaries(kb_id);

      CREATE TABLE IF NOT EXISTS kb_entities (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        description TEXT DEFAULT '',
        aliases_json TEXT DEFAULT '[]',
        attributes_json TEXT DEFAULT '{}',
        mention_count INTEGER NOT NULL DEFAULT 0,
        first_seen_doc_id TEXT REFERENCES kb_documents(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_entities_kb ON kb_entities(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entities_name ON kb_entities(kb_id, name);

      CREATE TABLE IF NOT EXISTS kb_entity_relations (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        target_entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'related_to',
        description TEXT DEFAULT '',
        source_document_id TEXT REFERENCES kb_documents(id) ON DELETE SET NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_source ON kb_entity_relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_target ON kb_entity_relations(target_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_kb ON kb_entity_relations(kb_id);

      CREATE TABLE IF NOT EXISTS kb_entity_mentions (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES kb_chapters(id) ON DELETE SET NULL,
        context_text TEXT DEFAULT '',
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_entity ON kb_entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_document ON kb_entity_mentions(document_id);
      CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_chapter ON kb_entity_mentions(chapter_id);

      CREATE TABLE IF NOT EXISTS kb_processing_jobs (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES kb_documents(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0,
        current_step TEXT DEFAULT '',
        error_message TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_kb_processing_jobs_kb ON kb_processing_jobs(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kb_processing_jobs_status ON kb_processing_jobs(status);

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
    this.addColumnIfNotExists('employees', 'profile_json', 'TEXT DEFAULT \'\'')
    this.addColumnIfNotExists('kb_documents', 'parse_progress', 'REAL NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'parse_stage', 'TEXT DEFAULT \'\'')
    this.addColumnIfNotExists('kb_documents', 'parse_detail', 'TEXT DEFAULT \'\'')
    this.addColumnIfNotExists('kb_documents', 'processed_pages', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'total_pages', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'processed_chunks', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'total_chunks', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'parse_speed', 'REAL DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'parse_eta', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists('kb_documents', 'parse_state_json', 'TEXT')
    this.addColumnIfNotExists('kb_documents', 'is_reused', 'INTEGER NOT NULL DEFAULT 0')
    this.addColumnIfNotExists('kb_processing_jobs', 'paused_at', 'INTEGER')
    this.addColumnIfNotExists('kb_processing_jobs', 'resume_state_json', 'TEXT')

    this.recoverStuckDocs()
  }

  private recoverStuckDocs(): void {
    const parsingResult = this.db.prepare(`
      UPDATE kb_documents 
      SET parse_status = 'paused'
      WHERE parse_status = 'parsing'
    `).run()
    if (parsingResult.changes > 0) {
      console.log(`[DB] Recovered ${parsingResult.changes} document(s) from parsing to paused status`)
    }

    this.db.prepare(`
      UPDATE kb_processing_jobs 
      SET status = 'paused'
      WHERE status = 'running'
    `).run()

    const runningTasksResult = this.db.prepare(`
      UPDATE background_tasks
      SET status = 'paused'
      WHERE status IN ('running', 'pending')
    `).run()
    if (runningTasksResult.changes > 0) {
      console.log(`[DB] Recovered ${runningTasksResult.changes} background task(s) from running/pending to paused status`)
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
