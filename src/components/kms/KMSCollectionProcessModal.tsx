import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Progress, Typography, Space, Tag, Button, theme } from 'antd'
import {
  CheckCircleFilled, LoadingOutlined, ClockCircleOutlined,
  CloseCircleFilled, FileTextOutlined, NodeIndexOutlined,
  FileSearchOutlined, BlockOutlined, RobotOutlined,
  CloudUploadOutlined, ThunderboltOutlined, MinusCircleOutlined,
} from '@ant-design/icons'

const { Text } = Typography

/** 计时器刷新间隔（毫秒） */
const TICK_INTERVAL_MS = 1000

/** 格式化耗时（秒 → 可读字符串） */
const formatElapsed = (secs: number) => {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s}s`
}

/** 合集深度处理阶段定义（按出现顺序） */
interface StageDef {
  key: string
  labelKey: string
  icon: React.ReactNode
}

const STAGES: StageDef[] = [
  { key: 'parsing', labelKey: 'kms.collectionProcess.stageParsing', icon: <FileTextOutlined /> },
  { key: 'paragraph_split', labelKey: 'kms.collectionProcess.stageParagraphSplit', icon: <BlockOutlined /> },
  { key: 'toc', labelKey: 'kms.collectionProcess.stageToc', icon: <NodeIndexOutlined /> },
  { key: 'paragraph_summary', labelKey: 'kms.collectionProcess.stageParagraphSummary', icon: <FileSearchOutlined /> },
  { key: 'doc_summary', labelKey: 'kms.collectionProcess.stageDocSummary', icon: <FileTextOutlined /> },
  { key: 'embedding', labelKey: 'kms.collectionProcess.stageEmbedding', icon: <CloudUploadOutlined /> },
  { key: 'collection_summary', labelKey: 'kms.collectionProcess.stageCollectionSummary', icon: <RobotOutlined /> },
  { key: 'collection_embedding', labelKey: 'kms.collectionProcess.stageCollectionEmbedding', icon: <ThunderboltOutlined /> },
]

type StageStatus = 'pending' | 'processing' | 'done'

interface StageState {
  status: StageStatus
  current: number
  total: number
  message: string
  startedAt?: number
  finishedAt?: number
}

interface KMSCollectionProcessModalProps {
  open: boolean
  collectionId: string | null
  collectionName: string
  /** 关闭弹窗（不取消后台处理） */
  onClose: () => void
  /** 取消处理 */
  onCancel: () => void
}

const KMSCollectionProcessModal: React.FC<KMSCollectionProcessModalProps> = ({
  open,
  collectionId,
  collectionName,
  onClose,
  onCancel,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [stages, setStages] = useState<Record<string, StageState>>({})
  const [currentFileName, setCurrentFileName] = useState<string>('')
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0)
  const [totalFiles, setTotalFiles] = useState<number>(0)
  const [isDone, setIsDone] = useState(false)
  const [isError, setIsError] = useState(false)
  const [isCancelled, setIsCancelled] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [startedAt, setStartedAt] = useState<number>(0)
  const [, setTick] = useState(0)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const resetState = useCallback(() => {
    setStages({})
    setCurrentFileName('')
    setCurrentFileIndex(0)
    setTotalFiles(0)
    setIsDone(false)
    setIsError(false)
    setIsCancelled(false)
    setErrorMessage('')
    setStartedAt(0)
  }, [])

  useEffect(() => {
    if (!open || !collectionId) {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      return
    }

    resetState()
    setStartedAt(Math.floor(Date.now() / 1000))

    unsubscribeRef.current = window.electronAPI.kms.onIndexProgress((progress) => {
      if (!progress.collectionId || progress.collectionId !== collectionId) return

      if (progress.phase === 'done') {
        setIsDone(true)
        setIsError(false)
        if (progress.cancelled) {
          setIsCancelled(true)
        }
        setStages((prev) => {
          const next = { ...prev }
          for (const stage of STAGES) {
            if (!next[stage.key] || next[stage.key].status === 'processing') {
              next[stage.key] = {
                ...(next[stage.key] || { current: 0, total: 0, message: '' }),
                status: 'done',
                finishedAt: Math.floor(Date.now() / 1000),
              }
            }
          }
          return next
        })
        return
      }

      if (progress.phase === 'error') {
        setIsError(true)
        setIsDone(true)
        setErrorMessage(progress.message || 'Unknown error')
        setStages((prev) => {
          const next = { ...prev }
          for (const stage of STAGES) {
            if (next[stage.key]?.status === 'processing') {
              next[stage.key] = { ...next[stage.key], status: 'done', finishedAt: Math.floor(Date.now() / 1000) }
            }
          }
          return next
        })
        return
      }

      const stageDef = STAGES.find((s) => s.key === progress.phase)
      if (!stageDef) return

      setStages((prev) => {
        const next = { ...prev }

        const currentIdx = STAGES.findIndex((s) => s.key === progress.phase)
        for (let i = 0; i < currentIdx; i++) {
          const prevKey = STAGES[i].key
          if (!next[prevKey]) {
            next[prevKey] = { status: 'done', current: 0, total: 0, message: '', finishedAt: Math.floor(Date.now() / 1000) }
          } else if (next[prevKey].status === 'processing') {
            next[prevKey] = { ...next[prevKey], status: 'done', finishedAt: Math.floor(Date.now() / 1000) }
          }
        }

        const existingStage = next[progress.phase]
        if (!existingStage || existingStage.status !== 'done') {
          next[progress.phase] = {
            status: progress.current >= progress.total && progress.total > 0 ? 'done' : 'processing',
            current: progress.current,
            total: progress.total,
            message: progress.message || '',
            startedAt: progress.startedAt,
            finishedAt: progress.current >= progress.total && progress.total > 0 ? Math.floor(Date.now() / 1000) : existingStage?.finishedAt,
          }
        }
        return next
      })

      if (progress.fileName) {
        setCurrentFileName(progress.fileName)
      }
      if (progress.phase === 'parsing' && progress.total > 0) {
        setTotalFiles(progress.total)
        setCurrentFileIndex(progress.current)
      }
    })

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [open, collectionId, resetState])

  useEffect(() => {
    if (!open || isDone || isError || isCancelled || !startedAt) return
    const timer = setInterval(() => setTick((n) => n + 1), TICK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [open, isDone, isError, isCancelled, startedAt])

  const overallPercent = (() => {
    if (isDone) return 100
    const completed = STAGES.filter((s) => stages[s.key]?.status === 'done').length
    const processingStage = STAGES.find((s) => stages[s.key]?.status === 'processing')
    let fraction = completed / STAGES.length
    if (processingStage && stages[processingStage.key]) {
      const st = stages[processingStage.key]
      if (st.total > 0) {
        fraction += (st.current / st.total) / STAGES.length
      }
    }
    return Math.min(Math.round(fraction * 100), 99)
  })()

  const handleCancel = () => {
    onCancel()
  }

  const renderStage = (stage: StageDef, index: number) => {
    const state = stages[stage.key]
    const status: StageStatus = state?.status || 'pending'
    const isLast = index === STAGES.length - 1

    let icon: React.ReactNode
    let color: string
    if (status === 'done') {
      icon = <CheckCircleFilled style={{ color: token.colorSuccess }} />
      color = token.colorSuccess
    } else if (status === 'processing') {
      icon = <LoadingOutlined style={{ color: token.colorPrimary }} />
      color = token.colorPrimary
    } else {
      icon = <ClockCircleOutlined style={{ color: token.colorTextQuaternary }} />
      color = token.colorTextQuaternary
    }

    return (
      <div key={stage.key} style={{ display: 'flex', gap: 12, position: 'relative' }}>
        {/* 时间线轴 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: 16, lineHeight: '24px' }}>{icon}</div>
          {!isLast && (
            <div style={{
              width: 2,
              flex: 1,
              minHeight: 16,
              backgroundColor: status === 'done' ? token.colorSuccess : token.colorBorderSecondary,
              marginTop: 2,
            }} />
          )}
        </div>

        {/* 阶段内容 */}
        <div style={{ flex: 1, paddingBottom: isLast ? 0 : 16, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Space size={6}>
              <span style={{ color, fontSize: 13 }}>{stage.icon}</span>
              <Text strong style={{ fontSize: 13, color: status === 'pending' ? token.colorTextQuaternary : token.colorText }}>
                {t(stage.labelKey)}
              </Text>
            </Space>
            {status === 'processing' && state && state.total > 0 && (
              <Tag color="processing" style={{ fontSize: 10, margin: 0 }}>
                {state.current}/{state.total}
              </Tag>
            )}
            {status === 'done' && state && state.total > 0 && (
              <Tag color="success" style={{ fontSize: 10, margin: 0 }}>
                {state.total}
              </Tag>
            )}
          </div>
          {status === 'processing' && state && (
            <div style={{ marginBottom: 4 }}>
              {state.total > 0 && (
                <Progress
                  percent={Math.round((state.current / state.total) * 100)}
                  size="small"
                  status="active"
                  style={{ marginBottom: 4, fontSize: 11 }}
                />
              )}
              {state.message && (
                <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {state.message}
                </Text>
              )}
            </div>
          )}
          {status === 'done' && state && state.message && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {state.message}
            </Text>
          )}
        </div>
      </div>
    )
  }

  const elapsedSeconds = (() => {
    if (!startedAt) return 0
    let end = Math.floor(Date.now() / 1000)
    if (isDone) {
      let latest = 0
      for (const k of Object.keys(stages)) {
        const f = stages[k]?.finishedAt
        if (f && f > latest) latest = f
      }
      if (latest > 0) end = latest
    }
    return Math.max(0, end - startedAt)
  })()

  const titleText = (() => {
    if (isCancelled) return t('kms.collectionProcess.cancelledTitle')
    if (isError) return t('kms.collectionProcess.errorTitle')
    if (isDone) return t('kms.collectionProcess.doneTitle')
    return t('kms.collectionProcess.processingTitle')
  })()

  return (
    <Modal
      open={open}
      title={
        <Space>
          <RobotOutlined style={{ color: token.colorPrimary }} />
          <span>{t('kms.collectionProcess.title')}</span>
          {collectionName && (
            <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal' }}>
              - {collectionName}
            </Text>
          )}
        </Space>
      }
      onCancel={onClose}
      width={560}
      footer={
        isDone ? (
          <Button onClick={onClose}>{t('common.close')}</Button>
        ) : (
          <Space>
            <Button
              icon={<MinusCircleOutlined />}
              onClick={onClose}
            >
              {t('kms.collectionProcess.runInBackground')}
            </Button>
            <Button danger onClick={handleCancel}>
              {t('kms.collectionProcess.cancel')}
            </Button>
          </Space>
        )
      }
      maskClosable={false}
      closable={true}
    >
      {/* 总体进度 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            {titleText}
          </Text>
          <Space size={12}>
            {startedAt > 0 && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {formatElapsed(elapsedSeconds)}
              </Text>
            )}
            <Text type="secondary" style={{ fontSize: 11 }}>
              {overallPercent}%
            </Text>
          </Space>
        </div>
        <Progress
          percent={overallPercent}
          status={isCancelled ? 'normal' : isError ? 'exception' : isDone ? 'success' : 'active'}
        />
      </div>

      {/* 当前文件处理提示 */}
      {!isDone && currentFileName && totalFiles > 0 && (
        <div style={{
          marginBottom: 12,
          padding: '8px 12px',
          backgroundColor: token.colorPrimaryBg,
          borderRadius: 4,
          borderLeft: `3px solid ${token.colorPrimary}`,
        }}>
          <Space size={6}>
            <FileTextOutlined style={{ color: token.colorPrimary }} />
            <Text style={{ fontSize: 12 }}>
              {t('kms.collectionProcess.currentFile', { index: currentFileIndex, total: totalFiles })}
            </Text>
          </Space>
          <div style={{ marginTop: 2 }}>
            <Text strong ellipsis style={{ fontSize: 12, display: 'block' }}>
              {currentFileName}
            </Text>
          </div>
        </div>
      )}

      {/* 取消提示 */}
      {isCancelled && (
        <div style={{
          marginBottom: 12,
          padding: '8px 12px',
          backgroundColor: token.colorFillQuaternary,
          borderRadius: 4,
          borderLeft: `3px solid ${token.colorTextTertiary}`,
        }}>
          <Space size={6}>
            <MinusCircleOutlined style={{ color: token.colorTextTertiary }} />
            <Text strong style={{ fontSize: 12 }}>
              {t('kms.collectionProcess.cancelledHint')}
            </Text>
          </Space>
        </div>
      )}

      {/* 错误信息 */}
      {isError && errorMessage && (
        <div style={{
          marginBottom: 12,
          padding: '8px 12px',
          backgroundColor: token.colorErrorBg,
          borderRadius: 4,
          borderLeft: `3px solid ${token.colorError}`,
        }}>
          <Space size={6}>
            <CloseCircleFilled style={{ color: token.colorError }} />
            <Text strong style={{ fontSize: 12, color: token.colorError }}>
              {t('kms.collectionProcess.errorOccurred')}
            </Text>
          </Space>
          <div style={{ marginTop: 2 }}>
            <Text style={{ fontSize: 12, wordBreak: 'break-all' }}>{errorMessage}</Text>
          </div>
        </div>
      )}

      {/* 阶段时间线 */}
      <div style={{ maxHeight: 360, overflow: 'auto', paddingRight: 4 }}>
        {STAGES.map((stage, idx) => renderStage(stage, idx))}
      </div>
    </Modal>
  )
}

export default KMSCollectionProcessModal
