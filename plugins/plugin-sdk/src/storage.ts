/**
 * 插件存储与数据迁移契约。
 * - 插件数据完全自包含：sqlite 分库 + KV 均在 userData/plugin-data/<id>/ 下
 * - 内置插件迁出内核数据走一次性 migrations（原子事务 + 版本记录）
 */
import type { PluginLogger } from './services'

/** better-sqlite3 语句的结构化子集（第三方插件无需安装其类型包） */
export interface PluginSqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  iterate(...params: unknown[]): IterableIterator<unknown>
}

/** better-sqlite3 数据库连接的结构化子集 */
export interface PluginDatabase {
  prepare(sql: string): PluginSqlStatement
  exec(sql: string): void
  /** 注册自定义 SQL 函数（FTS5 分词等场景） */
  function(name: string, fn: (...args: unknown[]) => unknown): void
  pragma(source: string): unknown
  transaction<T>(fn: () => T): T
  close(): void
}

export interface PluginStorage {
  /** 插件根目录（只读资源所在） */
  readonly rootDir: string
  /** 插件专属资源目录（模型文件等，已 asarUnpack） */
  readonly resourcesDir: string
  /** 插件数据目录 userData/plugin-data/<id>/（可写） */
  readonly dataDir: string
  /** 打开/创建插件分库 userData/plugin-data/<id>/<name|index>.db（WAL 模式） */
  openSqlite(name?: string): PluginDatabase
  /** 插件作用域 KV（存储于插件自己的库，不写内核 settings 表） */
  get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

/** 内核主库只读访问（需 legacyMigration 权限；非 SELECT 语句直接抛错） */
export interface PluginLegacyDatabase {
  listTables(): string[]
  all(sql: string, ...params: unknown[]): unknown[]
  get(sql: string, ...params: unknown[]): unknown
  /** 读内核 settings 表 KV（供插件搬走自有配置项） */
  getSetting(key: string): unknown
}

export interface PluginMigrationContext {
  storage: PluginStorage
  /** 未声明 legacyMigration 权限时为 null */
  legacy: PluginLegacyDatabase | null
  logger: PluginLogger
}

/**
 * 一次性迁移单元。宿主按序执行未应用的迁移，
 * 每个迁移在插件库的独立事务中运行，成功后写入 plugin_migrations 版本记录。
 */
export interface PluginMigration {
  /** 迁移版本号（插件内唯一，建议递增，如 '1-legacy-tables'） */
  version: string
  description?: string
  run(ctx: PluginMigrationContext): Promise<void> | void
}
