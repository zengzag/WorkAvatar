import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Progress, Typography, Space, Tag, Button, theme } from 'antd'
import {
  CheckCircleFilled, LoadingOutlined, ClockCircleOutlined,
  CloseCircleFilled, FileTextOutlined, NodeIndexOutlined,
  FileSearchOutlined, BlockOutlined, RobotOutlined,
  CloudUploadOutlined, ThunderboltOutlined,
} from '@ant-design/icons'

const { Text } = Typography

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
  onClose: () => void
}

const KMSCollectionProcessModal: React.FC<KMSCollectionProcessModalProps> = ({
  open,
  collectionId,
  collectionName,
  onClose,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [stages, setStages] = useState<Record<string, StageState>>({})
  const [currentFileName, setCurrentFileName] = useState<string>('')
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0)
  const [totalFiles, setTotalFiles] = useState<number>(0)
  const [isDone, setIsDone] = useState(false)
  const [isError, setIsError] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [startedAt, setStartedAt] = useState<number>(0)
  const [autoCloseTimer, setAutoCloseTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // 重置状态
  const resetState = useCallback(() => {
    setStages({})
    setCurrentFileName('')
    setCurrentFileIndex(0)
    setTotalFiles(0)
    setIsDone(false)
    setIsError(false)
    setErrorMessage('')
    setStartedAt(0)
  }, [])

  // 订阅索引进度事件，按 collectionId 过滤
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
      // 仅处理当前合集的进度事件
      if (!progress.collectionId || progress.collectionId !== collectionId) return

      // 处理完成或错误阶段
      if (progress.phase === 'done') {
        setIsDone(true)
        setIsError(false)
        // 标记所有未完成阶段为 done
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
          // 标记当前 processing 阶段为 done（错误）
          for (const stage of STAGES) {
            if (next[stage.key]?.status === 'processing') {
              next[stage.key] = { ...next[stage.key], status: 'done', finishedAt: Math.floor(Date.now() / 1000) }
            }
          }
          return next
        })
        return
      }

      // 跳过未识别的阶段
      const stageDef = STAGES.find((s) => s.key === progress.phase)
      if (!stageDef) return

      // 更新阶段状态
      setStages((prev) => {
        const next = { ...prev }
        const prevStage = next[progress.phase]

        // 标记之前所有阶段为 done（如果还未标记）
        const currentIdx = STAGES.findIndex((s) => s.key === progress.phase)
        for (let i = 0; i < currentIdx; i++) {
          const prevKey = STAGES[i].key
          if (!next[prevKey]) {
            next[prevKey] = { status: 'done', current: 0, total: 0, message: '', finishedAt: Math.floor(Date.now() / 1000) }
          } else if (next[prevKey].status === 'processing') {
            next[prevKey] = { ...next[prevKey], status: 'done', finishedAt: Math.floor(Date.now() / 1000) }
          }
        }

        // 更新当前阶段
        next[progress.phase] = {
          status: progress.current >= progress.total && progress.total > 0 ? 'done' : 'processing',
          current: progress.current,
          total: progress.total,
          message: progress.message || '',
          startedAt: progress.startedAt,
          finishedAt: progress.current >= progress.total && progress.total > 0 ? Math.floor(Date.now() / 1000) : prevStage?.finishedAt,
        }
        return next
      })

      // 跟踪文件级进度（parsing 阶段）
      if (progress.phase === 'parsing') {
        setTotalFiles(progress.total)
        setCurrentFileIndex(progress.current)
        if (progress.fileName) {
          setCurrentFileName(progress.fileName)
        }
      }
    })

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [open, collectionId, resetState])

  // 完成后自动关闭（延迟 2.5 秒，便于用户看到完成状态）
  useEffect(() => {
    if (isDone && !autoCloseTimer) {
      const timer = setTimeout(() => {
        onClose()
      }, isError ? 4000 : 2500)
      setAutoCloseTimer(timer)
    }
    return () => {
      if (autoCloseTimer) {
        clearTimeout(autoCloseTimer)
        setAutoCloseTimer(null)
      }
    }
  }, [isDone, isError, autoCloseTimer, onClose])

  // 计算总体进度百分比
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
    window.electronAPI.kms.cancelCollectionDeepProcess()
  }

  // 渲染单个阶段
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

  // 计算耗时
  const elapsedSeconds = (() => {
    if (!startedAt) return 0
    let end = Math.floor(Date.now() / 1000)
    if (isDone) {
      // 取最后一个完成阶段的 finishedAt
      let latest = 0
      for (const k of Object.keys(stages)) {
        const f = stages[k]?.finishedAt
        if (f && f > latest) latest = f
      }
      if (latest > 0) end = latest
    }
    return Math.max(0, end - startedAt)
  })()

  const formatElapsed = (secs: number) => {
    if (secs < 60) return `${secs}s`
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}m ${s}s`
  }

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
          <Button danger onClick={handleCancel}>
            {t('kms.collectionProcess.cancel')}
          </Button>
        )
      }
      maskClosable={false}
      closable={isDone}
    >
      {/* 总体进度 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <Text strong style={{ fontSize: 13 }}>
            {isError ? t('kms.collectionProcess.errorTitle') : isDone ? t('kms.collectionProcess.doneTitle') : t('kms.collectionProcess.processingTitle')}
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
          status={isError ? 'exception' : isDone ? 'success' : 'active'}
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
