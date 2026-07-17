import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, DatePicker, Typography } from 'antd'
import dayjs from 'dayjs'

const { Text } = Typography
const { RangePicker } = DatePicker

const FILE_FORMAT_OPTIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'md', 'txt', 'csv', 'json', 'html', 'xml',
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h',
]

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  created_at: number
  updated_at: number
}

interface KMSFilterPanelProps {
  filterDirIds: string[]
  onFilterDirIdsChange: (ids: string[]) => void
  filterCollectionIds: string[]
  onFilterCollectionIdsChange: (ids: string[]) => void
  filterExtensions: string[]
  onFilterExtensionsChange: (exts: string[]) => void
  filterTimeRange: [number, number] | null
  onFilterTimeRangeChange: (value: [number, number] | null) => void
  dirs: IndexDir[]
  collectionOptions: { label: string; value: string }[]
}

const KMSFilterPanel: React.FC<KMSFilterPanelProps> = ({
  filterDirIds,
  onFilterDirIdsChange,
  filterCollectionIds,
  onFilterCollectionIdsChange,
  filterExtensions,
  onFilterExtensionsChange,
  filterTimeRange,
  onFilterTimeRangeChange,
  dirs,
  collectionOptions,
}) => {
  const { t } = useTranslation()

  const dirOptions = useMemo(() => {
    return dirs.map((d) => ({
      label: d.display_name || d.dir_path.split(/[/\\]/).pop() || d.dir_path,
      value: d.id,
    }))
  }, [dirs])

  const formatOptions = useMemo(() => {
    return FILE_FORMAT_OPTIONS.map((ext) => ({ label: ext, value: ext }))
  }, [])

  const handleTimeRangeChange = useCallback((dates: any) => {
    if (dates && dates[0] && dates[1]) {
      onFilterTimeRangeChange([
        dates[0].startOf('day').valueOf(),
        dates[1].endOf('day').valueOf(),
      ])
    } else {
      onFilterTimeRangeChange(null)
    }
  }, [onFilterTimeRangeChange])

  const timeRangeValue = useMemo(() => {
    if (!filterTimeRange) return undefined
    return [dayjs(filterTimeRange[0]), dayjs(filterTimeRange[1])] as [dayjs.Dayjs, dayjs.Dayjs]
  }, [filterTimeRange])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
          {t('kms.filterDirectory')}
        </Text>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder={t('kms.allDirs')}
          value={filterDirIds}
          onChange={onFilterDirIdsChange}
          options={dirOptions}
          maxTagCount="responsive"
        />
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
          {t('kms.filterCollection')}
        </Text>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder={t('kms.collections.noCollections')}
          value={filterCollectionIds}
          onChange={onFilterCollectionIdsChange}
          options={collectionOptions}
          maxTagCount="responsive"
          notFoundContent={t('kms.collections.noCollections')}
        />
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
          {t('kms.filterFileFormat')}
        </Text>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder={t('kms.allFormats')}
          value={filterExtensions}
          onChange={onFilterExtensionsChange}
          options={formatOptions}
          maxTagCount="responsive"
        />
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
          {t('kms.filterTimeRange')}
        </Text>
        <RangePicker
          style={{ width: '100%' }}
          value={timeRangeValue}
          onChange={handleTimeRangeChange}
        />
      </div>
    </div>
  )
}

export default KMSFilterPanel
