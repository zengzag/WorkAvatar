import React from 'react'
import { useTranslation } from 'react-i18next'
import MemoryManager from './MemoryManager'

interface MemorySectionProps {
  employeeId: string
  memoryEnabled: boolean
  onMemoryEnabledChange: (enabled: boolean) => void
  /** 只读模式（注册员工）：记忆列表只读（开关仍可切换） */
  readonly?: boolean
}

/**
 * 员工设置抽屉「记忆」Tab：管理该数字员工的跨任务记忆。
 * 具体交互复用共享组件 MemoryManager（与全局记忆设置同源）。
 */
const MemorySection: React.FC<MemorySectionProps> = ({
  employeeId,
  memoryEnabled,
  onMemoryEnabledChange,
  readonly,
}) => {
  const { t } = useTranslation()

  return (
    <MemoryManager
      scope="employee"
      employeeId={employeeId}
      readonly={readonly}
      showEnableSwitch
      enabled={memoryEnabled}
      onEnabledChange={onMemoryEnabledChange}
      title={t('employeeSettings.memoryTitle')}
    />
  )
}

export default React.memo(MemorySection)
