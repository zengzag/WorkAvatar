/**
 * 插件通用数据访问实现（services.data）。
 * 把 5 个数据实体映射到宿主单例服务，统一 query/mutate 入口。
 * 采用依赖注入设计（宿主服务作为参数传入），便于单元测试 mock。
 */
import type {
  PluginDataEntity,
  PluginDataOp,
  PluginDataQueryParams,
} from '../../../../plugins/plugin-sdk/src'

/** 宿主服务依赖（由 plugin-host 注入真实单例，测试注入 mock） */
export interface DataAccessDeps {
  workspace: {
    getAllConversationsWithEmployee(params?: { limit?: number; offset?: number; employee_ids?: string[] }): unknown[]
    getConversation(id: string): unknown
    createConversation(employeeId: string, skillId?: string, title?: string, minimalMode?: boolean, parentConversationId?: string): unknown
    updateConversation(id: string, data: Record<string, unknown>): boolean
    deleteConversation(id: string): unknown
    getEmployeeList(): unknown[]
    getEmployee(id: string): unknown
    createEmployee(name: string, description?: string, profileJson?: string, rules?: string): unknown
    updateEmployee(id: string, data: Record<string, unknown>): unknown
    deleteEmployee(id: string, deleteWorkspace?: boolean): boolean
  }
  llm: {
    getProviderList(): unknown[]
    getProvider(id: string): unknown
    createProvider(params: Record<string, unknown>): Promise<unknown>
    updateProvider(id: string, params: Record<string, unknown>): Promise<unknown>
    deleteProvider(id: string): Promise<boolean>
  }
  memory: {
    listMemories(employeeId: string): unknown[]
    searchMemories(employeeId: string, query: string, limit?: number): unknown[]
    createMemory(params: Record<string, unknown>): unknown
    updateMemory(id: string, params: Record<string, unknown>): unknown
    deleteMemory(id: string): boolean
    togglePin(id: string): unknown
  }
  settings: {
    get(key: string): unknown
  }
}

/** 敏感字段剥离：llmProviders 返回前移除 api_key */
function stripSensitive(entity: PluginDataEntity, rows: unknown[]): unknown[] {
  if (entity !== 'llmProviders') return rows
  return rows.map((r) => {
    if (r && typeof r === 'object') {
      const { api_key, ...rest } = r as Record<string, unknown>
      return rest
    }
    return r
  })
}

/** 从查询参数提取 filter 中的 employeeId（memories 实体需要） */
function getEmployeeIdFilter(filter?: Record<string, unknown>): string | undefined {
  const v = filter?.employeeId ?? filter?.employee_id
  return typeof v === 'string' ? v : undefined
}

/** 从查询参数提取 filter 中的 query（memories 搜索需要） */
function getQueryFilter(filter?: Record<string, unknown>): string | undefined {
  const v = filter?.query
  return typeof v === 'string' ? v : undefined
}

/** 从查询参数提取 filter 中的 employee_ids（conversations 需要） */
function getEmployeeIdsFilter(filter?: Record<string, unknown>): string[] | undefined {
  const v = filter?.employeeIds ?? filter?.employee_ids
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return undefined
}

/** 构建通用数据访问服务 */
export function createDataAccessService(deps: DataAccessDeps) {
  return {
    async query<T = unknown>(entity: PluginDataEntity, params?: PluginDataQueryParams): Promise<T[]> {
      const filter = params?.filter
      const limit = params?.limit
      const offset = params?.offset

      switch (entity) {
        case 'conversations': {
          const employeeIds = getEmployeeIdsFilter(filter)
          const rows = deps.workspace.getAllConversationsWithEmployee({ limit, offset, employee_ids: employeeIds })
          return rows as T[]
        }
        case 'employees': {
          const rows = deps.workspace.getEmployeeList()
          return rows as T[]
        }
        case 'llmProviders': {
          const rows = deps.llm.getProviderList()
          return stripSensitive(entity, rows) as T[]
        }
        case 'memories': {
          const employeeId = getEmployeeIdFilter(filter)
          if (!employeeId) throw new Error('memories 查询需要 filter.employeeId')
          const query = getQueryFilter(filter)
          const rows = query
            ? deps.memory.searchMemories(employeeId, query, limit)
            : deps.memory.listMemories(employeeId)
          return rows as T[]
        }
        case 'settings': {
          const key = filter?.key
          if (typeof key !== 'string') throw new Error('settings 查询需要 filter.key')
          const value = deps.settings.get(key)
          return [value] as T[]
        }
        default:
          throw new Error(`未知数据实体: ${entity}`)
      }
    },

    async mutate<T = unknown>(entity: PluginDataEntity, op: PluginDataOp, payload: Record<string, unknown>): Promise<T> {
      switch (entity) {
        case 'conversations': {
          switch (op) {
            case 'create': {
              const employeeId = String(payload.employeeId ?? payload.employee_id ?? '')
              if (!employeeId) throw new Error('创建 conversation 需要 employeeId')
              const conv = deps.workspace.createConversation(
                employeeId,
                payload.skillId as string | undefined,
                payload.title as string | undefined,
                payload.minimalMode as boolean | undefined,
                payload.parentConversationId as string | undefined,
              )
              return conv as T
            }
            case 'update': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('更新 conversation 需要 id')
              const { id: _id, ...data } = payload
              deps.workspace.updateConversation(id, data)
              return undefined as T
            }
            case 'delete': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('删除 conversation 需要 id')
              return deps.workspace.deleteConversation(id) as T
            }
            default:
              throw new Error(`不支持的 conversation 操作: ${op}`)
          }
        }
        case 'employees': {
          switch (op) {
            case 'create': {
              const name = String(payload.name ?? '')
              if (!name) throw new Error('创建 employee 需要 name')
              return deps.workspace.createEmployee(
                name,
                payload.description as string | undefined,
                payload.profileJson as string | undefined,
                payload.rules as string | undefined,
              ) as T
            }
            case 'update': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('更新 employee 需要 id')
              const { id: _id, ...data } = payload
              return deps.workspace.updateEmployee(id, data) as T
            }
            case 'delete': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('删除 employee 需要 id')
              return deps.workspace.deleteEmployee(id, payload.deleteWorkspace as boolean | undefined) as T
            }
            default:
              throw new Error(`不支持的 employee 操作: ${op}`)
          }
        }
        case 'llmProviders': {
          switch (op) {
            case 'create':
              return await deps.llm.createProvider(payload) as T
            case 'update': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('更新 llmProvider 需要 id')
              const { id: _id, ...data } = payload
              return await deps.llm.updateProvider(id, data) as T
            }
            case 'delete': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('删除 llmProvider 需要 id')
              return await deps.llm.deleteProvider(id) as T
            }
            default:
              throw new Error(`不支持的 llmProvider 操作: ${op}`)
          }
        }
        case 'memories': {
          switch (op) {
            case 'create':
              return deps.memory.createMemory(payload) as T
            case 'update': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('更新 memory 需要 id')
              const { id: _id, ...data } = payload
              return deps.memory.updateMemory(id, data) as T
            }
            case 'delete': {
              const id = String(payload.id ?? '')
              if (!id) throw new Error('删除 memory 需要 id')
              return deps.memory.deleteMemory(id) as T
            }
            default:
              throw new Error(`不支持的 memory 操作: ${op}`)
          }
        }
        case 'settings':
          throw new Error('settings 为只读实体，不支持写操作')
        default:
          throw new Error(`未知数据实体: ${entity}`)
      }
    },
  }
}
