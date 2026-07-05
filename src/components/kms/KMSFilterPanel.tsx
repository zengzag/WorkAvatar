import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Radio, Select, DatePicker, Collapse, Tag, Typography, Space } from 'antd'
import { FilterOutlined, RobotOutlined } from '@ant-design/icons'
import type { SearchFilters } from '../../hooks/useKMS'

const { Text } = Typography
const { RangePicker } = DatePicker

type SearchMode = 'keyword' | 'semantic' | 'hybrid' | 'ai'

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
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
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
  searchMode,
  onSearchModeChange,
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

  const activeFilterCount = filterDirIds.length + filterCollectionIds.length + filterExtensions.length +
    (filterTimeRange ? 1 : 0) + (searchMode === 'keyword' || searchMode === 'semantic' ? 1 : 0)

  return (
    <div style={{ marginBottom: 12 }}>
      <Radio.Group
        value={searchMode === 'keyword' || searchMode === 'semantic' ? '' : searchMode}
        onChange={(e) => onSearchModeChange(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        style={{ marginBottom: 8 }}
      >
        <Radio.Button value="hybrid">{t('kms.hybridSearch')}</Radio.Button>
        <Radio.Button value="ai">
          <RobotOutlined style={{ marginRight: 4 }} />
          {t('kms.aiSearch')}
        </Radio.Button>
      </Radio.Group>

      <Collapse
        size="small"
        items={[{
          key: 'filters',
          label: (
            <Space size={4}>
              <FilterOutlined />
              <span>{t('kms.advancedFilters')}</span>
              {activeFilterCount > 0 && (
                <Tag color="blue" style={{ fontSize: 10, margin: 0, lineHeight: '16px' }}>
                  {activeFilterCount}
                </Tag>
              )}
            </Space>
          ),
          children: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                  {t('kms.searchMode')}
                </Text>
                <Select
                  style={{ width: '100%' }}
                  value={searchMode}
                  onChange={(v) => onSearchModeChange(v as SearchMode)}
                  options={[
                    { label: t('kms.hybridSearch'), value: 'hybrid' },
                    { label: t('kms.keywordSearch'), value: 'keyword' },
                    { label: t('kms.semanticSearch'), value: 'semantic' },
                    { label: t('kms.aiSearch'), value: 'ai' },
                  ]}
                />
              </div>
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
                  onChange={handleTimeRangeChange}
                />
              </div>
            </div>
          ),
        }]}
      />
    </div>
  )
}

export default KMSFilterPanel
