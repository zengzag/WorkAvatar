import { Typography, Tooltip, theme } from 'antd'
import {
  DownOutlined,
  RightOutlined,
  LoadingOutlined,
  CheckCircleFilled,
  CarryOutOutlined,
  FlagFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState, memo } from 'react'
import type { MessageSegment } from './types'
import PreviewLine from './PreviewLine'
import ToolCallSegment from './ToolCallSegment'

const { Text } = Typography

export type TodoItemStatus = 'pending' | 'in_progress' | 'completed'
export type TodoItemPriority = 'high' | 'medium' | 'low'

export interface TodoItemView {
  content: string
  status: TodoItemStatus
  priority: TodoItemPriority
}

/** 严格解析 todo_write 入参；任一项不合法即整体返回空（由调用方回退通用工具视图） */
export function parseTodoItems(args: unknown): TodoItemView[] {
  if (!args || typeof args !== 'object') return []
  const todos = (args as Record<string, unknown>).todos
  if (!Array.isArray(todos)) return []
  const items: TodoItemView[] = []
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    if (!content) return []
    const status = entry.status ?? 'pending'
    const priority = entry.priority ?? 'medium'
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return []
    if (priority !== 'high' && priority !== 'medium' && priority !== 'low') return []
    items.push({ content, status, priority })
  }
  return items
}

export function calcTodoProgress(items: TodoItemView[]): {
  total: number
  done: number
  current: TodoItemView | undefined
  percent: number
  allDone: boolean
} {
  const total = items.length
  const done = items.filter(i => i.status === 'completed').length
  const current = items.find(i => i.status === 'in_progress')
  return {
    total,
    done,
    current,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    allDone: total > 0 && done === total,
  }
}

const TodoListSegmentInner: React.FC<{
  seg: MessageSegment
  /** 参数非法回退通用工具视图时的折叠切换（沿用父级消息态） */
  onToggle: () => void
  getToolDisplayName: (name: string) => string
  /** 同一消息存在多次清单更新时，仅最后一次默认展开 */
  defaultCollapsed?: boolean
}> = ({ seg, onToggle, getToolDisplayName, defaultCollapsed = false }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  // 默认跟随 defaultCollapsed；用户点击后固定覆盖（新卡片追加时旧卡自动收起）
  const [override, setOverride] = useState<boolean | null>(null)
  const collapsed = override !== null ? override : defaultCollapsed

  // 参数流式生成阶段：清单尚未就绪，轻量加载行替代原始 JSON 流
  if (seg.isToolArgsStreaming) {
    return (
      <div style={{ marginBottom: 2, padding: '5px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <LoadingOutlined spin style={{ fontSize: 12, color: token.colorTextTertiary }} />
        <Text style={{ fontSize: 12, color: token.colorTextSecondary }}>{t('workbench.todoGenerating')}</Text>
      </div>
    )
  }

  const items = parseTodoItems(seg.toolArgs)

  // 参数缺失/非法、被取消或执行失败：回退通用工具调用视图（保留原始入参与错误信息）
  if (items.length === 0 || seg.toolError) {
    return <ToolCallSegment seg={seg} onToggle={onToggle} getToolDisplayName={getToolDisplayName} />
  }

  const progress = calcTodoProgress(items)

  const statusIcon = (status: TodoItemStatus) => {
    switch (status) {
      case 'completed':
        return <CheckCircleFilled style={{ fontSize: 13, marginTop: 4, flexShrink: 0, color: token.colorSuccess }} />
      case 'in_progress':
        return <LoadingOutlined spin style={{ fontSize: 13, marginTop: 4, flexShrink: 0, color: token.colorPrimary }} />
      default:
        return (
          <span style={{
            width: 12,
            height: 12,
            marginTop: 5,
            flexShrink: 0,
            boxSizing: 'border-box',
            borderRadius: '50%',
            border: `1.5px solid ${token.colorTextQuaternary}`,
          }} />
        )
    }
  }

  const header = (
    <div
      onClick={() => setOverride(!collapsed)}
      style={{ padding: '5px 0', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
    >
      {collapsed ? (
        <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
      ) : (
        <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
      )}
      <CarryOutOutlined style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }} />
      <Text style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}>
        {getToolDisplayName(seg.toolName || 'todo_write')}
      </Text>
      {collapsed && progress.current && (
        <PreviewLine
          text={`${t('workbench.todoCurrentItem')}: ${progress.current.content}`}
          fontSize={11}
          lineHeight={16}
          color={token.colorTextQuaternary}
        />
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {progress.allDone ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorSuccess }}>
            <CheckCircleFilled style={{ fontSize: 11 }} />
            {t('workbench.todoAllDone')}
          </span>
        ) : (
          <>
            <Text style={{ fontSize: 11, color: token.colorTextQuaternary, whiteSpace: 'nowrap' }}>
              {t('workbench.todoProgress', { done: progress.done, total: progress.total })}
            </Text>
            <div style={{ width: 48, height: 4, borderRadius: 2, background: token.colorFillSecondary, overflow: 'hidden' }}>
              <div style={{
                width: `${progress.percent}%`,
                height: '100%',
                background: token.colorPrimary,
                borderRadius: 2,
                transition: 'width 0.3s',
              }} />
            </div>
          </>
        )}
      </div>
    </div>
  )

  if (collapsed) return <div style={{ marginBottom: 2 }}>{header}</div>

  return (
    <div style={{ marginBottom: 2 }}>
      {header}
      <div style={{ position: 'relative' }}>
        {/* 竖线与展开 icon 同列，与工具调用/委托段保持一致 */}
        <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
        <div style={{ position: 'relative', padding: '0 10px 8px 24px' }}>
          <div style={{ padding: '2px 10px', background: token.colorBgLayout, borderRadius: 6, border: `1px solid ${token.colorBorderSecondary}` }}>
            {items.map((item, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '5px 0',
                  borderBottom: idx < items.length - 1 ? `1px solid ${token.colorBorderSecondary}` : 'none',
                }}
              >
                {statusIcon(item.status)}
                <span style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  lineHeight: '20px',
                  wordBreak: 'break-word',
                  color: item.status === 'completed'
                    ? token.colorTextQuaternary
                    : item.status === 'in_progress' ? token.colorText : token.colorTextSecondary,
                  fontWeight: item.status === 'in_progress' ? 500 : 400,
                }}>
                  {item.content}
                </span>
                {item.priority === 'high' && (
                  <Tooltip title={t('workbench.todoHighPriority')}>
                    <FlagFilled style={{ fontSize: 10, color: token.colorWarning, marginTop: 5, flexShrink: 0 }} />
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const TodoListSegment = memo(TodoListSegmentInner, (prev, next) =>
  prev.seg === next.seg &&
  prev.onToggle === next.onToggle &&
  prev.getToolDisplayName === next.getToolDisplayName &&
  prev.defaultCollapsed === next.defaultCollapsed
)

export default TodoListSegment
