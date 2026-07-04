import React from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Spin, Empty, Card, Tag, Typography, theme } from 'antd'
import {
  RobotOutlined, TagOutlined, FileTextOutlined,
} from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface PreviewParagraph {
  title: string
  titlePath: string
  content: string
  summary: string
  keywords: string[]
}

interface KMSParagraphPreviewDrawerProps {
  open: boolean
  previewParagraph: PreviewParagraph | null
  previewLoading: boolean
  onClose: () => void
}

/** 章节预览抽屉：展示段落的标题路径、摘要、关键词与原文 */
export const KMSParagraphPreviewDrawer: React.FC<KMSParagraphPreviewDrawerProps> = ({
  open,
  previewParagraph,
  previewLoading,
  onClose,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Drawer
      title={previewParagraph?.title || t('kms.collectionDetails.previewParagraph')}
      open={open}
      onClose={onClose}
      width={520}
    >
      {previewLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : previewParagraph ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 标题路径 */}
          {previewParagraph.titlePath && (
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>{t('kms.collectionDetails.titlePath')}</Text>
              <div style={{ marginTop: 2 }}>
                <Text style={{ fontSize: 13 }}>{previewParagraph.titlePath}</Text>
              </div>
            </div>
          )}

          {/* 摘要 */}
          {previewParagraph.summary && (
            <Card size="small" style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <RobotOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.summary')}</Text>
              </div>
              <Paragraph style={{ fontSize: 12, margin: 0, color: token.colorTextSecondary }}>
                {previewParagraph.summary}
              </Paragraph>
            </Card>
          )}

          {/* 关键词 */}
          {previewParagraph.keywords.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <TagOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.keywords')}</Text>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {previewParagraph.keywords.map((kw, i) => (
                  <Tag key={i} style={{ fontSize: 11, margin: 0 }}>{kw}</Tag>
                ))}
              </div>
            </div>
          )}

          {/* 原文 */}
          {previewParagraph.content && (
            <Card size="small" style={{ borderColor: token.colorBorderSecondary }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <FileTextOutlined style={{ color: token.colorPrimary, fontSize: 13 }} />
                <Text strong style={{ fontSize: 12 }}>{t('kms.collectionDetails.originalContent')}</Text>
              </div>
              <Paragraph
                style={{
                  fontSize: 13,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 400,
                  overflow: 'auto',
                  backgroundColor: token.colorFillQuaternary,
                  padding: 12,
                  borderRadius: 4,
                }}
              >
                {previewParagraph.content}
              </Paragraph>
            </Card>
          )}

          {!previewParagraph.content && !previewParagraph.summary && (
            <Empty description={t('kms.collectionDetails.noContent')} />
          )}
        </div>
      ) : (
        <Empty description={t('kms.collectionDetails.previewLoadFailed')} />
      )}
    </Drawer>
  )
}

export default KMSParagraphPreviewDrawer
