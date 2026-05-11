import { theme } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MessageSegment } from './types'

const AnswerSegment: React.FC<{
  seg: MessageSegment
  isError: boolean
}> = ({ seg, isError }) => {
  const { token } = theme.useToken()

  return (
    <div style={{ marginBottom: 0 }}>
      <div style={{
        padding: '10px 16px',
        borderRadius: 12,
        background: token.colorBgLayout,
        lineHeight: 1.7,
        wordBreak: 'break-word',
        border: isError ? '1px solid #ff4d4f' : 'none',
      }}>
        <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {seg.content || (seg.isStreaming ? '▊' : '')}
          </ReactMarkdown>
        </div>
        {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorTextQuaternary }}>▊</span>}
      </div>
    </div>
  )
}

export default AnswerSegment
