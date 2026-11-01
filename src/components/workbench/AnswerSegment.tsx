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

  // 无数学标记时跳过 remark-math/rehype-katex：KaTeX 解析是 markdown 渲染的主要开销之一，
  // 绝大多数回复并不含公式，按内容特征裁剪可显著降低每次重解析的成本
  const hasMath = useMemo(() => /\$|\\\(|\\\[|\\begin\{/.test(deferredContent), [deferredContent])
  const remarkPlugins = useMemo(
    () => (hasMath ? [remarkGfm, remarkMath] : [remarkGfm]),
    [hasMath]
  )
  const rehypePlugins = useMemo(
    () => (hasMath ? [rehypeKatex] : []),
    [hasMath]
  )

  // 仅当内容真正变化时才重建 ReactMarkdown 子树
  const markdownNode = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {deferredContent}
      </ReactMarkdown>
    ),
    [deferredContent, remarkPlugins, rehypePlugins]
  )

  return (
    <div style={{ marginBottom: 0 }}>
      <div style={{
        lineHeight: 1.6,
        wordBreak: 'break-word',
      }}>
        <div className="markdown-content" style={{ fontSize: 15, color: isError ? token.colorError : token.colorText }}>
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
