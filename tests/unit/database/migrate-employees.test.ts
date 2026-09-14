import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * P0 复现：旧库（含 employees.project_id）升级到当前版本时的迁移正确性。
 * 修复前：employees_new 重建表遗漏 rules/last_active_at/delegation_json/is_registered 列，
 *        且 migrateEmployeeLastActiveAt 随即查询 last_active_at 抛 no such column，
 *        DatabaseService 构造失败 → 应用无法启动 + 用户数据（rules/delegation_json）丢失。
 */

const dataDirs: string[] = []

vi.mock('../../../electron/main/services/path.service', () => {
  const actualDataDir = () => dataDirs[dataDirs.length - 1]!
  const mockGetInstance = () => ({
    getDataDir: actualDataDir,
    getDbPath: () => path.join(actualDataDir(), 'workavatar.db'),
  })
  return { default: { getInstance: mockGetInstance } }
})

function seedLegacyProjectDb(dataDir: string): void {
  const db = new Database(path.join(dataDir, 'workavatar.db'))
  db.pragma('journal_mode = WAL')
  // 旧版「项目制」employees 表：含 project_id，不含新版列（rules/memory_enabled/last_active_at/delegation_json/is_registered/workspace_path）
  db.exec(`
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      avatar_type TEXT DEFAULT 'default',
      default_skill_id TEXT,
      profile_json TEXT DEFAULT '',
      arch_version INTEGER NOT NULL DEFAULT 1,
      total_tasks INTEGER DEFAULT 0,
      total_approvals INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      messages_json TEXT DEFAULT '[]',
      message_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  db.prepare(
    `INSERT INTO employees (id, project_id, name, description, avatar_type, profile_json)
     VALUES ('emp-1', 'p1', '测试员工', '描述', 'default', '{"roleDescription":"旧角色提示词"}')`
  ).run()
  db.close()
}

describe('database.service / 旧库 employees.project_id 迁移', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // better-sqlite3 为 Electron ABI 编译（NODE_MODULE_VERSION 133），Node 测试环境无法加载。
  // 保留复现脚本：在 Electron 环境或重编 native 模块后移除 skip 即可运行。
  it.skip('带 project_id 的旧库升级后 rules/last_active_at 等列仍存在且数据保留', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-db-mig-'))
    dataDirs.push(dir)
    try {
      seedLegacyProjectDb(dir)
      const { default: DatabaseService } = await import('../../../electron/main/services/database.service')
      // 修复前：构造期间在 migrateEmployeeLastActiveAt 抛 no such column: last_active_at
      const svc = DatabaseService.getInstance()
      const db = svc.getDb()
      const cols = (db.prepare('PRAGMA table_info(employees)').all() as any[]).map(c => c.name)
      expect(cols).toContain('rules')
      expect(cols).toContain('last_active_at')
      expect(cols).toContain('delegation_json')
      expect(cols).toContain('is_registered')
      expect(cols).not.toContain('project_id')
      // 旧数据仍在
      const row = db.prepare('SELECT name FROM employees WHERE id = ?').get('emp-1') as any
      expect(row?.name).toBe('测试员工')
      svc.close()
    } finally {
      dataDirs.pop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
