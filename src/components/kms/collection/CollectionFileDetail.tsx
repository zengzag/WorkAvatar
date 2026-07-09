import React from 'react'
import { useTranslation } from 'react-i18next'
import { Spin, Empty, Card, Tree, Tooltip, Button, Tag, Typography, theme } from 'antd'
import { RobotOutlined, TagOutlined, NodeIndexOutlined, EyeOutlined } from '@ant-design/icons'
import {
  type CollectionFile,
  type FileDetailCache,
  type ParagraphItem,
  parseJsonArray,
  buildTocTree,
} from './collection-types'

interface CollectionFileDetailProps {
  file: CollectionFile
  detail: FileDetailCache
  onPreviewParagraph: (paragraphId: string) => void
}

const { Text, Paragraph } = Typography

const CollectionFileDetail: React.FC<CollectionFileDetailProps> = ({ detail, onPreviewParagraph }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  if (!detail || detail.loading) {
    return <div style={{ padding: '12px 24px' }}><Spin size="small" /></div>
  }
  if (detail.error) {
    return (
      <div style={{ padding: '12px 24px' }}>
        <Text type="danger" style={{ fontSize: 12 }}>{detail.error}</Text>
      </div>
    )
  }

  const fileSummary = detail.summary
  const keywords = parseJsonArray(fileSummary?.keywords_json)
  const mainTopics = parseJsonArray(fileSummary?.main_topics_json)
  const hasParagraphs = detail.paragraphs.length > 0

  if (!fileSummary?.summary && !hasParagraphs) {
    return (
      <div style={{ padding: '12px 24px' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('kms.collectionDetails.noAiContent')}
        />
      </div>
    )
  }

  return (
    <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {fileSummary?.summary && (
        <Card size="small" style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <RobotOutlined style={{ color: token.colorPrimary, fontSize: 14 }} />
            <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.fileSummaryTitle')}</Text>
          </div>
          <Paragraph style={{ fontSize: 12, margin: 0, color: token.colorTextSecondary }}>
            {fileSummary.summary}
          </Paragraph>
          {(keywords.length > 0 || mainTopics.length > 0) && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {keywords.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <TagOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
                  {keywords.slice(0, 8).map((kw, i) => (
                    <Tag key={`kw-${i}-${kw}`} style={{ fontSize: 10, margin: 0 }}>{kw}</Tag>
                  ))}
                </div>
              )}
              {mainTopics.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <NodeIndexOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
                  {mainTopics.slice(0, 8).map((topic, i) => (
                    <Tag key={`topic-${i}-${topic}`} color="purple" style={{ fontSize: 10, margin: 0 }}>{topic}</Tag>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {hasParagraphs && (
        <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <NodeIndexOutlined style={{ color: token.colorPrimary, fontSize: 14 }} />
            <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.tocTitle')}</Text>
            <Tag style={{ fontSize: 10, margin: 0 }}>{detail.paragraphs.length}</Tag>
          </div>
          <Tree
            treeData={buildTocTree(detail.paragraphs, t)}
            defaultExpandAll
            showLine
            selectable={false}
            titleRender={(node: any) => {
              const raw = node?.raw as ParagraphItem
              if (!raw) return node?.title
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
                    <Text style={{ fontSize: 12 }}>{raw.title || t('kms.collectionDetails.unnamed')}</Text>
                    {raw.summary && (
                      <Tooltip title={raw.summary}>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {raw.summary.length > 60 ? raw.summary.slice(0, 60) + '…' : raw.summary}
                        </Text>
                      </Tooltip>
                    )}
                  </div>
                  <Tooltip title={t('kms.collectionDetails.previewParagraph')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EyeOutlined />}
                      onClick={(e) => {
                        e.stopPropagation()
                        onPreviewParagraph(raw.id)
                      }}
                      style={{ flexShrink: 0 }}
                    />
                  </Tooltip>
                </div>
              )
            }}
          />
        </Card>
      )}
    </div>
  )
}

export default CollectionFileDetail
