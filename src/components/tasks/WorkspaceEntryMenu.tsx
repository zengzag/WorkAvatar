import { useMemo } from 'react'
import { App, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { CopyOutlined, ExportOutlined, EyeOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

interface WorkspaceEntryMenuProps {
  /** 文件或目录的绝对路径 */
  path: string
  /** 目录：右键菜单隐藏预览/系统打开，「打开文件夹」直接打开目录本身 */
  isDirectory?: boolean
  /** 文件已被移除：预览/打开类操作置灰，仅保留复制路径 */
  missing?: boolean
  /** 文件预览回调（目录不传） */
  onPreview?: () => void
  children: React.ReactElement
}

/** 工作区文件/目录统一右键菜单：预览、使用系统程序打开、在文件管理器中打开、复制路径 */
const WorkspaceEntryMenu: React.FC<WorkspaceEntryMenuProps> = ({
  path,
  isDirectory,
  missing,
  onPreview,
  children,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()

  const items = useMemo(() => {
    const list: NonNullable<MenuProps['items']> = []
    if (!isDirectory) {
      list.push({
        key: 'preview',
        icon: <EyeOutlined />,
        label: t('workbench.previewFile'),
        disabled: missing,
      })
      list.push({
        key: 'open-with-system',
        icon: <ExportOutlined />,
        label: t('workbench.openWithSystem'),
        disabled: missing,
      })
    }
    list.push({
      key: 'reveal',
      icon: <FolderOpenOutlined />,
      label: isDirectory ? t('workbench.openFolder') : t('workbench.openInExplorer'),
      disabled: missing,
    })
    list.push({ key: 'copy-path', icon: <CopyOutlined />, label: t('workbench.copyPath') })
    return list
  }, [isDirectory, missing, t])

  const handleClick: MenuProps['onClick'] = async ({ key }) => {
    if (key === 'preview') {
      onPreview?.()
      return
    }
    if (key === 'copy-path') {
      try {
        await navigator.clipboard.writeText(path)
        message.success(t('workbench.pathCopied'))
      } catch {
        message.error(t('workbench.copyPathFailed'))
      }
      return
    }
    if (key === 'open-with-system') {
      const res = await window.electronAPI.kms.openFile(path)
      if (res?.error) message.error(`${t('workbench.openWithSystemFailed')}: ${res.error}`)
      return
    }
    if (key === 'reveal') {
      if (isDirectory) {
        const res = await window.electronAPI.workspace.openInExplorer({ path })
        if (!res?.success) message.error(t('workbench.openWorkspaceFailed', { error: res?.error || '' }))
      } else {
        window.electronAPI.kms.openFileDir(path)
      }
    }
  }

  return (
    <Dropdown menu={{ items, onClick: handleClick }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  )
}

export default WorkspaceEntryMenu
