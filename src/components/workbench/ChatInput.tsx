import { Input, Button, theme, Dropdown, Typography, Popover, Tag, Checkbox, Tooltip } from 'antd'
import { SendOutlined, StopOutlined, ThunderboltOutlined, PaperClipOutlined, CloseOutlined, SwapOutlined, CheckOutlined, RobotOutlined, SearchOutlined, DatabaseOutlined, CompressOutlined, FileTextOutlined, UnlockOutlined, DownOutlined, BulbOutlined, BulbFilled } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useMemo, useRef, useCallback, useState, memo } from 'react'
import { getProviderModels, DOMESTIC_PROVIDERS, LOCAL_PROVIDERS } from '../../utils/llm'
import type { Employee } from '../../types'

interface AttachedFile {
  id: string
  path: string
  name: string
}

const { Text } = Typography

/** 模型选择的最大数量（对比模式上限） */
const MAX_SELECTED_MODELS = 3

export interface AttachedImage {
  id: string
  dataUrl: string
  name: string
}

export interface ModelSelection {
  providerId: string
  modelId: string
}

export interface SendOptions {
  highPermission?: boolean
}

// 已启用的 skill 简要信息，用于斜杠菜单触发
export interface AvailableSkill {
  id: string
  name: string
  description: string
  userInvocable: boolean
}

const ChatInput: React.FC<{
  onSend: (content: string, images: string[], models: ModelSelection[], options?: SendOptions) => void
  onStop: () => void
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
  value: string
  onChange: (value: string) => void
  availableSkills?: AvailableSkill[]
  centerMode?: boolean
  showEmployeeSelector?: boolean
  employees?: Employee[]
  selectedEmployeeId?: string
  onSelectEmployee?: (id: string) => void
  defaultProviderId?: string
  defaultModelId?: string
  onDefaultModelChange?: (providerId: string, modelId: string) => void
  enableThinking?: boolean
  onThinkingChange?: (enabled: boolean) => void
}> = ({ onSend, onStop, isStreaming, placeholder, providers, attachedImages, onImagesChange, selectedModels, onModelsChange, selectedCollectionIds, onSelectedCollectionIdsChange, allCollections, minimalMode, onMinimalModeChange, canToggleMinimalMode, value, onChange, availableSkills, centerMode, showEmployeeSelector, employees, selectedEmployeeId, onSelectEmployee, defaultProviderId, defaultModelId, onDefaultModelChange, enableThinking, onThinkingChange }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [highPermission, setHighPermission] = useState(false)

  // attachedImages 的 ref 镜像，用于异步回调（FileReader.onload）中读取最新值，
  // 避免闭包捕获旧快照导致用户中途新增的图片被覆盖（M1/M2 修复）
  const attachedImagesRef = useRef(attachedImages)
  attachedImagesRef.current = attachedImages

  // 可通过斜杠菜单触发的 skills：user-invocable 即可
  // skill 激活统一走 activate_skill 工具，不再依赖 skill_<name> 工具注册
  const invocableSkills = useMemo(() => {
    return (availableSkills || []).filter(s => s.userInvocable)
  }, [availableSkills])

  // 斜杠命令：已启用 skills（仅显示名称）
  // skill 命令 key 为 `/<skill-name>`，选中后填充输入框让用户继续输入参数
  const slashCommands = useMemo(() => {
    return invocableSkills.map(s => ({
      key: `/${s.name}`,
      label: `/${s.name}`,
    }))
  }, [invocableSkills])

  const currentSlashItems = useMemo(() => {
    if (!value.startsWith('/')) return []
    const lower = value.toLowerCase()
    // 精确控制：仅当输入恰好是 / 或 /xxx（无空格）时才提示命令
    const hasSpace = value.includes(' ')
    if (hasSpace) return []
    return slashCommands.filter(cmd => cmd.key.startsWith(lower))
  }, [value, slashCommands])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // skill 命令唯一匹配且无参数：填充 `/<name> ` 让用户继续输入，或直接 Enter 触发
      if (value.startsWith('/') && !value.includes(' ') && currentSlashItems.length === 1) {
        const skillName = currentSlashItems[0].key.slice(1)
        onChange(`/${skillName} `)
        return
      }
      handleSend()
    }
  }

  // 把 `/<skill-name> <args>` 转换为对 LLM 的明确工具调用指令
  // skill 激活统一通过 activate_skill 工具
  const convertSkillCommand = useCallback((raw: string): string => {
    const match = raw.match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/i)
    if (!match) return raw
    const skillName = match[1]
    const args = (match[2] || '').trim()
    // 校验该 name 是否属于已启用 skill
    const skill = invocableSkills.find(s => s.name === skillName)
    if (!skill) return raw
    if (args) {
      return `用户要求使用 ${skillName} skill 处理：\n${args}`
    }
    return `用户要求使用 ${skillName} skill 处理。`
  }, [invocableSkills])

  // 斜杠菜单选中处理：skill 命令填充 `/<name> ` 让用户继续输入参数
  const handleSlashSelect = useCallback((cmd: { key: string }) => {
    const skillName = cmd.key.slice(1)
    onChange(`/${skillName} `)
  }, [onChange])

  const handleSend = useCallback(() => {
    if (!value.trim() && attachedImages.length === 0 && attachedFiles.length === 0) return
    const imageUrls = attachedImages.map(img => img.dataUrl)
    let content = value.trim()
    // skill 斜杠命令转换
    if (content.startsWith('/') && invocableSkills.some(s => content.slice(1).startsWith(s.name))) {
      content = convertSkillCommand(content)
    }
    if (attachedFiles.length > 0) {
      const filePaths = attachedFiles.map(f => f.path).filter(Boolean).join('\n')
      if (filePaths) {
        content = content ? `${content}\n${filePaths}` : filePaths
      }
    }
    const sendHighPermission = highPermission
    onSend(content, imageUrls, selectedModels, { highPermission: sendHighPermission })
    onChange('')
    setAttachedFiles([])
    setHighPermission(false)
  }, [value, attachedImages, attachedFiles, selectedModels, highPermission, onSend, onChange, invocableSkills, convertSkillCommand])

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

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string
          // 通过 ref 读取最新 attachedImages，避免闭包捕获旧快照导致图片覆盖
          onImagesChange([...attachedImagesRef.current, {
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            dataUrl,
            name: file.name || 'pasted-image.png',
          }])
        }
        reader.readAsDataURL(file)
        return
      }
    }

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
  }, [onImagesChange])

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
          // 通过 ref 读取最新 attachedImages，避免闭包捕获旧快照导致图片覆盖
          onImagesChange([...attachedImagesRef.current, ...loadedImages])
        }
      }
      reader.onerror = () => {
        loadedCount++
        if (loadedCount === imageFiles.length && loadedImages.length > 0) {
          onImagesChange([...attachedImagesRef.current, ...loadedImages])
        }
      }
      reader.readAsDataURL(file)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [onImagesChange])

  const removeImage = useCallback((id: string) => {
    onImagesChange(attachedImages.filter(img => img.id !== id))
  }, [attachedImages, onImagesChange])

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
    } else if (selectedModels.length < MAX_SELECTED_MODELS) {
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

  const modelPickerContent = useMemo(() => (
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
        <span>{t('workbench.selectedModelCount', { count: selectedModels.length, max: MAX_SELECTED_MODELS })}</span>
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
                const disabled = !selected && selectedModels.length >= MAX_SELECTED_MODELS
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
  ), [t, token, modelSearchText, selectedModels, filteredProviderModels, isModelSelected, toggleModel])

  const collectionPickerContent = useMemo(() => (
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
  ), [t, token, selectedCollectionIds, allCollections, onSelectedCollectionIdsChange])

  const [showDefaultModelPicker, setShowDefaultModelPicker] = useState(false)
  const [defaultModelSearch, setDefaultModelSearch] = useState('')
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false)
  const [employeeSearch, setEmployeeSearch] = useState('')

  const defaultModelLabel = useMemo(() => {
    if (!defaultProviderId || !defaultModelId) return ''
    const p = providers.find((p: any) => p.id === defaultProviderId)
    if (!p) return defaultModelId
    const models = getProviderModels(p)
    const m = models.find((m: any) => m.model === defaultModelId)
    return m?.name || defaultModelId
  }, [defaultProviderId, defaultModelId, providers])

  const filteredDefaultModels = useMemo(() => {
    const search = defaultModelSearch.toLowerCase()
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
  }, [providers, defaultModelSearch])

  const defaultModelPickerContent = useMemo(() => (
    <div style={{ width: 300, maxHeight: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input
        placeholder={t('workbench.searchModel')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={defaultModelSearch}
        onChange={(e) => setDefaultModelSearch(e.target.value)}
        allowClear
        variant="borderless"
        size="small"
        style={{ background: token.colorFillQuaternary, borderRadius: 6 }}
      />
      <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {filteredDefaultModels.map(({ provider, models }) => {
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
                const selected = defaultProviderId === provider.id && defaultModelId === model.model
                return (
                  <div
                    key={`${provider.id}-${model.model}`}
                    onClick={() => {
                      onDefaultModelChange?.(provider.id, model.model)
                      setShowDefaultModelPicker(false)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 6px 4px 20px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: selected ? token.colorPrimaryBg : 'transparent',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = token.colorBgTextHover }}
                    onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? token.colorPrimaryBg : 'transparent' }}
                  >
                    {selected ? <CheckOutlined style={{ fontSize: 11, color: token.colorPrimary }} /> : <div style={{ width: 11 }} />}
                    <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.name}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
        {filteredDefaultModels.length === 0 && (
          <div style={{ padding: '16px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
            {t('workbench.noMatchingModel')}
          </div>
        )}
      </div>
    </div>
  ), [t, token, defaultModelSearch, filteredDefaultModels, defaultProviderId, defaultModelId, onDefaultModelChange])

  const selectedEmployee = useMemo(() => {
    return employees?.find(e => e.id === selectedEmployeeId)
  }, [employees, selectedEmployeeId])

  const filteredEmployees = useMemo(() => {
    if (!employeeSearch.trim()) return employees || []
    const search = employeeSearch.toLowerCase()
    return (employees || []).filter(e =>
      e.name.toLowerCase().includes(search) ||
      (e.description || '').toLowerCase().includes(search)
    )
  }, [employees, employeeSearch])

  return (
    <div style={centerMode
      ? { padding: '0 16px', flexShrink: 0, maxWidth: 680, width: '100%', margin: '0 auto' }
      : { padding: '8px 6% 12px 6%', flexShrink: 0 }
    }>
      {showEmployeeSelector && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
          <Popover
            open={employeePickerOpen}
            onOpenChange={(o) => {
              setEmployeePickerOpen(o)
              if (!o) setEmployeeSearch('')
            }}
            content={
              <div style={{ width: 186, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Input
                  placeholder={t('workbench.searchEmployee')}
                  prefix={<SearchOutlined style={{ color: token.colorTextQuaternary, fontSize: 12 }} />}
                  value={employeeSearch}
                  onChange={(e) => setEmployeeSearch(e.target.value)}
                  allowClear
                  size="small"
                  variant="borderless"
                  style={{ padding: '2px 8px', marginBottom: 2 }}
                />
                <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {filteredEmployees.length === 0 && (
                    <div style={{ padding: '24px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12 }}>
                      {employeeSearch ? t('workbench.noMatchingEmployee') : t('digitalEmployees.noEmployees')}
                    </div>
                  )}
                  {filteredEmployees.map(emp => (
                    <div
                      key={emp.id}
                      onClick={() => { onSelectEmployee?.(emp.id); setEmployeePickerOpen(false); setEmployeeSearch('') }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 10px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: emp.id === selectedEmployeeId ? token.colorPrimaryBg : 'transparent',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => { if (emp.id !== selectedEmployeeId) e.currentTarget.style.background = token.colorBgTextHover }}
                      onMouseLeave={(e) => { if (emp.id !== selectedEmployeeId) e.currentTarget.style.background = 'transparent' }}
                    >
                      <div style={{
                        width: 28, height: 28, borderRadius: 6,
                        background: `${token.colorPrimary}15`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        <RobotOutlined style={{ fontSize: 14, color: token.colorPrimary }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text strong style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.name}</Text>
                        {emp.description && (
                          <Text style={{ fontSize: 11, color: token.colorTextTertiary, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{emp.description}</Text>
                        )}
                      </div>
                      {emp.id === selectedEmployeeId && <CheckOutlined style={{ fontSize: 12, color: token.colorPrimary, flexShrink: 0 }} />}
                    </div>
                  ))}
                </div>
              </div>
            }
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            styles={{ container: { padding: 8 } }}
          >
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 16px',
              borderRadius: 20,
              background: token.colorBgContainer,
              border: `1px solid ${selectedEmployeeId ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: 5,
                background: `${token.colorPrimary}15`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <RobotOutlined style={{ fontSize: 12, color: token.colorPrimary }} />
              </div>
              <Text strong style={{ fontSize: 13 }}>
                {selectedEmployee ? selectedEmployee.name : t('tasks.selectEmployee')}
              </Text>
              <DownOutlined style={{ fontSize: 10, color: token.colorTextTertiary }} />
            </div>
          </Popover>
        </div>
      )}
      {attachedImages.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 0 6px', flexWrap: 'wrap' }}>
          {attachedImages.map(img => (
            <div key={img.id} style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', border: `1px solid ${token.colorBorderSecondary}` }}>
              <img src={img.dataUrl} alt={img.name} style={{ width: 72, height: 72, objectFit: 'cover', display: 'block' }} />
              <Button type="text" size="small" icon={<CloseOutlined style={{ fontSize: 10 }} />}
                onClick={() => removeImage(img.id)}
                style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 3, padding: 0, width: 16, height: 16, minWidth: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
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
      {value.startsWith('/') && currentSlashItems.length > 0 && (
        <div style={{ display: 'flex', gap: 4, padding: '4px 0', flexWrap: 'wrap' }}>
          {currentSlashItems.map(cmd => (
            <div key={cmd.key} onClick={() => handleSlashSelect(cmd)}
              style={{ padding: '4px 10px', borderRadius: 6, background: token.colorBgTextHover, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${token.colorBorderSecondary}`, transition: 'all 0.2s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = token.colorPrimary; e.currentTarget.style.background = token.colorPrimaryBg }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = token.colorBorderSecondary; e.currentTarget.style.background = token.colorBgTextHover }}>
              <Text strong style={{ fontSize: 12, color: token.colorPrimary }}>{cmd.label}</Text>
            </div>
          ))}
        </div>
      )}
      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'flex-end', background: token.colorBgContainer, borderRadius: 8, padding: '4px 4px 4px 12px', border: `2px solid ${isDragOver ? token.colorPrimary : token.colorBorderSecondary}`, transition: 'border-color 0.3s' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onFocusCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary }}
        onBlurCapture={(e) => { if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = token.colorBorderSecondary }}>
        {isDragOver && (
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: 8,
            background: token.colorPrimaryBg,
            border: `2px dashed ${token.colorPrimary}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 10,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <FileTextOutlined style={{ fontSize: 28, color: token.colorPrimary }} />
              <Text style={{ color: token.colorPrimary, fontWeight: 500, fontSize: 13 }}>{t('workbench.dropFileHint')}</Text>
            </div>
          </div>
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Input.TextArea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPressEnter={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            autoSize={{ minRows: centerMode ? 5 : 2, maxRows: 8 }}
            style={{ background: 'transparent', border: 'none', resize: 'none', fontSize: 13, lineHeight: 1.6, padding: '4px 0', boxShadow: 'none' }}
            className="workbench-input"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 0 2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Tooltip title={highPermission ? t('workbench.highPermissionOn') : t('workbench.highPermissionOff')}>
                <Button type="text" size="small" icon={<UnlockOutlined style={{ fontSize: 12 }} />}
                  onClick={() => setHighPermission(!highPermission)}
                  style={{
                    color: highPermission ? token.colorWarning : token.colorTextQuaternary,
                    padding: '0 2px', height: 20, minWidth: 20,
                    background: highPermission ? token.colorWarningBg : 'transparent',
                  }} />
              </Tooltip>
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
              <Tooltip title={t('workbench.selectSkillToExecute')}>
                <Dropdown menu={{ items: slashCommands.map(cmd => ({ key: cmd.key, label: <Text strong style={{ fontSize: 12 }}>{cmd.label}</Text>, onClick: () => handleSlashSelect(cmd) })) }} trigger={['click']}>
                  <Button type="text" size="small" icon={<CompressOutlined style={{ fontSize: 12 }} />}
                    style={{ color: token.colorTextQuaternary, padding: '0 2px', height: 20, minWidth: 20 }} />
                </Dropdown>
              </Tooltip>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {onDefaultModelChange && (
                <Popover
                  content={defaultModelPickerContent}
                  trigger="click"
                  placement="topRight"
                  arrow={false}
                  styles={{ container: { padding: 8 } }}
                  onOpenChange={(open) => {
                    setShowDefaultModelPicker(open)
                    if (open) setDefaultModelSearch('')
                  }}
                  open={showDefaultModelPicker}
                >
                  <Button type="text" size="small"
                    style={{ color: defaultModelLabel ? token.colorPrimary : token.colorTextQuaternary, padding: '0 6px', height: 20, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {defaultModelLabel ? (
                      <span style={{ fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{defaultModelLabel}</span>
                    ) : (
                      <RobotOutlined style={{ fontSize: 12 }} />
                    )}
                  </Button>
                </Popover>
              )}
              {onThinkingChange && (
                <Tooltip title={enableThinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
                  <Button type="text" size="small"
                    icon={enableThinking ? <BulbFilled /> : <BulbOutlined />}
                    onClick={() => onThinkingChange(!enableThinking)}
                    style={{
                      color: enableThinking ? token.colorPrimary : token.colorTextQuaternary,
                      padding: '0 2px', height: 20, minWidth: 20,
                    }} />
                </Tooltip>
              )}
            </div>
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        {isStreaming ? (
          <Button icon={<StopOutlined />} danger onClick={onStop} size="middle" />
        ) : (
          <Button icon={<SendOutlined />} type="primary" onClick={handleSend}
            disabled={!value.trim() && attachedImages.length === 0 && attachedFiles.length === 0}
            size="middle" style={{ flexShrink: 0 }} />
        )}
      </div>
    </div>
  )
}

export default memo(ChatInput)
