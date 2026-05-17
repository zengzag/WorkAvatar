import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Space,
  Modal,
  Form,
  Select,
  Progress,
  Alert,
  Typography,
  App,
} from 'antd'
import {
  ExportOutlined,
  ImportOutlined,
  FileZipOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons'

const { Text } = Typography

interface ExportImportSectionProps {
  employeeId: string
  employeeName: string
}

const ExportImportSection: React.FC<ExportImportSectionProps> = ({
  employeeId,
  employeeName,
}) => {
  const { t } = useTranslation()
  const { modal } = App.useApp()
  const [importConfigModalOpen, setImportConfigModalOpen] = useState(false)
  const [importPackageModalOpen, setImportPackageModalOpen] = useState(false)

  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, stage: '', detail: '' })
  const [importForm] = Form.useForm()

  const handleExportConfig = async () => {
    try {
      const result = await window.electronAPI.app.showSaveDialog({
        title: t('employeeExport.selectExportPath'),
        defaultPath: `${employeeName}-config.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return

      setExporting(true)
      setProgress({ percent: 30, stage: 'exporting', detail: t('employeeExport.exportingConfig') })

      const exportResult = await window.electronAPI.employee.exportConfig({
        employee_id: employeeId,
        export_path: result.filePath,
      })

      setProgress({ percent: 100, stage: 'complete', detail: '' })

      if (exportResult.success) {
        modal.success({
          title: t('employeeExport.exportSuccess'),
          content: t('employeeExport.exportConfigSuccessDesc', { path: result.filePath }),
        })
      } else {
        modal.error({
          title: t('employeeExport.exportFailed'),
          content: exportResult.error,
        })
      }
    } catch (error: any) {
      modal.error({
        title: t('employeeExport.exportFailed'),
        content: error.message || t('common.failed'),
      })
    } finally {
      setExporting(false)
      setProgress({ percent: 0, stage: '', detail: '' })
    }
  }

  const handleImportConfig = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('employeeExport.selectImportFile'),
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths.length) return

      const conflictStrategy = importForm.getFieldValue('conflict_strategy') || 'merge'

      setImporting(true)
      setProgress({ percent: 30, stage: 'importing', detail: t('employeeExport.importingConfig') })

      const importResult = await window.electronAPI.employee.importConfig({
        import_path: result.filePaths[0],
        conflict_strategy: conflictStrategy,
      })

      setProgress({ percent: 100, stage: 'complete', detail: '' })

      if (importResult.success) {
        const warnings = importResult.warnings || []
        modal.success({
          title: t('employeeExport.importSuccess'),
          content: (
            <div>
              <p>{t('employeeExport.importConfigSuccessDesc')}</p>
              {warnings.length > 0 && (
                <div>
                  <Text type="warning">{t('employeeExport.warnings')}:</Text>
                  <ul>
                    {warnings.map((w: string, i: number) => (
                      <li key={i}><Text type="secondary">{w}</Text></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ),
        })
      } else {
        modal.error({
          title: t('employeeExport.importFailed'),
          content: importResult.error,
        })
      }
    } catch (error: any) {
      modal.error({
        title: t('employeeExport.importFailed'),
        content: error.message || t('common.failed'),
      })
    } finally {
      setImporting(false)
      setProgress({ percent: 0, stage: '', detail: '' })
    }
  }

  const handleExportPackage = async () => {
    try {
      const result = await window.electronAPI.app.showSaveDialog({
        title: t('employeeExport.selectExportPath'),
        defaultPath: `${employeeName}.avatar`,
        filters: [{ name: 'Avatar Package', extensions: ['avatar'] }],
      })
      if (result.canceled || !result.filePath) return

      setExporting(true)
      setProgress({ percent: 10, stage: 'preparing', detail: t('employeeExport.preparingPackage') })

      const cleanup = window.electronAPI.employee.onExportProgress((data) => {
        const stageMap: Record<string, number> = {
          preparing: 10,
          adding_config: 30,
          adding_skills: 50,
          adding_knowledge: 70,
          generating_checksum: 90,
          saving: 95,
          complete: 100,
        }
        setProgress({
          percent: stageMap[data.stage] || 50,
          stage: data.stage,
          detail: data.detail,
        })
      })

      try {
        const exportResult = await window.electronAPI.employee.exportPackage({
          employee_id: employeeId,
          export_path: result.filePath,
        })

        if (exportResult.success) {
          modal.success({
            title: t('employeeExport.exportSuccess'),
            content: t('employeeExport.exportPackageSuccessDesc', { path: result.filePath }),
          })
        } else {
          modal.error({
            title: t('employeeExport.exportFailed'),
            content: exportResult.error,
          })
        }
      } finally {
        cleanup()
      }
    } catch (error: any) {
      modal.error({
        title: t('employeeExport.exportFailed'),
        content: error.message || t('common.failed'),
      })
    } finally {
      setExporting(false)
      setProgress({ percent: 0, stage: '', detail: '' })
    }
  }

  const handleImportPackage = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('employeeExport.selectImportFile'),
        properties: ['openFile'],
        filters: [{ name: 'Avatar Package', extensions: ['avatar'] }],
      })
      if (result.canceled || !result.filePaths.length) return

      const conflictStrategy = importForm.getFieldValue('conflict_strategy') || 'merge'

      setImporting(true)
      setProgress({ percent: 10, stage: 'reading', detail: t('employeeExport.readingPackage') })

      const cleanup = window.electronAPI.employee.onImportProgress((data) => {
        const stageMap: Record<string, number> = {
          reading: 10,
          importing_config: 30,
          importing_skills: 50,
          importing_knowledge: 70,
          complete: 100,
        }
        setProgress({
          percent: stageMap[data.stage] || 50,
          stage: data.stage,
          detail: data.detail,
        })
      })

      try {
        const importResult = await window.electronAPI.employee.importPackage({
          import_path: result.filePaths[0],
          conflict_strategy: conflictStrategy,
        })

        if (importResult.success) {
          const warnings = importResult.warnings || []
          modal.success({
            title: t('employeeExport.importSuccess'),
            content: (
              <div>
                <p>{t('employeeExport.importPackageSuccessDesc')}</p>
                {warnings.length > 0 && (
                  <div>
                    <Text type="warning">{t('employeeExport.warnings')}:</Text>
                    <ul>
                      {warnings.map((w: string, i: number) => (
                        <li key={i}><Text type="secondary">{w}</Text></li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ),
          })
        } else {
          modal.error({
            title: t('employeeExport.importFailed'),
            content: importResult.error,
          })
        }
      } finally {
        cleanup()
      }
    } catch (error: any) {
      modal.error({
        title: t('employeeExport.importFailed'),
        content: error.message || t('common.failed'),
      })
    } finally {
      setImporting(false)
      setProgress({ percent: 0, stage: '', detail: '' })
    }
  }

  const conflictOptions = [
    { value: 'merge', label: t('employeeExport.conflictMerge') },
    { value: 'skip', label: t('employeeExport.conflictSkip') },
    { value: 'overwrite', label: t('employeeExport.conflictOverwrite') },
  ]

  return (
    <div>
      <Card
        title={t('employeeExport.configExportTitle')}
        style={{ marginBottom: 16 }}
      >
        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          title={t('employeeExport.configExportDesc')}
          style={{ marginBottom: 16 }}
        />
        <Space>
          <Button
            icon={<ExportOutlined />}
            onClick={handleExportConfig}
            loading={exporting}
          >
            {t('employeeExport.exportConfig')}
          </Button>
          <Button
            icon={<ImportOutlined />}
            onClick={() => setImportConfigModalOpen(true)}
          >
            {t('employeeExport.importConfig')}
          </Button>
        </Space>
      </Card>

      <Card
        title={t('employeeExport.packageExportTitle')}
      >
        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          title={t('employeeExport.packageExportDesc')}
          style={{ marginBottom: 16 }}
        />
        <Space>
          <Button
            icon={<FileZipOutlined />}
            onClick={handleExportPackage}
            loading={exporting}
          >
            {t('employeeExport.exportPackage')}
          </Button>
          <Button
            icon={<ImportOutlined />}
            onClick={() => setImportPackageModalOpen(true)}
          >
            {t('employeeExport.importPackage')}
          </Button>
        </Space>
      </Card>

      {(exporting || importing) && progress.percent > 0 && (
        <Card style={{ marginTop: 16 }}>
          <Progress percent={progress.percent} status="active" />
          {progress.detail && (
            <Text type="secondary" style={{ fontSize: 12 }}>{progress.detail}</Text>
          )}
        </Card>
      )}

      <Modal
        title={t('employeeExport.importConfigTitle')}
        open={importConfigModalOpen}
        onCancel={() => setImportConfigModalOpen(false)}
        onOk={() => {
          setImportConfigModalOpen(false)
          handleImportConfig()
        }}
        okText={t('employeeExport.startImport')}
      >
        <Form form={importForm} layout="vertical" initialValues={{ conflict_strategy: 'merge' }}>
          <Form.Item
            name="conflict_strategy"
            label={t('employeeExport.conflictStrategyLabel')}
            extra={t('employeeExport.conflictStrategyDesc')}
          >
            <Select options={conflictOptions} />
          </Form.Item>
        </Form>
        <Alert
          type="warning"
          title={t('employeeExport.importConfigWarning')}
          style={{ marginTop: 8 }}
        />
      </Modal>

      <Modal
        title={t('employeeExport.importPackageTitle')}
        open={importPackageModalOpen}
        onCancel={() => setImportPackageModalOpen(false)}
        onOk={() => {
          setImportPackageModalOpen(false)
          handleImportPackage()
        }}
        okText={t('employeeExport.startImport')}
      >
        <Form form={importForm} layout="vertical" initialValues={{ conflict_strategy: 'merge' }}>
          <Form.Item
            name="conflict_strategy"
            label={t('employeeExport.conflictStrategyLabel')}
            extra={t('employeeExport.conflictStrategyDesc')}
          >
            <Select options={conflictOptions} />
          </Form.Item>
        </Form>
        <Alert
          type="warning"
          title={t('employeeExport.importPackageWarning')}
          style={{ marginTop: 8 }}
        />
      </Modal>
    </div>
  )
}

export default ExportImportSection
