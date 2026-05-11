import { Button, Space, Divider, Typography } from 'antd'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const AboutSection: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div>
      <Title level={5}>{t('settings.aboutTitle')}</Title>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">{t('settings.version')}</Text>
          <Text>1.0.0-dev</Text>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Text type="secondary">{t('settings.buildDate')}</Text>
          <Text>2026-05-06</Text>
        </div>
        <Divider />
        <Button block>{t('settings.exportLogs')}</Button>
      </Space>
    </div>
  )
}

export default AboutSection
