import { Input, Button, theme, Dropdown, Typography, Popover, Tag, Checkbox, Tooltip } from 'antd'
import { SendOutlined, StopOutlined, ThunderboltOutlined, PaperClipOutlined, CloseOutlined, SwapOutlined, CheckOutlined, RobotOutlined, SearchOutlined, DatabaseOutlined, CompressOutlined, FileTextOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useMemo, useRef, useCallback, useState } from 'react'
import { getProviderModels, DOMESTIC_PROVIDERS, LOCAL_PROVIDERS } from '../../utils/llm'

interface AttachedFile {
  id: string
  path: string
  name: string
}

const { Text } = Typography

export interface AttachedImage {
  id: string
  dataUrl: string
  name: string
}

export interface ModelSelection {
  providerId: string
  modelId: string
}

const ChatInput: React.FC<{
  onSend: (content: string, images: string[], models: ModelSelection[]) => void
  onStop: () => void
  onCommand: (command: string) => void
  isStreaming: boolean
  placeholder: string
  providers: any[]
  attachedImages: AttachedImage[]
  onImagesChange: (images: AttachedImage[]) => void
  selectedModels: ModelSelection[]
  onModelsChange: (models: ModelSelection[]) => void
  selectedCollectionIds: string[]
  onSelectedCollectionIdsChange: (ids: string[]) => void
  allCollections: any[]
  minimalMode: boolean
  onMinimalModeChange: (enabled: boolean) => void
  canToggleMinimalMode: boolean
}> = ({ onSend, onStop, onCommand, isStreaming, placeholder, providers, attachedImages, onImagesChange, selectedModels, onModelsChange, selectedCollectionIds, onSelectedCollectionIdsChange, allCollections, minimalMode, onMinimalModeChange, canToggleMinimalMode }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [localValue, setLocalValue] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const slashCommands = useMemo(() => [
    { key: '/clear', label: '/clear', description: t('workbench.cmdClear') },
    { key: '/new', label: '/new', description: t('workbench.cmdNew') },
  ], [t])

  const currentSlashItems = useMemo(() => {
    if (!localValue.startsWith('/')) return []
    return slashCommands.filter(cmd => cmd.key.startsWith(localValue.toLowerCase()))
  }, [localValue, slashCommands])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (localValue.startsWith('/') && currentSlashItems.length === 1) {
        onCommand(currentSlashItems[0].key)
        setLocalValue('')
        return
      }
      handleSend()
    }
  }

  const handleSend = useCallback(() => {
    if (!localValue.trim() && attachedImages.length === 0 && attachedFiles.length === 0) return
    const imageUrls = attachedImages.map(img => img.dataUrl)
    let content = localValue.trim()
    if (attachedFiles.length > 0) {
      const filePaths = attachedFiles.map(f => f.path).filter(Boolean).join('\n')
      if (filePaths) {
        content = content ? `${content}\n${filePaths}` : filePaths
      }
    }
    onSend(content, imageUrls, selectedModels)
    setLocalValue('')
    setAttachedFiles([])
  }, [localValue, attachedImages, attachedFiles, selectedModels, onSend])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current++
    setIsDragOver(true)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current--
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    const newFiles: AttachedFile[] = dropped.map(f => ({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      path: window.electronAPI?.getPathForFile?.(f) || (f as any).path || f.name,
      name: f.name,
    }))
    if (newFiles.length > 0) {
      setAttachedFiles(prev => [...prev, ...newFiles])
    }
  }, [])

  const removeFile = useCallback((id: string) => {
    setAttachedFiles(prev => prev.filter(f => f.id !== id))
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    // 优先处理图片粘贴
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string
          onImagesChange([...attachedImages, {
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            dataUrl,
            name: file.name || 'pasted-image.png',
          }])
        }
        reader.readAsDataURL(file)
        return
      }
    }

    // 处理文件粘贴（如从文件管理器复制的文件）
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      e.preventDefault()
      const pasted = Array.from(files)
      const newFiles: AttachedFile[] = pasted
        .filter(f => !f.type.startsWith('image/')) // 图片已在上面处理
        .map(f => ({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          path: window.electronAPI?.getPathForFile?.(f) || (f as any).path || f.name,
          name: f.name,
        }))
      if (newFiles.length > 0) {
        setAttachedFiles(prev => [...prev, ...newFiles])
      }
    }
  }, [attachedImages, onImagesChange])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const loadedImages: AttachedImage[] = []
    let loadedCount = 0

    for (const file of imageFiles) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string
        loadedImages.push({
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          dataUrl,
          name: file.name,
        })
        loadedCount++
        if (loadedCount === imageFiles.length) {
          onImagesChange([...attachedImages, ...loadedImages])
        }
      }
      reader.onerror = () => {
        loadedCount++
        if (loadedCount === imageFiles.length && loadedImages.length > 0) {
          onImagesChange([...attachedImages, ...loadedImages])
        }
      }
      reader.readAsDataURL(file)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [attachedImages, onImagesChange])

  const removeImage = useCallback((id: string) => {
    onImagesChange(attachedImages.filter(img => img.id !== id))
  }, [attachedImages, onImagesChange])

  const charCount = localValue.length

  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelSearchText, setModelSearchText] = useState('')
  const [showKbPicker, setShowKbPicker] = useState(false)

  const modelTags = useMemo(() => selectedModels.map((sel, i) => {
    const p = providers.find((p: any) => p.id === sel.providerId)
    const models = p ? getProviderModels(p) : []
    const m = models.find((m: any) => m.model === sel.modelId)
    const label = m?.name || sel.modelId
    return { key: i, label, providerName: p?.name || '' }
  }), [selectedModels, providers])

  const isModelSelected = useCallback((providerId: string, modelId: string) => {
    return selectedModels.some(s => s.providerId === providerId && s.modelId === modelId)
  }, [selectedModels])

  const toggleModel = useCallback((providerId: string, modelId: string) => {
    if (isModelSelected(providerId, modelId)) {
      onModelsChange(selectedModels.filter(s => !(s.providerId === providerId && s.modelId === modelId)))
    } else if (selectedModels.length < 3) {
      onModelsChange([...selectedModels, { providerId, modelId }])
    }
  }, [selectedModels, onModelsChange, isModelSelected])

  const filteredProviderModels = useMemo(() => {
    const search = modelSearchText.toLowerCase()
    return providers.map((provider: any) => {
      const models = getProviderModels(provider).filter(m => (m.category || 'chat') === 'chat')
      const filtered = search
        ? models.filter(m =>
            m.name.toLowerCase().includes(search) ||
            m.model.toLowerCase().includes(search) ||
            provider.name.toLowerCase().includes(search)
          )
        : models
      return { provider, models: filtered }
    }).filter(group => group.models.length > 0)
  }, [providers, modelSearchText])

  const modelPickerContent = (
    <div style={{ width: 320, maxHeight: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input
        placeholder={t('workbench.searchModel')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={modelSearchText}
        onChange={(e) => setModelSearchText(e.target.value)}
        allowClear
        variant="borderless"
        size="small"
        style={{ background: token.colorFillQuaternary, borderRadius: 6 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: token.colorTextTertiary }}>
        <span>{t('workbench.selectedModelCount', { count: selectedModels.length, max: 3 })}</span>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filteredProviderModels.map(({ provider, models }) => {
          const isDomestic = DOMESTIC_PROVIDERS.has(provider.provider_type)
          const isLocal = LOCAL_PROVIDERS.has(provider.provider_type)
          return (
            <div key={provider.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', fontSize: 11, fontWeight: 600, color: token.colorTextSecondary }}>
                <RobotOutlined style={{ fontSize: 11 }} />
                <span>{provider.name}</span>
                {isDomestic && <Tag color="red" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.domestic')}</Tag>}
                {isLocal && <Tag color="green" style={{ fontSize: 8, lineHeight: '12px', padding: '0 2px', margin: 0 }}>{t('llmSelector.local')}</Tag>}
              </div>
              {models.map((model) => {
                const selected = isModelSelected(provider.id, model.model)
                const disabled = !selected && selectedModels.length >= 3
                return (
                  <div
                    key={`${provider.id}-${model.model}`}
                    onClick={() => { if (!disabled) toggleModel(provider.id, model.model) }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 6px 4px 20px',
                      borderRadius: 4,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.4 : 1,
                      background: selected ? token.colorPrimaryBg : 'transparent',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!disabled && !selected) e.currentTarget.style.background = token.colorBgTextHover }}
                    onMouseLeave={(e) => { if (!disabled && !selected) e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
                  >
                    <Checkbox checked={selected} style={{ pointerEvents: 'none' }} />
                    <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.name}</span>
                    {selected && <CheckOutlined style={{ fontSize: 11, color: token.colorPrimary }} />}
                  </div>
                )
              })}
            </div>
          )
        })}
        {filteredProviderModels.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('workbench.noMatchingModel')}
          </div>
        )}
      </div>
    </div>
  )

  const collectionPickerContent = (
    <div style={{ width: 280, maxHeight: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: token.colorTextTertiary }}>
        <span>{t('workbench.selectedKbCount', { count: selectedCollectionIds.length })}</span>
        {allCollections.length > 0 && (
          <>
            <Button type="link" size="small" style={{ fontSize: 11, padding: 0, height: 'auto' }}
              onClick={() => onSelectedCollectionIdsChange(allCollections.map((c: any) => c.id))}>
              {t('common.selectAll')}
            </Button>
            <Button type="link" size="small" style={{ fontSize: 11, padding: 0, height: 'auto' }}
              onClick={() => onSelectedCollectionIdsChange([])}>
              {t('common.clearAll')}
            </Button>
          </>
        )}
      </div>
      <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {allCollections.map((c: any) => {
          const selected = selectedCollectionIds.includes(c.id)
          return (
            <div
              key={c.id}
              onClick={() => {
                if (selected) {
                  onSelectedCollectionIdsChange(selectedCollectionIds.filter((id: string) => id !== c.id))
                } else {
                  onSelectedCollectionIdsChange([...selectedCollectionIds, c.id])
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background: selected ? token.colorPrimaryBg : 'transparent',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = token.colorBgTextHover }}
              onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
            >
              <Checkbox checked={selected} style={{ pointerEvents: 'none' }} />
              <DatabaseOutlined style={{ fontSize: 12, color: token.colorPrimary }} />
              <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              {selected && <CheckOutlined style={{ fontSize: 11, color: token.colorPrimary }} />}
            </div>
          )
        })}
        {allCollections.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('creationWizard.noKbAvailable')}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div style={{ padding: '12px 4% 20px 4%', flexShrink: 0 }}>
      {attachedImages.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '4px 0 8px', flexWrap: 'wrap' }}>
          {attachedImages.map(img => (
            <div key={img.id} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: `1px solid ${token.colorBorderSecondary}` }}>
              <img src={img.dataUrl} alt={img.name} style={{ width: 80, height: 80, objectFit: 'cover', display: 'block' }} />
              <Button type="text" size="small" icon={<CloseOutlined style={{ fontSize: 10 }} />}
                onClick={() => removeImage(img.id)}
                style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 4, padding: 0, width: 18, height: 18, minWidth: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
            </div>
          ))}
        </div>
      )}
      {attachedFiles.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '4px 0 8px', flexWrap: 'wrap' }}>
          {attachedFiles.map(f => (
            <Tooltip title={f.path} key={f.id} mouseEnterDelay={0.4}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px',
                borderRadius: 8,
                background: token.colorFillQuaternary,
                border: `1px solid ${token.colorBorderSecondary}`,
                fontSize: 12,
                color: token.colorTextSecondary,
                maxWidth: 360,
              }}>
                <FileTextOutlined style={{ fontSize: 14, color: token.colorPrimary, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <CloseOutlined style={{ fontSize: 10, cursor: 'pointer', color: token.colorTextTertiary, flexShrink: 0 }} onClick={() => removeFile(f.id)} />
              </div>
            </Tooltip>
          ))}
        </div>
      )}
      {modelTags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 0 8px', flexWrap: 'wrap' }}>
          {modelTags.map(tag => (
            <div key={tag.key} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: token.colorPrimaryBg, border: `1px solid ${token.colorPrimaryBorder}`, fontSize: 12, color: token.colorPrimary }}>
              <span>@</span>
              <span>{tag.providerName} / {tag.label}</span>
              <CloseOutlined style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onModelsChange(selectedModels.filter((_, i) => i !== tag.key))} />
            </div>
          ))}
        </div>
      )}
      {selectedCollectionIds.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 0 8px', flexWrap: 'wrap' }}>
          {selectedCollectionIds.map(colId => {
            const col = allCollections.find((c: any) => c.id === colId)
            if (!col) return null
            return (
              <div key={colId} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: `${token.colorSuccessBg}`, border: `1px solid ${token.colorSuccessBorder}`, fontSize: 12, color: token.colorSuccess }}>
                <DatabaseOutlined style={{ fontSize: 10 }} />
                <span>{col.name}</span>
                <CloseOutlined style={{ fontSize: 10, cursor: 'pointer' }} onClick={() => onSelectedCollectionIdsChange(selectedCollectionIds.filter((id: string) => id !== colId))} />
              </div>
            )
          })}
        </div>
      )}
      {localValue.startsWith('/') && currentSlashItems.length > 0 && (
        <div style={{ display: 'flex', gap: 4, padding: '4px 0', flexWrap: 'wrap' }}>
          {currentSlashItems.map(cmd => (
            <div key={cmd.key} onClick={() => onCommand(cmd.key)}
              style={{ padding: '4px 10px', borderRadius: 6, background: token.colorBgTextHover, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${token.colorBorderSecondary}`, transition: 'all 0.2s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = token.colorPrimary; e.currentTarget.style.background = token.colorPrimaryBg }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = token.colorBorderSecondary; e.currentTarget.style.background = token.colorBgTextHover }}>
              <Text strong style={{ fontSize: 12, color: token.colorPrimary }}>{cmd.label}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>{cmd.description}</Text>
            </div>
          ))}
        </div>
      )}
      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'flex-end', background: token.colorBgLayout, borderRadius: 16, padding: '6px 6px 6px 16px', border: `2px solid ${isDragOver ? token.colorPrimary : 'transparent'}`, transition: 'border-color 0.3s' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onFocusCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary }}
        onBlurCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}>
        {isDragOver && (
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: 16,
            background: token.colorPrimaryBg,
            border: `2px dashed ${token.colorPrimary}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 10,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <FileTextOutlined style={{ fontSize: 32, color: token.colorPrimary }} />
              <Text style={{ color: token.colorPrimary, fontWeight: 500 }}>{t('workbench.dropFileHint')}</Text>
            </div>
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Input.TextArea
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onPressEnter={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            autoSize={{ minRows: 1, maxRows: 5 }}
            style={{ background: 'transparent', border: 'none', resize: 'none', fontSize: 14, lineHeight: 1.6, padding: '4px 0', boxShadow: 'none' }}
            className="workbench-input"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button type="text" size="small" icon={<PaperClipOutlined style={{ fontSize: 12 }} />}
                onClick={() => fileInputRef.current?.click()}
                style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }}
                title={t('workbench.attachImage')} />
              <Popover
                content={modelPickerContent}
                trigger="click"
                placement="topLeft"
                arrow={false}
                styles={{ container: { padding: 8 } }}
                onOpenChange={(open) => {
                  setShowModelPicker(open)
                  if (open) setModelSearchText('')
                }}
                open={showModelPicker}
              >
                <Button type="text" size="small" icon={<SwapOutlined style={{ fontSize: 12 }} />}
                  style={{ color: selectedModels.length > 0 ? token.colorPrimary : token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }}
                  title={t('workbench.compareModels')} />
              </Popover>
              <Popover
                content={collectionPickerContent}
                trigger="click"
                placement="topLeft"
                arrow={false}
                styles={{ container: { padding: 8 } }}
                onOpenChange={setShowKbPicker}
                open={showKbPicker}
              >
                <Button type="text" size="small" icon={<DatabaseOutlined style={{ fontSize: 12 }} />}
                  style={{ color: selectedCollectionIds.length > 0 ? token.colorPrimary : token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }}
                  title={t('workbench.knowledgeBase')} />
              </Popover>
              <Tooltip title={canToggleMinimalMode ? t('workbench.minimalModeTooltip') : t('workbench.minimalModeDisabledTooltip')}>
                <Button type="text" size="small" icon={<ThunderboltOutlined style={{ fontSize: 12 }} />}
                  onClick={() => { if (canToggleMinimalMode) onMinimalModeChange(!minimalMode) }}
                  style={{ color: minimalMode ? token.colorPrimary : token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20, opacity: canToggleMinimalMode ? 1 : 0.4, cursor: canToggleMinimalMode ? 'pointer' : 'not-allowed' }} />
              </Tooltip>
              <Dropdown menu={{ items: slashCommands.map(cmd => ({ key: cmd.key, label: <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Text strong style={{ fontSize: 12 }}>{cmd.label}</Text><Text type="secondary" style={{ fontSize: 11 }}>{cmd.description}</Text></div>, onClick: () => { onCommand(cmd.key); setLocalValue('') } })) }} trigger={['click']}>
                <Button type="text" size="small" icon={<CompressOutlined style={{ fontSize: 12 }} />}
                  style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }} />
              </Dropdown>
            </div>
            {charCount > 0 && (
              <Text style={{ fontSize: 11, color: token.colorTextQuaternary }}>{charCount}</Text>
            )}
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        {isStreaming ? (
          <Button icon={<StopOutlined />} danger onClick={onStop} shape="circle" size="middle" />
        ) : (
          <Button icon={<SendOutlined />} type="primary" onClick={handleSend}
            disabled={!localValue.trim() && attachedImages.length === 0 && attachedFiles.length === 0}
            shape="circle" size="middle" style={{ flexShrink: 0 }} />
        )}
      </div>
    </div>
  )
}

export default ChatInput
