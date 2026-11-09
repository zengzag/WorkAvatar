import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Popover, Space, Tag, Tooltip, Typography, theme } from 'antd'
import { CloseCircleOutlined, CodeOutlined, LoadingOutlined } from '@ant-design/icons'
import type { ShellBgTaskItem } from '../../../electron/shared/ipc-channels'

const { Text } = Typography

interface BackgroundShellBarProps {
  /** 当前会话 id：只展示该会话（含委托子会话）启动的后台任务 */
  conversationId?: string
}

/** 毫秒时长 → 人类可读（用于"已运行"展示） */
function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * 后台长跑任务条：仅在当前会话存在运行中的后台任务时出现。
 *
 * 存在的意义是「停止机制」—— agent 回合异常结束/被中止时，后台进程按设计会继续运行
 * （dev server 需要跨轮次存活），用户必须有一个随时可用的手动停止入口；
 * 另外会话删除与应用退出时由主进程自动回收。
 */
const BackgroundShellBar: React.FC<BackgroundShellBarProps> = ({ conversationId }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [tasks, setTasks] = useState<ShellBgTaskItem[]>([])
  const [pendingId, setPendingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.shellBg
    if (!api) return
    try {
      const list = await api.list(conversationId)
      setTasks(list.filter(item => item.status === 'running'))
    } catch { /* 列表刷新失败不打扰用户，等待下一次变更事件 */ }
  }, [conversationId])

  useEffect(() => {
    void refresh()
    const api = window.electronAPI?.shellBg
    if (!api) return
    const unsubscribe = api.onChanged(() => { void refresh() })
    return () => { unsubscribe() }
  }, [refresh])

  const handleStop = useCallback(async (taskId: string) => {
    setPendingId(taskId)
    try {
      await window.electronAPI.shellBg.kill(taskId)
    } catch { /* 终止失败时保持列表不变，用户可重试 */ }
    setPendingId(null)
    void refresh()
  }, [refresh])

  if (tasks.length === 0) return null

  const content = (
    <div style={{ width: 440, maxHeight: 320, overflowY: 'auto' }}>
      <Space orientation="vertical" size={4} style={{ width: '100%' }}>
        {tasks.map(task => (
          <div
            key={task.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 0',
              borderBottom: `1px solid ${token.colorSplit}`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <Tooltip title={task.command}>
                <Text
                  style={{ fontSize: 12, display: 'block' }}
                  ellipsis
                >
                  {task.command}
                </Text>
              </Tooltip>
              <Text type="secondary" style={{ fontSize: 11, display: 'block' }} ellipsis>
                {t('workbench.bgShellElapsed', { time: formatElapsed(task.startedAt) })}
                {task.pid ? ` · PID ${task.pid}` : ''}
                {` · ${task.cwd}`}
              </Text>
            </div>
            <Button
              size="small"
              danger
              icon={<CloseCircleOutlined />}
              loading={pendingId === task.id}
              onClick={() => handleStop(task.id)}
            >
              {t('workbench.bgShellStop')}
            </Button>
          </div>
        ))}
      </Space>
    </div>
  )

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 24px 4px',
        width: '100%',
        maxWidth: 868,
        margin: '0 auto',
        flexShrink: 0,
      }}
    >
      <Tag color="processing" icon={<LoadingOutlined />} style={{ marginInlineEnd: 0, borderRadius: 999 }}>
        {t('workbench.bgShellRunning', { count: tasks.length })}
      </Tag>
      <Popover
        content={content}
        title={t('workbench.bgShellTitle')}
        trigger="click"
        placement="topLeft"
      >
        <Button size="small" type="text" icon={<CodeOutlined />}>
          {t('workbench.bgShellManage')}
        </Button>
      </Popover>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {t('workbench.bgShellHint')}
      </Text>
    </div>
  )
}

export default React.memo(BackgroundShellBar)
