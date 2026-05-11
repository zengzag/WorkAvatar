import { Typography } from 'antd'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const MCPServerSettings: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div>
      <Title level={5}>{t('settings.mcpServerTitle')}</Title>
      <Text type="secondary">{t('settings.mcpServerDesc')}</Text>
    </div>
  )
}

export default MCPServerSettings
