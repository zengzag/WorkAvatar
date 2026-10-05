import type { SubAgentProfile } from '../types'

/** 子智能体模板（SubAgentProfile）管理通道 */
export const SUBAGENT_CHANNELS = {
  /** 列出全部子智能体模板 */
  SUBAGENT_PROFILE_LIST: 'subagent:profile-list',
  /** 创建子智能体模板 */
  SUBAGENT_PROFILE_CREATE: 'subagent:profile-create',
  /** 更新子智能体模板（部分字段，缺省沿用旧值） */
  SUBAGENT_PROFILE_UPDATE: 'subagent:profile-update',
  /** 删除子智能体模板（仅 user 来源） */
  SUBAGENT_PROFILE_DELETE: 'subagent:profile-delete',
} as const

export interface SubAgentProfileCreateParams {
  name?: string
  description?: string
  system_prompt?: string
  /** 工具 id 白名单（可选） */
  tools?: string[]
  /** 技能 id 列表（可选） */
  skills?: string[]
  provider_id?: string | null
  model_id?: string | null
}

export interface SubAgentProfileUpdateParams extends SubAgentProfileCreateParams {
  id: string
}

export interface SubAgentProfileResult {
  ok: boolean
  profile?: SubAgentProfile
  error?: string
}
