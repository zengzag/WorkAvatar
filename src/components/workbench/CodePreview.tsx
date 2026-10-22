import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { Button, Result, Spin, Tooltip, theme } from 'antd'
import { CheckOutlined, CopyOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { GeneratedFileInfo } from '../../types'
import { grammarLoadVersion, highlightCodeLines, languageForPath, subscribeGrammarLoaded } from '../../utils/shiki'

interface CodePreviewProps {
  file: GeneratedFileInfo
  fileUrl: string
  /** 当前预览主题，与侧边栏的明暗切换联动 */
  dark: boolean
}

const CODE_FONT = 'Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace'

/** 代码文件预览：Shiki 高亮 + 行号 + 换行/复制，替代 file-viewer 的文本渲染 */
const CodePreview: React.FC<CodePreviewProps> = ({ file, fileUrl, dark }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const grammarVersion = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadVersion)
  const [text, setText] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)

  const language = useMemo(() => languageForPath(file.path), [file.path])

  useEffect(() => {
    const controller = new AbortController()
    setText(undefined)
    setFailed(false)
    fetch(fileUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      })
      .then((value) => {
        if (!controller.signal.aborted) setText(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [fileUrl, attempt])

  const lines = useMemo(() => {
    if (text === undefined) return undefined
    return highlightCodeLines(text, language, dark)
  }, [text, language, dark, grammarVersion])

  // 语法懒加载中或未知语言时降级为纯文本行，仍保留行号
  const displayLines = useMemo(() => {
    if (lines !== undefined) return lines
    if (text === undefined) return undefined
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
    return normalized.split('\n').map((line) => [{ text: line, style: {} as CSSProperties }])
  }, [lines, text])

  const handleCopy = useCallback(() => {
    if (text === undefined) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  if (failed) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Result
          status="warning"
          title={t('workbench.codeLoadFailed')}
          extra={<Button onClick={() => setAttempt((value) => value + 1)}>{t('workbench.codeRetry')}</Button>}
        />
      </div>
    )
  }

  if (displayLines === undefined) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  const codeBg = dark ? '#282c34' : '#fafafa'
  const gutterWidth = `${String(displayLines.length).length + 1}ch`

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: codeBg }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 34,
        padding: '0 10px',
        flexShrink: 0,
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: token.colorTextSecondary }}>
          {language ?? file.ext.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: token.colorTextQuaternary }}>
          {t('workbench.codeLineCount', { count: displayLines.length })}
        </span>
        <div style={{ flex: 1 }} />
        <Tooltip title={wrap ? t('workbench.codeUnwrap') : t('workbench.codeWrap')}>
          <Button
            size="small"
            type={wrap ? 'primary' : 'text'}
            icon={<MenuUnfoldOutlined />}
            onClick={() => setWrap((value) => !value)}
          />
        </Tooltip>
        <Tooltip title={copied ? t('workbench.codeCopied') : t('workbench.codeCopy')}>
          <Button
            size="small"
            type="text"
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={handleCopy}
          />
        </Tooltip>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <pre style={{
          margin: 0,
          padding: '10px 0',
          fontSize: 12.5,
          lineHeight: 1.6,
          fontFamily: CODE_FONT,
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          wordBreak: wrap ? 'break-word' : 'normal',
        }}>
          <code>
            {displayLines.map((line, index) => (
              <div key={index} style={{ display: 'flex' }}>
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: gutterWidth,
                    paddingRight: 12,
                    textAlign: 'right',
                    color: dark ? '#5c6370' : '#b0b0b0',
                    userSelect: 'none',
                  }}
                >
                  {index + 1}
                </span>
                <span style={{ flex: 1, minWidth: wrap ? 0 : undefined, paddingRight: 12, whiteSpace: 'inherit' }}>
                  {line.length === 0 ? '\u200b' : line.map((span, spanIndex) => (
                    <span key={spanIndex} style={span.style}>{span.text}</span>
                  ))}
                </span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}

export default CodePreview
