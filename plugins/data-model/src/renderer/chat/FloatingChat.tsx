// 悬浮式 AI 对话：以 FAB 形式悬浮在画布右下角

import { useState } from 'react'
import { Button, Tooltip } from 'antd'
import { MessageOutlined } from '@ant-design/icons'
import { ChatPanel } from './ChatPanel'
import { useDataModelStore } from '../data-model.store'
import { hostT } from '../store'

/**
 * 浮窗式 AI 对话：以 FAB 形式悬浮在“数据模型”页画布右下角。
 * - 收起时仅显示一个圆形按钮（生成中有脉冲指示）
 * - 展开时弹出固定尺寸的对话面板，overlay 在画布之上，不影响检查器与画布交互
 * - 对话状态保存在 store，收起/展开不丢失上下文
 */
export function FloatingChat() {
  const [open, setOpen] = useState(false)
  const isStreaming = useDataModelStore((s) => s.isStreaming)

  if (open) {
    return (
      <div
        style={{
          position: 'absolute', bottom: 12, right: 12, zIndex: 30,
          width: 400, maxHeight: 'calc(100% - 24px)', height: 560,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          borderRadius: 12, border: '1px solid var(--dm-border-strong)',
          background: 'var(--dm-bg)', boxShadow: '0 8px 30px rgba(0,0,0,0.2)'
        }}
      >
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatPanel onClose={() => setOpen(false)} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 30 }}>
      <Tooltip title={hostT('page.chatEmpty')}>
        <Button
          type="primary"
          shape="circle"
          size="large"
          icon={<MessageOutlined />}
          onClick={() => setOpen(true)}
          style={{ width: 48, height: 48, boxShadow: '0 4px 12px rgba(0,0,0,0.2)' }}
        />
      </Tooltip>
      {isStreaming && (
        <span
          style={{
            position: 'absolute', top: 0, right: 0, width: 12, height: 12,
            borderRadius: '50%', background: '#10b981',
            boxShadow: '0 0 0 3px var(--dm-bg)'
          }}
        />
      )}
    </div>
  )
}
