import { Input, Button, theme } from 'antd'
import { SendOutlined, StopOutlined } from '@ant-design/icons'

const { TextArea } = Input

const ChatInput: React.FC<{
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  isStreaming: boolean
  placeholder: string
}> = ({ value, onChange, onSend, onStop, isStreaming, placeholder }) => {
  const { token } = theme.useToken()

  return (
    <div
      style={{
        padding: '12px 10% 20px 10%',
        flexShrink: 0,
      }}
    >
      <div style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        background: token.colorBgLayout,
        borderRadius: 16,
        padding: '6px 6px 6px 16px',
        border: '2px solid transparent',
        transition: 'border-color 0.3s',
      }}
        onFocusCapture={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary
        }}
        onBlurCapture={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = 'transparent'
        }}
      >
        <TextArea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder={placeholder}
          autoSize={{ minRows: 1, maxRows: 5 }}
          disabled={isStreaming}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            resize: 'none',
            fontSize: 14,
            lineHeight: 1.6,
            padding: '4px 0',
            boxShadow: 'none',
          }}
          className="workbench-input"
        />
        {isStreaming ? (
          <Button icon={<StopOutlined />} danger
            onClick={onStop}
            shape="circle" size="middle" />
        ) : (
          <Button icon={<SendOutlined />} type="primary"
            onClick={onSend}
            disabled={!value.trim()}
            shape="circle" size="middle"
            style={{ flexShrink: 0 }} />
        )}
      </div>
    </div>
  )
}

export default ChatInput
