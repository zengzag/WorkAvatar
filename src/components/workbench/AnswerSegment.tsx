import { memo, useDeferredValue, useMemo } from 'react'
import { theme } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { MessageSegment } from './types'
import { markdownComponents } from './markdown-components'

const AnswerSegmentInner: React.FC<{
  seg: MessageSegment
  isError: boolean
}> = ({ seg, isError }) => {
  const { token } = theme.useToken()

  // 流式输出时节流 markdown 解析：useDeferredValue 让 React 在空闲时才重新解析
  // 避免 2000 token 流式输出触发 2000 次完整 markdown+KaTeX 重解析
  const deferredContent = useDeferredValue(seg.content || '')

  // 仅当内容真正变化时才重建 ReactMarkdown 子树
  const markdownNode = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {deferredContent}
      </ReactMarkdown>
    ),
    [deferredContent]
  )

  return (
    <div style={{ marginBottom: 0 }}>
      <div style={{
        padding: '8px 12px',
        borderRadius: 8,
        background: token.colorBgContainer,
        lineHeight: 1.6,
        wordBreak: 'break-word',
        border: isError ? `1px solid ${token.colorError}` : 'none',
      }}>
        <div className="markdown-content" style={{ fontSize: 15, color: token.colorText }}>
          {markdownNode}
        </div>
        {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorTextQuaternary }}>▊</span>}
      </div>
    </div>
  )
}

// React.memo 避免父组件 state 变化导致未变化的消息段重渲染
const AnswerSegment = memo(AnswerSegmentInner, (prev, next) =>
  prev.seg.content === next.seg.content &&
  prev.seg.isStreaming === next.seg.isStreaming &&
  prev.isError === next.isError
)

export default AnswerSegment
