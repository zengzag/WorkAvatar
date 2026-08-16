import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Space, Typography, Tag, theme } from 'antd'
import { FileTextOutlined, UploadOutlined, CloseOutlined } from '@ant-design/icons'

interface ContextFile {
  name: string
  content: string
}

interface PromptFileSelectorProps {
  value: ContextFile | null
  onChange: (file: ContextFile | null) => void
}

/** 提示词文件选择器：选择单个文本文件（如 agent.md）用于生成数字员工 */
const PromptFileSelector: React.FC<PromptFileSelectorProps> = ({ value, onChange }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = () => {
        onChange({ name: file.name, content: String(reader.result || '') })
      }
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text strong>{t('creationWizard.promptFileLabel')}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('creationWizard.promptFileHint')}
        </Typography.Text>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,.txt,.text,text/plain,text/markdown"
        style={{ display: 'none' }}
        onChange={handleSelect}
      />
      {value ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '10px 16px',
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            background: token.colorPrimaryBg,
          }}
        >
          <FileTextOutlined style={{ color: token.colorPrimary, marginRight: 12 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Typography.Text strong ellipsis style={{ display: 'block' }}>
              {value.name}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {value.content.length} {t('creationWizard.promptFileChars')}
            </Typography.Text>
          </div>
          <Space>
            <Tag color="blue">{t('creationWizard.promptFileSelected')}</Tag>
            <Button size="small" icon={<CloseOutlined />} onClick={() => onChange(null)}>
              {t('common.clear')}
            </Button>
          </Space>
        </div>
      ) : (
        <Button icon={<UploadOutlined />} onClick={() => inputRef.current?.click()}>
          {t('creationWizard.promptFileSelect')}
        </Button>
      )}
    </div>
  )
}

export default PromptFileSelector