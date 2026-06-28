import { memo, useDeferredValue, useMemo } from 'react'
import { theme } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import CodeBlock from './CodeBlock'
import type { MessageSegment } from './types'

const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    const code = String(children).replace(/\n$/, '')
    if (match) {
      return <CodeBlock language={match[1]} code={code} />
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
  a({ href, children, ...props }: any) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },
}

const AnswerSegmentInner: React.FC<{
  seg: MessageSegment
  isError: boolean
}> = ({ seg, isError }) => {
  const { token } = theme.useToken()

  // 流式输出时节流 markdown 解析：useDeferredValue 让 React 在空闲时才重新解析
  // 避免 2000 token 流式输出触发 2000 次完整 markdown+KaTeX 重解析
  const deferredContent = useDeferredValue(seg.content || (seg.isStreaming ? '▊' : ''))

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
        padding: '10px 16px',
        borderRadius: 12,
        background: token.colorBgLayout,
        lineHeight: 1.7,
        wordBreak: 'break-word',
        border: isError ? '1px solid #ff4d4f' : 'none',
      }}>
        <div className="markdown-content" style={{ fontSize: 14, color: token.colorText }}>
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
