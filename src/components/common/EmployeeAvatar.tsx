import { memo } from 'react'
import { theme } from 'antd'
import {
  RobotOutlined, UserOutlined, TeamOutlined, FileTextOutlined, BookOutlined,
  CodeOutlined, SettingOutlined, DatabaseOutlined, StarOutlined, BulbOutlined,
  ThunderboltOutlined, RocketOutlined, CheckOutlined,
} from '@ant-design/icons'
import RobotIconDef from '@ant-design/icons-svg/es/asn/RobotOutlined'
import UserIconDef from '@ant-design/icons-svg/es/asn/UserOutlined'
import TeamIconDef from '@ant-design/icons-svg/es/asn/TeamOutlined'
import FileIconDef from '@ant-design/icons-svg/es/asn/FileTextOutlined'
import BookIconDef from '@ant-design/icons-svg/es/asn/BookOutlined'
import CodeIconDef from '@ant-design/icons-svg/es/asn/CodeOutlined'
import SettingIconDef from '@ant-design/icons-svg/es/asn/SettingOutlined'
import DatabaseIconDef from '@ant-design/icons-svg/es/asn/DatabaseOutlined'
import StarIconDef from '@ant-design/icons-svg/es/asn/StarOutlined'
import BulbIconDef from '@ant-design/icons-svg/es/asn/BulbOutlined'
import ThunderIconDef from '@ant-design/icons-svg/es/asn/ThunderboltOutlined'
import RocketIconDef from '@ant-design/icons-svg/es/asn/RocketOutlined'
import type { IconDefinition } from '@ant-design/icons-svg/lib/types'
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

/** 图标字形：取 antd 图标的基础 SVG 路径，供画布与内联 SVG 直接绘制 */
export interface AvatarIconGlyph {
  /** viewBox（与 antd 图标一致：64 64 896 896） */
  viewBox: string
  /** 合并后的路径数据 */
  path: string
}

const toGlyph = (def: IconDefinition): AvatarIconGlyph => {
  const node = typeof def.icon === 'function' ? def.icon('#fff', '#fff') : def.icon
  return {
    viewBox: node.attrs.viewBox,
    path: (node.children || []).map((child) => child.attrs.d || '').filter(Boolean).join(' '),
  }
}

const ICON_GLYPHS: Record<EmployeeAvatarIcon, AvatarIconGlyph> = {
  robot: toGlyph(RobotIconDef),
  user: toGlyph(UserIconDef),
  team: toGlyph(TeamIconDef),
  file: toGlyph(FileIconDef),
  book: toGlyph(BookIconDef),
  code: toGlyph(CodeIconDef),
  setting: toGlyph(SettingIconDef),
  database: toGlyph(DatabaseIconDef),
  star: toGlyph(StarIconDef),
  bulb: toGlyph(BulbIconDef),
  thunder: toGlyph(ThunderIconDef),
  rocket: toGlyph(RocketIconDef),
}

/** 头像图标字形：未设置或未知 key 回落到默认机器人图标 */
export const getEmployeeAvatarIconGlyph = (icon?: string | null): AvatarIconGlyph =>
  ICON_GLYPHS[icon as EmployeeAvatarIcon] || ICON_GLYPHS.robot

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
  /** 上传的头像图片 data URL：优先于图标/颜色渲染 */
  avatarImage?: string | null
  /** 旧样式字段（兼容历史数据；avatarIcon/avatarColor 优先） */
  avatarType?: string | null
  employeeId?: string
  source?: EmployeeSource
  size?: number
  shape?: 'circle' | 'square'
  /** 选中态：显示主题色底 + 对勾 */
  active?: boolean
}

/** 数字员工头像：上传图片 > 自定义图标+颜色 > id 哈希色 */
const EmployeeAvatar: React.FC<EmployeeAvatarProps> = ({
  avatarIcon,
  avatarColor,
  avatarImage,
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

  if (avatarImage) {
    return (
      <img
        src={avatarImage}
        alt=""
        draggable={false}
        style={{
          ...baseStyle,
          objectFit: 'cover',
          background: color,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      />
    )
  }

  return <div style={{ ...baseStyle, background: color, color: '#fff' }}>{renderEmployeeAvatarIcon(icon, iconSize)}</div>
}

export default memo(EmployeeAvatar)
