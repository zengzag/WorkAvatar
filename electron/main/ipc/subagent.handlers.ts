import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SubAgentProfileCreateParams, SubAgentProfileUpdateParams } from '../../shared/ipc-channels'
import SubAgentProfileService from '../services/sub-agent-profile.service'
import EmployeeAgentService from '../services/employee-agent.service'
import { safeHandle } from './_shared'

export function registerSubagentHandlers(): void {
  const service = SubAgentProfileService.getInstance()

  // 模板变更后递增工具集 epoch：模板会以 enum/列表形式进入存量 agent 的工具 schema 与稳定上下文，
  // 不失效缓存会导致新建/删除的模板在本轮对话中不可见（启动播种路径由 registerIpcHandlers 统一处理）
  const invalidateAgents = () => EmployeeAgentService.getInstance().bumpToolEpoch()

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_LIST, () => {
    return service.list()
  })

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_CREATE, (params: SubAgentProfileCreateParams) => {
    const res = service.create(params || {})
    if (res.profile) invalidateAgents()
    return res
  })

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_UPDATE, (params: SubAgentProfileUpdateParams) => {
    if (!params?.id) return { ok: false, error: '缺少 id' }
    const res = service.update(params.id, params as any)
    if (res.profile) invalidateAgents()
    return res
  })

  safeHandle(IPC_CHANNELS.SUBAGENT_PROFILE_DELETE, (id: string) => {
    const res = service.remove(String(id || ''))
    if (res.ok) invalidateAgents()
    return res
  })
}
