/**
 * 插件能力域授权校验（v2 协议）。
 * 纯逻辑模块，不依赖宿主运行时，便于单元测试。
 * manifest.capabilities 声明插件可访问的能力域，宿主在服务入口统一校验。
 */
import type {
  PluginCapability,
  PluginDataEntity,
  PluginExecuteKind,
  PluginKmsQueryType,
  PluginSystemFeature,
  PluginViewPoint,
} from '../../../../plugins/plugin-sdk/src'

/** 能力校验结果 */
export type CapabilityCheck =
  | { ok: true }
  | { ok: false; reason: string }

/** 从 capabilities 数组中提取指定 domain 的声明 */
export function getCapability(
  capabilities: PluginCapability[] | undefined,
  domain: PluginCapability['domain']
): PluginCapability | undefined {
  if (!capabilities) return undefined
  return capabilities.find(c => c.domain === domain)
}

/** 校验数据访问：实体是否在 data 白名单，且满足读写要求 */
export function canAccessData(
  capabilities: PluginCapability[] | undefined,
  entity: PluginDataEntity,
  access: 'read' | 'write'
): CapabilityCheck {
  const cap = getCapability(capabilities, 'data')
  if (!cap || cap.domain !== 'data') {
    return { ok: false, reason: `未声明 data 能力域` }
  }
  if (!cap.entities.includes(entity)) {
    return { ok: false, reason: `实体 "${entity}" 未在 data 能力域白名单内` }
  }
  if (access === 'write' && cap.access !== 'write') {
    return { ok: false, reason: `实体 "${entity}" 仅声明只读访问，不允许写操作` }
  }
  return { ok: true }
}

/** 校验执行入口：kind 是否在 execute 白名单 */
export function canExecute(
  capabilities: PluginCapability[] | undefined,
  kind: PluginExecuteKind
): CapabilityCheck {
  const cap = getCapability(capabilities, 'execute')
  if (!cap || cap.domain !== 'execute') {
    return { ok: false, reason: `未声明 execute 能力域` }
  }
  if (!cap.kinds.includes(kind)) {
    return { ok: false, reason: `执行类型 "${kind}" 未在 execute 能力域白名单内` }
  }
  return { ok: true }
}

/** 校验事件订阅：事件是否在 subscribe 白名单 */
export function canSubscribeEvent(
  capabilities: PluginCapability[] | undefined,
  event: string
): CapabilityCheck {
  const cap = getCapability(capabilities, 'events')
  if (!cap || cap.domain !== 'events') {
    return { ok: false, reason: `未声明 events 能力域` }
  }
  const allowed = cap.subscribe ?? []
  if (!allowed.includes(event)) {
    return { ok: false, reason: `事件 "${event}" 未在 events 能力域 subscribe 白名单内` }
  }
  return { ok: true }
}

/** 校验事件发布：是否声明 publish 能力 */
export function canPublishEvent(
  capabilities: PluginCapability[] | undefined
): CapabilityCheck {
  const cap = getCapability(capabilities, 'events')
  if (!cap || cap.domain !== 'events') {
    return { ok: false, reason: `未声明 events 能力域` }
  }
  if (!cap.publish) {
    return { ok: false, reason: `未声明 events 能力域 publish 能力` }
  }
  return { ok: true }
}

/** 校验 UI 视图注入：view 是否在 ui 白名单 */
export function canRegisterView(
  capabilities: PluginCapability[] | undefined,
  view: PluginViewPoint
): CapabilityCheck {
  const cap = getCapability(capabilities, 'ui')
  if (!cap || cap.domain !== 'ui') {
    return { ok: false, reason: `未声明 ui 能力域` }
  }
  if (!cap.views.includes(view)) {
    return { ok: false, reason: `注入点 "${view}" 未在 ui 能力域 views 白名单内` }
  }
  return { ok: true }
}

/** 校验系统能力特性：feature 是否在 system 白名单 */
export function hasSystemFeature(
  capabilities: PluginCapability[] | undefined,
  feature: PluginSystemFeature
): boolean {
  const cap = getCapability(capabilities, 'system')
  if (!cap || cap.domain !== 'system') return false
  return cap.features.includes(feature)
}

/** 校验 KMS 查询类型：kind 是否在 kms 白名单 */
export function canQueryKms(
  capabilities: PluginCapability[] | undefined,
  kind: PluginKmsQueryType
): CapabilityCheck {
  const cap = getCapability(capabilities, 'kms')
  if (!cap || cap.domain !== 'kms') {
    return { ok: false, reason: '未声明 kms 能力域' }
  }
  if (!cap.query.includes(kind)) {
    return { ok: false, reason: `KMS 查询类型 "${kind}" 未在 kms 能力域白名单内` }
  }
  return { ok: true }
}

/** 是否声明 collaboration 协作能力域 */
export function hasCollaboration(
  capabilities: PluginCapability[] | undefined
): boolean {
  const cap = getCapability(capabilities, 'collaboration')
  return !!cap && cap.domain === 'collaboration'
}

/** 读取 collaboration.shared 声明（未声明返回 undefined） */
export function getSharedCapability(
  capabilities: PluginCapability[] | undefined
): { read?: boolean; write: boolean } | undefined {
  const cap = getCapability(capabilities, 'collaboration')
  if (!cap || cap.domain !== 'collaboration' || !cap.shared) return undefined
  return cap.shared
}

/** 校验跨插件调用：目标方法是否在 collaboration.call 白名单 */
export function canCallPlugin(
  capabilities: PluginCapability[] | undefined,
  targetMethod: string
): CapabilityCheck {
  const cap = getCapability(capabilities, 'collaboration')
  if (!cap || cap.domain !== 'collaboration') {
    return { ok: false, reason: '未声明 collaboration 能力域' }
  }
  const call = cap.call ?? []
  if (!call.includes(targetMethod)) {
    return { ok: false, reason: `跨插件方法 "${targetMethod}" 未在 collaboration.call 白名单内` }
  }
  return { ok: true }
}

/** 校验 manifest 的 capabilities 结构合法性（schema 校验） */
export function validateCapabilities(
  capabilities: PluginCapability[] | undefined
): CapabilityCheck {
  if (!capabilities) return { ok: true }
  if (!Array.isArray(capabilities)) {
    return { ok: false, reason: 'capabilities 必须是数组' }
  }
  const seen = new Set<string>()
  for (const cap of capabilities) {
    if (!cap || typeof cap !== 'object') {
      return { ok: false, reason: 'capabilities 元素必须是对象' }
    }
    const domain = (cap as { domain?: string }).domain
    if (!domain || seen.has(domain)) {
      return { ok: false, reason: `capabilities 存在缺失或重复的 domain: ${domain}` }
    }
    seen.add(domain)
    switch (domain) {
      case 'data': {
        const c = cap as { entities?: unknown; access?: unknown }
        if (!Array.isArray(c.entities) || c.entities.length === 0) {
          return { ok: false, reason: 'data 能力域必须声明非空 entities' }
        }
        if (c.access !== 'read' && c.access !== 'write') {
          return { ok: false, reason: 'data 能力域 access 必须是 read 或 write' }
        }
        break
      }
      case 'execute': {
        const c = cap as { kinds?: unknown }
        if (!Array.isArray(c.kinds) || c.kinds.length === 0) {
          return { ok: false, reason: 'execute 能力域必须声明非空 kinds' }
        }
        break
      }
      case 'events': {
        const c = cap as { subscribe?: unknown; publish?: unknown }
        if (c.subscribe !== undefined && !Array.isArray(c.subscribe)) {
          return { ok: false, reason: 'events 能力域 subscribe 必须是数组' }
        }
        if (c.publish !== undefined && typeof c.publish !== 'boolean') {
          return { ok: false, reason: 'events 能力域 publish 必须是布尔值' }
        }
        break
      }
      case 'ui': {
        const c = cap as { views?: unknown }
        if (!Array.isArray(c.views)) {
          return { ok: false, reason: 'ui 能力域必须声明 views 数组' }
        }
        break
      }
      case 'system': {
        const c = cap as { features?: unknown }
        if (!Array.isArray(c.features)) {
          return { ok: false, reason: 'system 能力域必须声明 features 数组' }
        }
        break
      }
      case 'kms': {
        const c = cap as { query?: unknown }
        if (!Array.isArray(c.query) || c.query.length === 0) {
          return { ok: false, reason: 'kms 能力域必须声明非空 query 数组' }
        }
        const allowed = ['search', 'content', 'collections']
        if (c.query.some((q: unknown) => typeof q !== 'string' || !allowed.includes(q))) {
          return { ok: false, reason: 'kms 能力域 query 含非法类型' }
        }
        break
      }
      case 'collaboration': {
        const c = cap as { shared?: unknown; call?: unknown }
        if (c.shared !== undefined) {
          const s = c.shared as { read?: unknown; write?: unknown }
          if (typeof s !== 'object' || s === null) {
            return { ok: false, reason: 'collaboration.shared 必须是对象' }
          }
          if (s.read !== undefined && typeof s.read !== 'boolean') {
            return { ok: false, reason: 'collaboration.shared.read 必须是布尔值' }
          }
          if (s.write !== undefined && typeof s.write !== 'boolean') {
            return { ok: false, reason: 'collaboration.shared.write 必须是布尔值' }
          }
        }
        if (c.call !== undefined && !Array.isArray(c.call)) {
          return { ok: false, reason: 'collaboration.call 必须是数组' }
        }
        break
      }
      default:
        return { ok: false, reason: `未知能力域: ${domain}` }
    }
  }
  return { ok: true }
}
