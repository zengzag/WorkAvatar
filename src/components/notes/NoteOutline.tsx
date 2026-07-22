import { memo, useMemo } from 'react'
import { theme, Empty } from 'antd'
import { useTranslation } from 'react-i18next'
import type { NoteOutlineItem } from '../../types/notes'

interface Props {
  content: string
  onJump: (line: number) => void
}

/** 从 Markdown 文本提取标题大纲 */
export function parseOutline(content: string): NoteOutlineItem[] {
  const lines = content.split(/\r?\n/)
  const items: NoteOutlineItem[] = []
  let inCodeFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      items.push({ level: m[1].length, text: m[2].replace(/\s+$/, ''), line: i })
    }
  }
  return items
}

const NoteOutlineInner: React.FC<Props> = ({ content, onJump }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const items = useMemo(() => parseOutline(content), [content])

  if (items.length === 0) {
    return (
      <div style={{ padding: '12px 8px' }}>
        <Empty description={t('notes.noOutline')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    )
  }

  return (
    <div style={{ padding: '6px 0' }}>
      {items.map((item, idx) => (
        <div
          key={`${item.line}-${idx}`}
          onClick={() => onJump(item.line)}
          style={{
            padding: '4px 12px',
            paddingLeft: 12 + (item.level - 1) * 12,
            fontSize: 13 - Math.min(item.level - 1, 3),
            color: item.level <= 2 ? token.colorText : token.colorTextSecondary,
            fontWeight: item.level <= 2 ? 500 : 400,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            borderLeft: `2px solid transparent`,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = token.colorFillQuaternary
            e.currentTarget.style.borderLeftColor = token.colorPrimary
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.borderLeftColor = 'transparent'
          }}
          title={item.text}
        >
          {item.text}
        </div>
      ))}
    </div>
  )
}

export const NoteOutline = memo(NoteOutlineInner)
export default NoteOutline
