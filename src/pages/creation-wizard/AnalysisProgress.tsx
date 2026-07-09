import { useTranslation } from 'react-i18next'
import { Card, Progress, Timeline, Alert } from 'antd'

interface AnalysisProgressProps {
  progress: number
  stage: string
  detail: string
}

/** 分析进度展示（进度条 + 步骤时间线 + 详情提示） */
const AnalysisProgress: React.FC<AnalysisProgressProps> = ({ progress, stage, detail }) => {
  const { t } = useTranslation()

  return (
    <Card title={t('creationWizard.analysisProgress')} style={{ marginBottom: 16 }}>
      <Progress percent={progress} status={stage === 'error' ? 'exception' : 'active'} />
      <Timeline
        items={[
          { color: progress >= 10 ? 'green' : 'gray', content: t('creationWizard.stepPrepare') },
          { color: progress >= 30 ? 'green' : 'gray', content: t('creationWizard.stepCallLlm') },
          { color: progress >= 45 ? 'green' : 'gray', content: t('creationWizard.stepLlmThinking') },
          { color: progress >= 60 ? 'green' : 'gray', content: t('creationWizard.stepReceiveStream') },
          { color: progress >= 90 ? 'green' : 'gray', content: t('creationWizard.stepParseResult') },
        ]}
      />
      {detail && (
        <Alert title={detail} type="info" showIcon style={{ marginTop: 12 }} />
      )}
    </Card>
  )
}

interface AnalysisStreamingProps {
  thinkChunks: string[]
  contentChunks: string[]
}

/** LLM 流式输出展示（思考过程 + 实时输出） */
const AnalysisStreaming: React.FC<AnalysisStreamingProps> = ({ thinkChunks, contentChunks }) => {
  const { t } = useTranslation()

  return (
    <>
      {thinkChunks.length > 0 && (
        <Card title={t('creationWizard.llmThinkingProcess')} size="small" style={{ marginBottom: 16, maxHeight: 200, overflow: 'auto' }}>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0, color: '#8c8c8c' }}>
            {thinkChunks.join('')}
          </pre>
        </Card>
      )}
      {contentChunks.length > 0 && (
        <Card title={t('creationWizard.llmRealtimeOutput')} size="small" style={{ marginBottom: 16, maxHeight: 300, overflow: 'auto' }}>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, margin: 0 }}>
            {contentChunks.join('')}
          </pre>
        </Card>
      )}
    </>
  )
}

export { AnalysisProgress, AnalysisStreaming }
