import { memo } from 'react'
import { theme } from 'antd'
import {
  RobotOutlined, UserOutlined, TeamOutlined, FileTextOutlined, BookOutlined,
  CodeOutlined, SettingOutlined, DatabaseOutlined, StarOutlined, BulbOutlined,
  ThunderboltOutlined, RocketOutlined, CheckOutlined,
} from '@ant-design/icons'
import type { EmployeeSource } from '../../types'

/** 可选头像图标（key 对应 i18n employeeSettings.avatarIcon_<key>） */
export const EMPLOYEE_AVATAR_ICONS = [
  'robot', 'user', 'team', 'file', 'book', 'code',
  'setting', 'database', 'star', 'bulb', 'thunder', 'rocket',
] as const

export type EmployeeAvatarIcon = typeof EMPLOYEE_AVATAR_ICONS[number]

const ICON_COMPONENTS: Record<EmployeeAvatarIcon, React.ComponentType<{ style?: React.CSSProperties }>> = {
  robot: RobotOutlined,
  user: UserOutlined,
  team: TeamOutlined,
  file: FileTextOutlined,
  book: BookOutlined,
  code: CodeOutlined,
  setting: SettingOutlined,
  database: DatabaseOutlined,
  star: StarOutlined,
  bulb: BulbOutlined,
  thunder: ThunderboltOutlined,
  rocket: RocketOutlined,
}

/** 头像配色预设（也可通过取色器自定义任意颜色） */
export const AVATAR_COLOR_PRESETS = [
  '#1677ff', '#52c41a', '#faad14', '#fa8c16', '#eb2f96', '#722ed1',
  '#13c2c2', '#f5222d', '#2f54eb', '#7cb305', '#08979c', '#d46b08',
  '#c41d7f', '#531dab', '#5b8c00', '#fa541c',
]

/** 自动配色只用前 8 色，保持历史员工颜色稳定 */
const AUTO_COLORS = AVATAR_COLOR_PRESETS.slice(0, 8)
const DEFAULT_AVATAR_COLOR = AVATAR_COLOR_PRESETS[0]
const DEFAULT_EMPLOYEE_ICON: EmployeeAvatarIcon = 'robot'

/** 旧 avatar_type 预设 → 图标与配色（历史数据兼容） */
const AVATAR_TYPE_PRESETS: Record<string, { icon: EmployeeAvatarIcon; color: string }> = {
  business: { icon: 'user', color: '#52c41a' },
  document: { icon: 'file', color: '#faad14' },
  settings: { icon: 'setting', color: '#1677ff' },
}

/** id 哈希 → 固定调色板：未设置颜色时按员工 id 自动配色，保证不同员工可区分 */
const getAvatarColor = (id: string): string => {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i)
    hash |= 0
  }
  return AUTO_COLORS[Math.abs(hash) % AUTO_COLORS.length]
}

/** 解析最终图标：显式设置 > 旧 avatar_type 预设 > 内置员工数据库图标 > 默认机器人 */
export const resolveEmployeeAvatarIcon = (
  avatarIcon?: string | null,
  avatarType?: string | null,
  source?: EmployeeSource,
): EmployeeAvatarIcon => {
  if (avatarIcon && (EMPLOYEE_AVATAR_ICONS as readonly string[]).includes(avatarIcon)) {
    return avatarIcon as EmployeeAvatarIcon
  }
  const preset = avatarType ? AVATAR_TYPE_PRESETS[avatarType] : undefined
  if (preset) return preset.icon
  return source === 'builtin' ? 'database' : DEFAULT_EMPLOYEE_ICON
}

/** 解析最终颜色：显式设置 > 旧 avatar_type 预设色 > id 自动配色 > 默认色 */
export const resolveEmployeeAvatarColor = (
  avatarColor?: string | null,
  avatarType?: string | null,
  employeeId?: string,
): string => {
  if (avatarColor) return avatarColor
  const preset = avatarType ? AVATAR_TYPE_PRESETS[avatarType] : undefined
  if (preset) return preset.color
  if (employeeId) return getAvatarColor(employeeId)
  return DEFAULT_AVATAR_COLOR
}

export const renderEmployeeAvatarIcon = (icon: EmployeeAvatarIcon, size: number): React.ReactNode => {
  const Comp = ICON_COMPONENTS[icon] || RobotOutlined
  return <Comp style={{ fontSize: size }} />
}

export interface EmployeeAvatarProps {
  avatarIcon?: string | null
  avatarColor?: string | null
  /** 旧样式字段（兼容历史数据；avatarIcon/avatarColor 优先） */
  avatarType?: string | null
  employeeId?: string
  source?: EmployeeSource
  size?: number
  shape?: 'circle' | 'square'
  /** 选中态：显示主题色底 + 对勾 */
  active?: boolean
}

/** 数字员工头像：统一按自定义图标 + 颜色渲染，未设置时回退 id 哈希色 */
const EmployeeAvatar: React.FC<EmployeeAvatarProps> = ({
  avatarIcon,
  avatarColor,
  avatarType,
  employeeId,
  source,
  size = 32,
  shape = 'circle',
  active,
}) => {
  const { token } = theme.useToken()
  const borderRadius = shape === 'circle' ? '50%' : Math.round(size * 0.18)
  const iconSize = Math.round(size * 0.5)

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  if (active) {
    return (
      <div style={{ ...baseStyle, background: token.colorPrimary }}>
        <CheckOutlined style={{ fontSize: iconSize, color: '#fff' }} />
      </div>
    )
  }

  const icon = resolveEmployeeAvatarIcon(avatarIcon, avatarType, source)
  const color = resolveEmployeeAvatarColor(avatarColor, avatarType, employeeId)

  return <div style={{ ...baseStyle, background: color, color: '#fff' }}>{renderEmployeeAvatarIcon(icon, iconSize)}</div>
}

export default memo(EmployeeAvatar)
