import React from 'react'
import { Typography } from 'antd'

const { Text } = Typography

export interface CollectionFile {
  id: string
  file_name: string
  file_path: string
  file_ext: string
  file_size: number
  data_tier: string
  index_status: string
  modified_time: number
  added_at: number
  summary: string
  light_summary: string
  keywords_json: string
  main_topics_json: string
}

export interface CollectionStats {
  fileCount: number
  indexedCount: number
  hotCount: number
  pendingCount: number
  hasSummary: boolean
}

export interface CollectionSummary {
  collection_id: string
  summary: string
  key_topics_json: string
  updated_at?: number
}

export interface FileSummary {
  file_id: string
  summary: string
  toc_json: string
  keywords_json: string
  main_topics_json: string
  updated_at?: number
}

export interface ParagraphItem {
  id: string
  title: string
  title_path: string
  level: number
  paragraph_index: number
  start_offset: number
  end_offset: number
  summary?: string
  keywords_json?: string
}

export interface FileDetailCache {
  summary: FileSummary | null
  paragraphs: ParagraphItem[]
  loading: boolean
  error?: string
}

export interface ProcessingCollectionState {
  id: string
  name: string
  phase: string
  message: string
  current: number
  total: number
  percent: number
  lastUpdated: number
}

export interface KMSCollectionsViewProps {
  onSearchInCollection?: (collectionId: string) => void
  onPreviewFile?: (file: { file_id: string; file_name: string; file_path: string; text: string; match_type: string }) => void
}

export const POLL_INTERVAL_MS = 3000

export const STAGE_KEYS = ['parsing', 'paragraph_split', 'toc', 'paragraph_summary', 'doc_summary', 'embedding', 'collection_summary', 'collection_embedding'] as const
export const STAGE_INDEX: Record<string, number> = {}
STAGE_KEYS.forEach((k, i) => { STAGE_INDEX[k] = i })

export const SUPPORTED_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'html', 'htm']

export const parseJsonArray = (json?: string): string[] => {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

export const buildTocTree = (paragraphs: ParagraphItem[], t: (key: string, options?: any) => string): React.ReactNode[] => {
  const sorted = [...paragraphs].sort((a, b) => a.paragraph_index - b.paragraph_index)
  const roots: any[] = []
  const stack: { node: any; level: number }[] = []

  sorted.forEach((p) => {
    const node = {
      key: p.id,
      title: (
        <span>
          <Text style={{ fontSize: 12 }}>{p.title || t('kms.collectionDetails.unnamedParagraph')}</Text>
          {p.summary ? (
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
              {p.summary.length > 50 ? p.summary.slice(0, 50) + '…' : p.summary}
            </Text>
          ) : null}
        </span>
      ),
      raw: p,
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= p.level) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1].node
      if (!parent.children) parent.children = []
      parent.children.push(node)
    }
    stack.push({ node, level: p.level })
  })
  return roots
}
