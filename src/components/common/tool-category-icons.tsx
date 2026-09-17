import type { ReactNode } from 'react'
import {
  ToolOutlined,
  FileOutlined,
  DatabaseOutlined,
  CalendarOutlined,
  RobotOutlined,
  GlobalOutlined,
  SettingOutlined,
  FileTextOutlined,
  MessageOutlined,
  BulbOutlined,
  CodeOutlined,
  TeamOutlined,
} from '@ant-design/icons'

/**
 * 工具分组图标映射：键为后端分类下发的 icon 字段。
 * 员工设置、创建向导与对话消息中的工具段共用同一份，保证同分组图标一致。
 * 插件分组与未知分组统一用小扳手图标。
 */
export const CATEGORY_ICON_MAP: Record<string, ReactNode> = {
  file: <FileOutlined />,
  database: <DatabaseOutlined />,
  calendar: <CalendarOutlined />,
  robot: <RobotOutlined />,
  global: <GlobalOutlined />,
  setting: <SettingOutlined />,
  'file-document': <FileTextOutlined />,
  message: <MessageOutlined />,
  tool: <BulbOutlined />,
  code: <CodeOutlined />,
  plugin: <ToolOutlined />,
  team: <TeamOutlined />,
}

/** 按分组 icon 键取图标；未命中（含无分组）回退小扳手 */
export const getCategoryIcon = (iconKey?: string): ReactNode =>
  (iconKey ? CATEGORY_ICON_MAP[iconKey] : undefined) ?? <ToolOutlined />
