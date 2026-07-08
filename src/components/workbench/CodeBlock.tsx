import { useState, useCallback, memo } from 'react'
import { theme } from 'antd'
import { CopyOutlined, CheckOutlined } from '@ant-design/icons'
import { PrismAsync } from 'react-syntax-highlighter'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'
import { isColorDark } from '../../utils/format'

interface CodeBlockProps {
  language: string
  code: string
}

const CodeBlockInner: React.FC<CodeBlockProps> = ({ language, code }) => {
  const { token } = theme.useToken()
  const [copied, setCopied] = useState(false)

  const isDark = isColorDark(token.colorBgContainer)
  const syntaxStyle = isDark ? oneDark : oneLight
  const lang = language || 'text'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [code])

  const headerBg = isDark ? '#2b2b2b' : '#e8e8e8'
  const headerColor = isDark ? '#abb2bf' : '#636e7b'
  const borderColor = isDark ? '#3a3a3a' : '#d0d0d0'

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
      <PrismAsync
        language={lang}
        style={syntaxStyle}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: 13,
          lineHeight: 1.6,
          padding: '12px 16px',
          background: isDark ? '#282c34' : '#fafafa',
        }}
      >
        {code}
      </PrismAsync>
    </div>
  )
}

// React.memo 避免代码块在父组件重渲染时重复渲染语法高亮（A#11）
const CodeBlock = memo(CodeBlockInner)

export default CodeBlock
