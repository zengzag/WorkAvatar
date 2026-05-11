import { Typography } from 'antd'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const SkillSettings: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div>
      <Title level={5}>{t('settings.skillTitle')}</Title>
      <Text type="secondary">{t('settings.skillDesc')}</Text>
    </div>
  )
}

export default SkillSettings
