import type { SubAgentProfile } from '../types'

/** 子智能体模板（SubAgentProfile）管理通道 */
export const SUBAGENT_CHANNELS = {
  /** 列出全部子智能体模板 */
  SUBAGENT_PROFILE_LIST: 'subagent:profile-list',
  /** 删除子智能体模板（仅历史版本遗留的用户自建模板） */
  SUBAGENT_PROFILE_DELETE: 'subagent:profile-delete',
} as const

export interface SubAgentProfileResult {
  ok: boolean
  profile?: SubAgentProfile
  error?: string
}
