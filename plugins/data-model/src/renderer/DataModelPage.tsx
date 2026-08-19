// 数据模型主页面

import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Select, Modal, Input, Radio, Tooltip, Empty, Popconfirm } from 'antd'
import {
  SaveOutlined, PlusOutlined, ImportOutlined, ExportOutlined,
  ApartmentOutlined, CloseOutlined, SettingOutlined,
  DeleteOutlined, DownloadOutlined, UploadOutlined
} from '@ant-design/icons'
import { Canvas } from './canvas/Canvas'
import { TableInspector } from './inspector/TableInspector'
import { RelationshipInspector } from './inspector/RelationshipInspector'
import { FloatingChat } from './chat/FloatingChat'
import { DataModelSettingsDrawer } from './DataModelSettingsDrawer'
import { useDataModelStore } from './data-model.store'
import { dm, hostT } from './store'
import { createTable } from '../shared/domain'

export function DataModelPage() {
  const model = useDataModelStore((s) => s.model)
  const projects = useDataModelStore((s) => s.projects)
  const selectedTableId = useDataModelStore((s) => s.selectedTableId)
  const selectedRelationshipId = useDataModelStore((s) => s.selectedRelationshipId)
  const { setModel, applyRemoteModel, loadProjects, createProject, loadSample, openProject, deleteProject, saveProject, loadEmployees, loadProviders, requestLayout, addTable, loadSettings, loadDataDir, exportProjectFile, importProjectFile } = useDataModelStore.getState()
  const { message } = App.useApp()

  const [showInspector, setShowInspector] = useState(true)
  const [inspectorWidth, setInspectorWidth] = useState(280)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [importText, setImportText] = useState('')
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [exportText, setExportText] = useState('')
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // 检查器宽度拖拽调整
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizeRef.current = { startX: e.clientX, startWidth: inspectorWidth }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const delta = resizeRef.current.startX - ev.clientX
      const next = Math.min(520, Math.max(220, resizeRef.current.startWidth + delta))
      setInspectorWidth(next)
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 初始化
  useEffect(() => {
    void (async () => {
      const { model: m } = await dm.getModel()
      if (m) setModel(m)
      await loadSettings()
      await loadDataDir()
      await loadProjects()
      await loadEmployees()
      await loadProviders()
    })()
  }, [])

  // 订阅模型变更（agent 工具应用后）
  useEffect(() => {
    const unsub = dm.onModelChanged((payload) => {
      applyRemoteModel(payload.model)
    })
    return unsub
  }, [])

  // 订阅员工/模型变更（主进程广播），刷新下拉选项
  useEffect(() => {
    const unsub = dm.onMetaChanged(({ scope }) => {
      if (scope === 'employees') void loadEmployees()
      else void loadProviders()
    })
    return unsub
  }, [])

  const selectedTable = useMemo(
    () => model?.tables.find((t) => t.id === selectedTableId) ?? null,
    [model, selectedTableId]
  )
  const selectedRelationship = useMemo(
    () => model?.relationships.find((r) => r.id === selectedRelationshipId) ?? null,
    [model, selectedRelationshipId]
  )

  const handleSave = async () => {
    await saveProject()
    message.success(hostT('page.saved'))
  }

  const handleCreateProject = async () => {
    await createProject(newProjectName || undefined)
    setNewProjectOpen(false)
    setNewProjectName('')
    message.success(hostT('page.created'))
  }

  const handleAddTableFromEmpty = () => {
    const table = createTable({ name: `table_${Date.now().toString(36).slice(-4)}` })
    addTable(table)
  }

  const handleImport = async () => {
    if (!importText.trim()) return
    const res = await dm.importDbml(importText)
    if ('error' in res) {
      message.error(res.error)
      return
    }
    if (importMode === 'replace') {
      setModel(res.model)
    } else {
      // merge：通过主进程工具并入
      const cur = useDataModelStore.getState().model
      if (cur) {
        // 简单合并：追加不重名的表
        const existing = new Set(cur.tables.map((t) => t.name.toLowerCase()))
        const newTables = res.model.tables.filter((t) => !existing.has(t.name.toLowerCase()))
        const next = { ...cur, tables: [...cur.tables, ...newTables], updatedAt: Date.now() }
        setModel(next)
        void dm.syncModel(next)
      }
    }
    setImportOpen(false)
    setImportText('')
    message.success(hostT('dbml.import'))
  }

  const handleExport = async () => {
    const res = await dm.exportDbml()
    if ('error' in res) {
      message.error(res.error)
      return
    }
    setExportText(res.dbml)
    setExportOpen(true)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(exportText)
    message.success(hostT('dbml.copied'))
  }

  const handleDownload = () => {
    const blob = new Blob([exportText], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${model?.name ?? 'model'}.dbml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--dm-bg)' }}>
      {/* 工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--dm-border)' }}>
        <Select
          size="small"
          style={{ width: 180 }}
          placeholder={hostT('page.projects')}
          value={model?.id}
          onChange={(id) => void openProject(id)}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          popupRender={(menu) => (
            <>
              {menu}
              <div style={{ padding: 8, borderTop: '1px solid var(--dm-border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Button size="small" block icon={<PlusOutlined />} onClick={() => setNewProjectOpen(true)}>
                  {hostT('page.newProject')}
                </Button>
                <Button size="small" block icon={<DownloadOutlined />} onClick={() => void exportProjectFile()}>
                  {hostT('page.exportFile')}
                </Button>
                <Button size="small" block icon={<UploadOutlined />} onClick={() => void importProjectFile()}>
                  {hostT('page.importFile')}
                </Button>
                {model && (
                  <Popconfirm title={hostT('page.deleteConfirm')} onConfirm={() => void deleteProject(model.id)}>
                    <Button size="small" block danger icon={<DeleteOutlined />}>
                      {hostT('page.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </div>
            </>
          )}
        />
        <Tooltip title={hostT('page.save')}>
          <Button size="small" icon={<SaveOutlined />} onClick={handleSave} />
        </Tooltip>
        <Tooltip title={hostT('page.autoLayout')}>
          <Button size="small" icon={<ApartmentOutlined />} onClick={requestLayout} />
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<ApartmentOutlined />} onClick={loadSample}>{hostT('page.sample')}</Button>
        <Button size="small" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>{hostT('page.importDbml')}</Button>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExport}>{hostT('page.exportDbml')}</Button>
        <Tooltip title={hostT('page.settings')}>
          <Button size="small" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} />
        </Tooltip>
      </div>

      {/* 主区域 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <Canvas />
          <FloatingChat />
          {model && model.tables.length === 0 && (
            <div
              style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none'
              }}
            >
              <div style={{ fontSize: 14, color: 'var(--dm-muted)' }}>{hostT('page.empty.desc')}</div>
              <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto' }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleAddTableFromEmpty}>
                  {hostT('page.newTable')}
                </Button>
                <Button icon={<ApartmentOutlined />} onClick={loadSample}>{hostT('page.sample')}</Button>
              </div>
            </div>
          )}
        </div>

        {showInspector && (
          <div style={{ display: 'flex', minHeight: 0 }}>
            {/* 拖拽调整宽度手柄 */}
            <div
              onMouseDown={startResize}
              style={{
                width: 5, cursor: 'col-resize', flexShrink: 0,
                borderLeft: '1px solid var(--dm-border)',
                background: 'transparent', transition: 'background 0.2s'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--dm-primary-soft)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            />
            <div style={{ width: inspectorWidth, borderLeft: '1px solid var(--dm-border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--dm-border)', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{hostT('page.inspector')}</span>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setShowInspector(false)} />
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {selectedTable ? (
                  <TableInspector table={selectedTable} />
                ) : selectedRelationship ? (
                  <RelationshipInspector relationship={selectedRelationship} />
                ) : (
                  <Empty description={hostT('page.noSelection')} style={{ marginTop: 40 }} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 新建项目 */}
      <Modal
        title={hostT('page.newProject')}
        open={newProjectOpen}
        onOk={handleCreateProject}
        onCancel={() => setNewProjectOpen(false)}
        okText={hostT('page.create')}
        cancelText={hostT('page.cancel')}
      >
        <Input
          placeholder={hostT('page.projectName')}
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          onPressEnter={handleCreateProject}
        />
      </Modal>

      {/* 导入 DBML */}
      <Modal
        title={hostT('dbml.importTitle')}
        open={importOpen}
        onOk={handleImport}
        onCancel={() => setImportOpen(false)}
        okText={hostT('dbml.import')}
        cancelText={hostT('page.cancel')}
        width={560}
      >
        <Radio.Group value={importMode} onChange={(e) => setImportMode(e.target.value)} style={{ marginBottom: 8 }}>
          <Radio value="merge">{hostT('dbml.merge')}</Radio>
          <Radio value="replace">{hostT('dbml.replace')}</Radio>
        </Radio.Group>
        <Input.TextArea
          rows={10}
          placeholder={hostT('dbml.importPlaceholder')}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          style={{ fontFamily: 'var(--dm-mono)' }}
        />
      </Modal>

      {/* 导出 DBML */}
      <Modal
        title={hostT('dbml.exportTitle')}
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        footer={[
          <Button key="copy" onClick={handleCopy}>{hostT('dbml.copy')}</Button>,
          <Button key="download" type="primary" onClick={handleDownload}>{hostT('dbml.download')}</Button>
        ]}
        width={560}
      >
        <Input.TextArea
          rows={12}
          value={exportText}
          readOnly
          style={{ fontFamily: 'var(--dm-mono)' }}
        />
      </Modal>

      {/* 设置 */}
      <DataModelSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
