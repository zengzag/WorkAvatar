import { memo, useMemo } from 'react'
import { theme } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { markdownComponents } from '../workbench/markdown-components'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'

interface Props {
  content: string
  /** 预览容器 ref，供外部滚动同步使用 */
  containerRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void
}

const NotesMarkdownPreviewInner: React.FC<Props> = ({ content, containerRef, onScroll }) => {
  const { token } = theme.useToken()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)

  const markdownNode = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {content || ''}
      </ReactMarkdown>
    ),
    [content]
  )

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="markdown-content notes-preview"
      style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px 24px 60px',
        fontSize: 14,
        lineHeight: 1.7,
        color: token.colorText,
        background: token.colorBgContainer,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      }}
      data-theme={effectiveTheme}
    >
      {content ? markdownNode : null}
    </div>
  )
}

export const NotesMarkdownPreview = memo(NotesMarkdownPreviewInner)
export default NotesMarkdownPreview
