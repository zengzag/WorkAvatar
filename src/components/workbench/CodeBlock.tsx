import { useState, useCallback, memo, useEffect, useMemo, useSyncExternalStore, Fragment } from 'react'
import { theme } from 'antd'
import { CopyOutlined, CheckOutlined } from '@ant-design/icons'
import { isColorDark } from '../../utils/format'
import { grammarLoadVersion, highlightCodeLines, subscribeGrammarLoaded } from '../../utils/shiki'

interface CodeBlockProps {
  language: string
  code: string
}

const CodeBlockInner: React.FC<CodeBlockProps> = ({ language, code }) => {
  const { token } = theme.useToken()
  const [copied, setCopied] = useState(false)
  // 代码仍在流式增长时不分词：稳定 150ms 后只高亮一次。
  // 否则一个长代码块在流式期间会被 shiki 反复全量 tokenize（单次数十毫秒，逐增量触发）
  const [stableCode, setStableCode] = useState('')
  const grammarVersion = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadVersion)

  useEffect(() => {
    const id = setTimeout(() => setStableCode(code), 150)
    return () => clearTimeout(id)
  }, [code, language])

  const isDark = isColorDark(token.colorBgContainer)
  const lang = language || 'text'
  const lines = useMemo(
    () => (stableCode === code && code ? highlightCodeLines(code, lang, isDark) : undefined),
    [stableCode, code, lang, isDark, grammarVersion],
  )

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [code])

  const headerBg = isDark ? '#2b2b2b' : '#e8e8e8'
  const headerColor = isDark ? '#abb2bf' : '#636e7b'
  const borderColor = isDark ? '#3a3a3a' : '#d0d0d0'
  const codeBg = isDark ? '#282c34' : '#fafafa'

  return (
    <div style={{
      borderRadius: 8,
      overflow: 'hidden',
      border: `1px solid ${borderColor}`,
      margin: '8px 0',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 12px',
        background: headerBg,
        borderBottom: `1px solid ${borderColor}`,
      }}>
        <span style={{
          fontSize: 12,
          color: headerColor,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: 500,
        }}>
          {lang}
        </span>
        <button
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            color: headerColor,
            fontSize: 12,
            padding: '2px 6px',
            borderRadius: 4,
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = isDark ? '#3a3a3a' : '#d0d0d0'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          {copied ? <CheckOutlined style={{ fontSize: 12 }} /> : <CopyOutlined style={{ fontSize: 12 }} />}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: '12px 16px',
        background: codeBg,
        fontSize: 13,
        lineHeight: 1.6,
        overflow: 'auto',
      }}>
        <code style={{ fontFamily: 'monospace' }}>
          {lines ? lines.map((line, index) => (
            <Fragment key={index}>
              {line.map((span, spanIndex) => (
                <span key={spanIndex} style={span.style}>{span.text}</span>
              ))}
              {index < lines.length - 1 ? '\n' : null}
            </Fragment>
          )) : code}
        </code>
      </pre>
    </div>
  )
}

// React.memo 避免代码块在父组件重渲染时重复渲染语法高亮（A#11）
const CodeBlock = memo(CodeBlockInner)

export default CodeBlock
