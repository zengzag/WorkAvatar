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
}

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
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={markdownComponents}
          >
            {seg.content || (seg.isStreaming ? '▊' : '')}
          </ReactMarkdown>
        </div>
        {seg.isStreaming && <span className="cursor-blink" style={{ color: token.colorTextQuaternary }}>▊</span>}
      </div>
    </div>
  )
}

export default AnswerSegment
