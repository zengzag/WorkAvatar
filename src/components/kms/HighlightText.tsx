import React from 'react'
import { theme } from 'antd'

interface HighlightRange {
  start: number
  end: number
}

interface HighlightTextProps {
  text: string
  highlights?: HighlightRange[]
  keywords?: string[]
  keywordColor?: string
}

/**
 * 根据关键词数组计算文本中的高亮范围
 * 支持多关键词、大小写不敏感、合并重叠范围
 */
function computeHighlightsFromKeywords(text: string, keywords: string[]): HighlightRange[] {
  const ranges: HighlightRange[] = []
  const lowerText = text.toLowerCase()
  for (const kw of keywords) {
    if (!kw) continue
    const lowerKw = kw.toLowerCase()
    let from = 0
    while (from < lowerText.length) {
      const idx = lowerText.indexOf(lowerKw, from)
      if (idx === -1) break
      ranges.push({ start: idx, end: idx + kw.length })
      from = idx + kw.length
    }
  }
  return ranges
}

function mergeHighlights(highlights: HighlightRange[]): HighlightRange[] {
  if (highlights.length === 0) return []
  const sorted = [...highlights].sort((a, b) => a.start - b.start)
  const merged: HighlightRange[] = []
  for (const h of sorted) {
    if (merged.length === 0 || h.start > merged[merged.length - 1].end) {
      merged.push({ start: h.start, end: h.end })
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, h.end)
    }
  }
  return merged
}

const HighlightText: React.FC<HighlightTextProps> = ({ text, highlights, keywords, keywordColor }) => {
  const { token } = theme.useToken()
  const isDark = token.colorBgContainer === '#141414' || token.colorBgContainer === '#1f1f1f' || token.colorBgContainer?.toString().startsWith('#1')

  let effectiveHighlights = highlights || []
  if (keywords && keywords.length > 0) {
    const kwRanges = computeHighlightsFromKeywords(text, keywords)
    effectiveHighlights = [...effectiveHighlights, ...kwRanges]
  }

  if (effectiveHighlights.length === 0) {
    return <>{text}</>
  }

  // 暗色主题使用更鲜明的高亮色，亮色主题使用柔和的背景色
  const bgColor = keywordColor || (isDark ? '#e6a817' : token.colorWarningBg)
  const textColor = isDark ? '#1a1a1a' : 'inherit'

  const merged = mergeHighlights(effectiveHighlights)

  const segments: React.ReactNode[] = []
  let lastEnd = 0

  for (let i = 0; i < merged.length; i++) {
    const h = merged[i]
    if (h.start > lastEnd) {
      segments.push(
        <span key={`t-${i}`}>{text.slice(lastEnd, h.start)}</span>
      )
    }
    segments.push(
      <mark
        key={`h-${i}`}
        style={{
          background: bgColor,
          padding: '1px 2px',
          borderRadius: 2,
          fontWeight: 500,
          color: textColor,
        }}
      >
        {text.slice(h.start, h.end)}
      </mark>
    )
    lastEnd = h.end
  }

  if (lastEnd < text.length) {
    segments.push(
      <span key="tail">{text.slice(lastEnd)}</span>
    )
  }

  return <>{segments}</>
}

export default React.memo(HighlightText)
