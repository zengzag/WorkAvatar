import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, theme, Typography, Spin, Empty, Tag, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import { SearchOutlined, RobotOutlined, MessageOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ConversationSearchResultItem } from '../../../electron/shared/ipc-channels'

const { Text } = Typography

interface GlobalSearchBoxProps {
  /** 当前员工 ID，用于区分"当前员工"与"其他员工"跳转逻辑 */
  currentEmployeeId?: string
  /** 切换当前员工下激活的对话（同一员工内点击结果时调用） */
  onSelectConversation?: (conversationId: string) => void
  /** 搜索框宽度（px），默认 240 */
  width?: number
  /** 下拉结果面板宽度（px），默认 380 */
  dropdownWidth?: number
}

/**
 * 顶部全局搜索框：跨智能体检索历史对话内容
 * - 输入防抖 300ms 触发搜索
 * - Ctrl+K / Cmd+K 聚焦
 * - ESC 清空并失焦
 * - 点击结果：当前员工直接切换对话；其他员工写入 localStorage 后路由跳转
 */
const GlobalSearchBox: React.FC<GlobalSearchBoxProps> = ({
  currentEmployeeId,
  onSelectConversation,
  width = 240,
  dropdownWidth = 380,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ConversationSearchResultItem[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const inputRef = useRef<InputRef>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reqIdRef = useRef(0)

  // 输入防抖搜索
  const handleSearch = useCallback((value: string) => {
    setQuery(value)
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    const trimmed = value.trim()
    if (!trimmed) {
      setResults([])
      setLoading(false)
      setOpen(false)
      setActiveIndex(-1)
      return
    }
    setLoading(true)
    setOpen(true)
    setActiveIndex(-1)
    debounceTimerRef.current = setTimeout(async () => {
      const reqId = ++reqIdRef.current
      try {
        const data = await window.electronAPI.conversation.searchGlobal({
          query: trimmed,
          limit: 20,
        })
        // 丢弃过期请求结果
        if (reqId !== reqIdRef.current) return
        setResults(Array.isArray(data) ? data : [])
      } catch {
        if (reqId !== reqIdRef.current) return
        setResults([])
      } finally {
        if (reqId === reqIdRef.current) setLoading(false)
      }
    }, 300)
  }, [])

  // 跳转到搜索结果对应的对话
  const handleSelect = useCallback((item: ConversationSearchResultItem) => {
    setOpen(false)
    setQuery('')
    setResults([])
    setActiveIndex(-1)
    inputRef.current?.blur()

    if (item.employeeId === currentEmployeeId && onSelectConversation) {
      // 同一员工：直接切换对话
      onSelectConversation(item.conversationId)
    } else {
      // 跨员工：写入激活对话 ID，路由跳转，目标页面初始化时会读取
      localStorage.setItem(`employeeWorkbench:activeConvId:${item.employeeId}`, item.conversationId)
      navigate(`/employee/${item.employeeId}`)
    }
  }, [currentEmployeeId, onSelectConversation, navigate])

  // Ctrl+K / Cmd+K 聚焦搜索框
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 清理防抖定时器
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  // 键盘导航：↑↓ 选择，Enter 跳转，ESC 关闭
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (results.length === 0) return
      setActiveIndex((prev) => (prev + 1) % results.length)
      setOpen(true)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length === 0) return
      setActiveIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1))
    } else if (e.key === 'Enter') {
      if (open && results.length > 0) {
        const target = activeIndex >= 0 ? results[activeIndex] : results[0]
        if (target) {
          e.preventDefault()
          handleSelect(target)
        }
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActiveIndex(-1)
      inputRef.current?.blur()
    }
  }

  // 解析 FTS5 snippet 中的 <highlight> 标签
  const renderSnippet = useCallback((snippet: string) => {
    if (!snippet) return null
    const parts = snippet.split(/(<highlight>.*?<\/highlight>)/g)
    return parts.map((part, i) => {
      const match = part.match(/^<highlight>(.*)<\/highlight>$/s)
      if (match) {
        return (
          <mark
            key={i}
            style={{
              background: token.colorPrimaryBg,
              color: token.colorPrimary,
              padding: '0 2px',
              borderRadius: 2,
              fontWeight: 500,
            }}
          >
            {match[1]}
          </mark>
        )
      }
      return <span key={i}>{part}</span>
    })
  }, [token])

  // 时间格式化
  const formatTime = useCallback((ts: number | null): string => {
    if (!ts) return ''
    const now = Date.now()
    const diff = now - ts * 1000
    const oneMin = 60 * 1000
    const oneHour = 60 * oneMin
    const oneDay = 24 * oneHour
    if (diff < oneMin) return t('workbench.justNow')
    if (diff < oneHour) return t('workbench.minutesAgo', { count: Math.floor(diff / oneMin) })
    if (diff < oneDay) return t('workbench.hoursAgo', { count: Math.floor(diff / oneHour) })
    const date = new Date(ts * 1000)
    const nowDate = new Date()
    const isThisYear = date.getFullYear() === nowDate.getFullYear()
    if (isThisYear) {
      return t('workbench.monthDay', { month: date.getMonth() + 1, day: date.getDate() })
    }
    return t('workbench.yearMonthDay', {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    })
  }, [t])

  const hasQuery = query.trim().length > 0
  const showDropdown = open && hasQuery

  const dropdownContent = useMemo(() => {
    if (!showDropdown) return null
    return (
      <div
        style={{
          width: dropdownWidth,
          maxHeight: 420,
          overflowY: 'auto',
          padding: 4,
          background: token.colorBgContainer,
          borderRadius: 8,
          border: `1px solid ${token.colorBorderSecondary}`,
          boxShadow: token.boxShadowSecondary,
        }}
        className="global-search-dropdown"
        onMouseDown={(e) => e.preventDefault()} // 防止点击结果时输入框失焦
      >
        {loading ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <Spin size="small" />
          </div>
        ) : results.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('globalSearch.noResults')}
            style={{ padding: '20px 0', margin: 0 }}
          />
        ) : (
          <>
            <div style={{
              padding: '4px 8px',
              fontSize: 11,
              color: token.colorTextTertiary,
              display: 'flex',
              justifyContent: 'space-between',
            }}>
              <span>{t('globalSearch.resultsCount', { count: results.length })}</span>
              <span>{t('globalSearch.crossAgentHint')}</span>
            </div>
            {results.map((item, idx) => {
              const isCurrent = item.employeeId === currentEmployeeId
              return (
                <div
                  key={item.conversationId}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: idx === activeIndex ? token.colorFillQuaternary : 'transparent',
                    transition: 'background 0.15s',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {/* 第一行：标题 + 员工名称 */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    minWidth: 0,
                  }}>
                    <MessageOutlined style={{
                      fontSize: 12,
                      color: token.colorTextTertiary,
                      flexShrink: 0,
                    }} />
                    <Text
                      strong
                      ellipsis
                      style={{ fontSize: 13, flex: 1, minWidth: 0 }}
                    >
                      {item.title || t('workbench.untitledConv')}
                    </Text>
                    <Tag
                      color={isCurrent ? token.colorPrimary : undefined}
                      style={{
                        margin: 0,
                        fontSize: 11,
                        lineHeight: '18px',
                        padding: '0 6px',
                        flexShrink: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                      }}
                    >
                      <RobotOutlined style={{ fontSize: 10 }} />
                      {item.employeeName || t('globalSearch.unknownEmployee')}
                    </Tag>
                  </div>
                  {/* 第二行：内容 snippet */}
                  {item.previewSnippet && (
                    <div style={{
                      fontSize: 12,
                      color: token.colorTextSecondary,
                      lineHeight: 1.5,
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      wordBreak: 'break-word',
                      paddingLeft: 18,
                    }}>
                      {renderSnippet(item.previewSnippet)}
                    </div>
                  )}
                  {/* 第三行：时间 + 消息数 */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 11,
                    color: token.colorTextTertiary,
                    paddingLeft: 18,
                  }}>
                    {item.lastMessageAt && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <ClockCircleOutlined style={{ fontSize: 10 }} />
                        {formatTime(item.lastMessageAt)}
                      </span>
                    )}
                    <span>{t('common.messages', { count: item.messageCount })}</span>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    )
  }, [showDropdown, loading, results, dropdownWidth, token, t, currentEmployeeId, activeIndex, handleSelect, renderSnippet, formatTime])

  return (
    <div style={{ position: 'relative', width }}>
      <Input
        ref={inputRef}
        size="small"
        allowClear
        prefix={<SearchOutlined style={{ fontSize: 12, color: token.colorTextTertiary }} />}
        placeholder={t('globalSearch.placeholder')}
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (hasQuery && results.length > 0) setOpen(true) }}
        onBlur={() => {
          // 延迟关闭，允许点击下拉项
          setTimeout(() => setOpen(false), 180)
        }}
        style={{
          borderRadius: 14,
          background: token.colorFillQuaternary,
          borderColor: 'transparent',
          fontSize: 12,
          height: 28,
        }}
        suffix={
          <Tooltip title={t('globalSearch.shortcutHint')} mouseEnterDelay={0.5}>
            <span
              style={{
                fontSize: 10,
                color: token.colorTextQuaternary,
                padding: '1px 5px',
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 3,
                lineHeight: '14px',
                fontFamily: 'monospace',
                userSelect: 'none',
              }}
            >
              Ctrl K
            </span>
          </Tooltip>
        }
      />
      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: 4,
            zIndex: 1050,
          }}
        >
          {dropdownContent}
        </div>
      )}
    </div>
  )
}

export default GlobalSearchBox
