/**
 * 插件单测辅助：构造 mock PluginContext。
 * - storage.openSqlite 返回真实 better-sqlite3 内存库（:memory:），验证插件建表/CRUD
 * - ipc/contributions/services 用 vi.fn 记录调用，验证插件注册行为
 * 供 tests/unit/plugins/*.test.ts 使用。
 */
import { vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import type {
  PluginContext,
  PluginServices,
  PluginContributionsApi,
  PluginToolDefinition,
} from '../../../plugins/plugin-sdk/src'

/** 记录 IPC handler 注册（channel → handler） */
export interface MockIpc {
  handlers: Map<string, (payload: unknown) => unknown>
  broadcasts: Array<{ event: string; payload?: unknown }>
  handle: (channel: string, handler: (payload: unknown) => unknown) => void
  broadcast: (event: string, payload?: unknown) => void
}

/** 记录贡献点注册 */
export interface MockContributions {
  agentTools: PluginToolDefinition[]
  mcpTools: unknown[]
  fileAssociations: Map<string, string>
  shortcuts: unknown[]
  messageActions: unknown[]
  views: unknown[]
  commands: unknown[]
  registerAgentTools: (tools: PluginToolDefinition[]) => void
  registerMcpTools: (tools: unknown[]) => void
  registerFileAssociations: (assocs: Array<{ extension: string }>) => void
  registerGlobalShortcuts: (shortcuts: unknown[]) => void
  registerMessageActions: (actions: unknown[]) => void
  registerView: (view: unknown) => void
  registerCommand: (command: unknown) => void
}

/** 记录事件订阅 */
export interface MockEvents {
  subscriptions: Array<{ event: string; callback: (payload: unknown) => void }>
  publishes: Array<{ event: string; payload?: unknown }>
  subscribe: (event: string, callback: (payload: unknown) => void) => () => void
  publish: (event: string, payload?: unknown) => void
}

/** 构造 mock PluginContext */
export function createMockContext(pluginId = 'test-plugin'): {
  ctx: PluginContext
  ipc: MockIpc
  contributions: MockContributions
  events: MockEvents
  dbs: Map<string, DatabaseSync>
  services: PluginServices
} {
  const dbs = new Map<string, DatabaseSync>()

  const ipc: MockIpc = {
    handlers: new Map(),
    broadcasts: [],
    handle: (channel, handler) => {
      ipc.handlers.set(channel, handler)
    },
    broadcast: (event, payload) => {
      ipc.broadcasts.push({ event, payload })
    },
  }

  const contributions: MockContributions = {
    agentTools: [],
    mcpTools: [],
    fileAssociations: new Map(),
    shortcuts: [],
    messageActions: [],
    views: [],
    commands: [],
    registerAgentTools: (tools) => { contributions.agentTools.push(...tools) },
    registerMcpTools: (tools) => { contributions.mcpTools.push(...tools) },
    registerFileAssociations: (assocs) => {
      for (const a of assocs) contributions.fileAssociations.set(a.extension.toLowerCase(), pluginId)
    },
    registerGlobalShortcuts: (shortcuts) => { contributions.shortcuts.push(...shortcuts) },
    registerMessageActions: (actions) => { contributions.messageActions.push(...actions) },
    registerView: (view) => { contributions.views.push(view) },
    registerCommand: (command) => { contributions.commands.push(command) },
  }

  const events: MockEvents = {
    subscriptions: [],
    publishes: [],
    subscribe: (event, callback) => {
      events.subscriptions.push({ event, callback })
      return () => { /* noop */ }
    },
    publish: (event, payload) => {
      events.publishes.push({ event, payload })
    },
  }

  const services: PluginServices = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    host: {
      getDataDir: () => path.join(os.tmpdir(), 'wa-mock-data'),
    },
    data: {
      query: vi.fn(async () => []),
      mutate: vi.fn(async () => ({})),
    },
    execute: {
      execute: vi.fn(async () => ({})),
    },
    events,
    notification: {
      notify: vi.fn(() => true),
    },
    scheduler: {
      every: vi.fn(() => 'job-1'),
      cron: vi.fn(() => 'job-2'),
      cancel: vi.fn(),
    },
    windows: {
      create: vi.fn(() => ({
        id: 'win-1',
        close: vi.fn(),
        send: vi.fn(),
        onClosed: vi.fn(),
        setSize: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        isVisible: vi.fn(() => true),
      })),
    },
    native: {
      borrow: vi.fn(() => null),
      modulePath: vi.fn(() => ''),
    },
  }

  const ctx: PluginContext = {
    manifest: {
      id: pluginId,
      name: pluginId,
      version: '1.0.0',
      engine: '>=0.2.0',
      main: 'dist/main/index.cjs',
    },
    hostVersion: '0.7.0',
    paths: {
      root: path.join(os.tmpdir(), 'wa-mock-plugins', pluginId),
      data: path.join(os.tmpdir(), 'wa-mock-plugin-data', pluginId),
      resources: path.join(os.tmpdir(), 'wa-mock-plugins', pluginId, 'resources'),
    },
    ipc: {
      handle: ipc.handle,
      broadcast: ipc.broadcast,
    },
    storage: {
      rootDir: path.join(os.tmpdir(), 'wa-mock-plugins', pluginId),
      resourcesDir: path.join(os.tmpdir(), 'wa-mock-plugins', pluginId, 'resources'),
      dataDir: path.join(os.tmpdir(), 'wa-mock-plugin-data', pluginId),
      openSqlite: (name?: string) => {
        const key = name || 'index'
        let db = dbs.get(key)
        if (!db) {
          db = new DatabaseSync(':memory:')
          dbs.set(key, db)
        }
        // 封装 node:sqlite 为 PluginDatabase 兼容接口（补 pragma/transaction）
        const raw = db as unknown as {
          prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
          exec(sql: string): void
          function(name: string, fn: (...a: unknown[]) => unknown): void
          close(): void
        }
        return {
          prepare: (sql: string) => raw.prepare(sql),
          exec: (sql: string) => raw.exec(sql),
          function: (name: string, fn: (...a: unknown[]) => unknown) => raw.function(name, fn),
          pragma: () => { /* node:sqlite 无 pragma，忽略 */ },
          transaction: <T,>(fn: () => T): T => {
            raw.exec('BEGIN')
            try {
              const result = fn()
              raw.exec('COMMIT')
              return result
            } catch (err) {
              raw.exec('ROLLBACK')
              throw err
            }
          },
          close: () => raw.close(),
        }
      },
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      keys: vi.fn(async () => []),
    },
    services,
    contributions: {
      registerAgentTools: contributions.registerAgentTools,
      registerMcpTools: contributions.registerMcpTools,
      registerFileAssociations: contributions.registerFileAssociations,
      registerGlobalShortcuts: contributions.registerGlobalShortcuts,
      registerMessageActions: contributions.registerMessageActions,
      registerView: contributions.registerView,
      registerCommand: contributions.registerCommand,
    },
  }

  return { ctx, ipc, contributions, events, dbs, services }
}
