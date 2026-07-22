import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Spin, Empty, theme } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { NoteSearchHit } from '../../types/notes'

interface Props {
  query: string
  results: NoteSearchHit[]
  searching: boolean
  onQueryChange: (q: string) => void
  onOpenHit: (relPath: string, text?: string) => void
}

/** 全文搜索面板：输入关键字（防抖）→ 列出命中文件与片段 → 点击打开并定位行 */
const NotesSearchPanelInner: React.FC<Props> = ({
  query, results, searching, onQueryChange, onOpenHit,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  // 本地输入值，独立于父级 query（父级 query 防抖后才更新）
  const [text, setText] = useState(query)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onQueryChange(text)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [text, onQueryChange])

  // 父级外部清空 query 时同步本地输入
  useEffect(() => {
    if (query !== text && query === '' && text !== '') setText('')
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalHits = useMemo(() => results.reduce((s, r) => s + r.snippets.length, 0), [results])

  const highlight = (line: string, q: string) => {
    const query = q.trim()
    if (!query) return line
    const lower = line.toLowerCase()
    const ql = query.toLowerCase()
    const out: React.ReactNode[] = []
    let i = 0
    while (i < line.length) {
      const idx = lower.indexOf(ql, i)
      if (idx < 0) {
        out.push(line.slice(i))
        break
      }
      if (idx > i) out.push(line.slice(i, idx))
      out.push(
        <mark key={idx} style={{ background: token.colorPrimaryBg, color: token.colorPrimary, padding: '0 1px' }}>
          {line.slice(idx, idx + query.length)}
        </mark>
      )
      i = idx + query.length
    }
    return out
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: token.colorBgContainer }}>
      <div style={{ padding: '8px 8px 6px' }}>
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
          placeholder={t('notes.searchPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {query && !searching && (
          <div style={{ padding: '4px 4px 0', fontSize: 11, color: token.colorTextTertiary }}>
            {t('notes.searchStats', { files: results.length, hits: totalHits })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 4px 8px' }}>
        {searching ? (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <Spin size="small" />
          </div>
        ) : results.length === 0 ? (
          query ? (
            <div style={{ padding: 16 }}>
              <Empty description={t('notes.noSearchResults')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : null
        ) : (
          results.map((hit) => (
            <div
              key={hit.relPath}
              style={{
                marginBottom: 6,
                padding: '6px 8px',
                borderRadius: 4,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorFillQuaternary,
              }}
            >
              <div
                onClick={() => onOpenHit(hit.relPath)}
                title={hit.relPath}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: token.colorPrimary,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: hit.snippets.length ? 4 : 0,
                }}
              >
                {hit.relPath}
              </div>
              {hit.snippets.map((s, idx) => (
                <div
                  key={`${s.line}-${idx}`}
                  onClick={() => onOpenHit(hit.relPath, s.text)}
                  style={{
                    fontSize: 11,
                    color: token.colorTextSecondary,
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 3,
                    background: token.colorBgContainer,
                    marginBottom: 2,
                    lineHeight: 1.5,
                    border: `1px solid transparent`,
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = token.colorPrimaryBorder }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent' }}
                >
                  <span style={{ color: token.colorTextTertiary, marginRight: 6 }}>{s.line + 1}</span>
                  {highlight(s.text, query)}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export const NotesSearchPanel = memo(NotesSearchPanelInner)
export default NotesSearchPanel
