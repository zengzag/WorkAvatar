import React from 'react'
import { useTranslation } from 'react-i18next'
import MemoryManager from '../employee-settings/MemoryManager'
/**
 * 设置页「记忆」Tab：管理全局记忆。
 *
 * 全局记忆跨所有数字员工共享，注入到每个开启记忆的员工的上下文，
 * 仅用于"换一个员工执行同类任务时仍应生效"的用户级事实（用户角色、通用偏好、通用硬约束）。
 */
const GlobalMemorySettings: React.FC = () => {
  const { t } = useTranslation()

  return (
    <MemoryManager
      scope="global"
      title={t('settings.globalMemoryTitle')}
      hint={t('settings.globalMemoryHint')}
    />
  )
}

export default React.memo(GlobalMemorySettings)
