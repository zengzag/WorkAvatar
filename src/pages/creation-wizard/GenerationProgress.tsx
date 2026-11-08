import { useTranslation } from 'react-i18next'
import { Progress, Spin, theme, Typography } from 'antd'

const { Text } = Typography

const STAGE_KEYS: Record<string, string> = {
  preparing: 'creationWizard.generatingPreparing',
  llm_calling: 'creationWizard.generatingCalling',
  thinking: 'creationWizard.generatingThinking',
  streaming: 'creationWizard.generatingWriting',
  parsing: 'creationWizard.generatingParsing',
  done: 'creationWizard.generatingDone',
  error: 'creationWizard.generatingError',
}

interface GenerationProgressProps {
  progress: number
  stage: string
  contentChunks: string[]
}

/** 生成进度：阶段文案 + 进度条 + 实时输出 */
const GenerationProgress: React.FC<GenerationProgressProps> = ({ progress, stage, contentChunks }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const streaming = contentChunks.join('')

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {stage !== 'error' && <Spin size="small" />}
        <Text style={{ fontSize: 13 }}>
          {STAGE_KEYS[stage] ? t(STAGE_KEYS[stage]) : t('creationWizard.generating')}
        </Text>
      </div>
      <Progress
        percent={progress}
        size="small"
        showInfo={false}
        status={stage === 'error' ? 'exception' : 'active'}
      />
      {streaming && (
        <div
          style={{
            marginTop: 12,
            maxHeight: 260,
            overflow: 'auto',
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorFillQuaternary,
          }}
        >
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: token.colorTextSecondary,
            }}
          >
            {streaming}
          </pre>
        </div>
      )}
    </div>
  )
}

export default GenerationProgress
