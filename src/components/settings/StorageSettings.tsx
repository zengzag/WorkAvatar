import { Button, Select, Divider, Typography } from 'antd'
import { FolderOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text, Title } = Typography

const StorageSettings: React.FC = () => {
  const { t } = useTranslation()

  return (
    <div>
      <Title level={5}>{t('settings.storageTitle')}</Title>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>{t('settings.dataDir')}</Text>
            <br />
            <Text type="secondary">{t('settings.dataDirDesc')}</Text>
          </div>
          <Button icon={<FolderOutlined />}>{t('settings.selectDir')}</Button>
        </div>
        <Divider />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>{t('settings.autoBackup')}</Text>
            <br />
            <Text type="secondary">{t('settings.autoBackupDesc')}</Text>
          </div>
          <Select defaultValue="manual" style={{ width: 150 }} options={[
            { value: 'manual', label: t('settings.backupManual') },
            { value: 'daily', label: t('settings.backupDaily') },
            { value: 'weekly', label: t('settings.backupWeekly') },
          ]} />
        </div>
        <Divider />
        <Button danger>{t('settings.clearAllData')}</Button>
      </div>
    </div>
  )
}

export default StorageSettings
