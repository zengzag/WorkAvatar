import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SubAgentProfileCreateParams, SubAgentProfileUpdateParams } from '../../shared/ipc-channels'
import SubAgentProfileService from '../services/sub-agent-profile.service'
import { safeHandle } from './_shared'

export function registerSubagentHandlers(): void {
  const service = SubAgentProfileService.getInstance()

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_LIST, () => {
    return service.list()
  })

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_CREATE, (params: SubAgentProfileCreateParams) => {
    return service.create(params || {})
  })

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_UPDATE, (params: SubAgentProfileUpdateParams) => {
    if (!params?.id) return { ok: false, error: '缺少 id' }
    return service.update(params.id, params as any)
  })

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_DELETE, (id: string) => {
    return service.remove(String(id || ''))
  })
}
