import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SkillEnvInstallParams } from '../../shared/ipc-channels'
import SkillExecEnvService from '../services/skill-exec-env.service'
import { safeHandle } from './_shared'
import { createLogger } from '../services/logger'

const logger = createLogger('SkillEnv-Handler')

/**
 * Skill 执行环境检测 IPC handlers。
 *
 * 暴露三个 invoke 通道（list / install / cancel-install），
 * 安装进度通过 SKILL_ENV_PROGRESS 事件通道主动推送至渲染进程。
 */
export function registerSkillEnvHandlers(): void {
  const service = SkillExecEnvService.getInstance()

  // 列出所有受支持运行时的检测状态
  safeHandle(IPC_CHANNELS.SKILL_ENV_LIST, async () => {
    return await service.detectAll()
  })

  // 一键安装指定运行时。
  // 不使用 safeHandle：需要保留 install 内部抛出的业务错误信息，
  // 且进度通过事件通道推送，handler 仅返回最终成功/失败结果。
  ipcMain.handle(IPC_CHANNELS.SKILL_ENV_INSTALL, async (_event, params: SkillEnvInstallParams) => {
    try {
      if (!params?.toolId) {
        return { success: false, error: '缺少 toolId 参数' }
      }
      const result = await service.install(params.toolId)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      const msg = String(err?.message || err)
      logger.error(`IPC handler error [SKILL_ENV_INSTALL]:`, msg)
      // 用户主动取消不算错误，返回 success: false + 友好提示
      if (msg === 'INSTALL_CANCELLED') {
        return { success: false, error: '安装已取消', cancelled: true }
      }
      return { success: false, error: msg }
    }
  })

  // 取消正在进行的安装
  safeHandle(IPC_CHANNELS.SKILL_ENV_CANCEL_INSTALL, async () => {
    const cancelled = service.cancelInstall()
    return { success: cancelled }
  })
}
