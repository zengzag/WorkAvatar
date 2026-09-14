import { useState, useEffect, useCallback, useRef } from 'react'
import { getCachedSceneDefaultModel } from '../utils/default-model'
import type { ThinkingLevel } from '../types'

// 模块级缓存：providers 是全局数据，不随员工切换变化，避免重复 IPC
// TTL 确保设置页修改 providers 后不会长时间使用过期缓存
let _cachedProviders: any[] | null = null
let _cachedProvidersTime = 0
const PROVIDERS_CACHE_TTL = 60000

// 设置页修改 providers 后，通知所有已挂载的 hook 实例强制刷新（无需重启应用）
type ProvidersListener = () => void
const _providersListeners = new Set<ProvidersListener>()

export function invalidateProvidersCache() {
  _cachedProviders = null
  _cachedProvidersTime = 0
  _providersListeners.forEach(l => l())
}

export function subscribeProviders(listener: ProvidersListener): () => void {
  _providersListeners.add(listener)
  return () => { _providersListeners.delete(listener) }
}

export function useLlmSettings(employeeId: string | undefined) {
  const providerKey = employeeId ? `employeeWorkbench:selectedProviderId:${employeeId}` : 'employeeWorkbench:selectedProviderId'
  const modelKey = employeeId ? `employeeWorkbench:selectedModelId:${employeeId}` : 'employeeWorkbench:selectedModelId'
  const thinkingKey = employeeId ? `employeeWorkbench:enableThinking:${employeeId}` : 'employeeWorkbench:enableThinking'

  const [providers, setProviders] = useState<any[]>(_cachedProviders || [])

  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>(() => {
    const stored = localStorage.getItem(providerKey)
    return stored || getCachedSceneDefaultModel('workbench')?.provider_id || ''
  })
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>(() => {
    const stored = localStorage.getItem(modelKey)
    return stored || getCachedSceneDefaultModel('workbench')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<ThinkingLevel>(() => {
    const stored = localStorage.getItem(thinkingKey)
    // 兼容旧版 boolean: 'true' → 'high', 'false' → false
    if (stored === 'true') return 'high'
    if (stored === 'false') return false
    if (stored === 'low' || stored === 'medium' || stored === 'high') return stored
    return false
  })
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([])
  const [minimalMode, setMinimalMode] = useState(false)

  const handleLlmChange = useCallback((providerId: string, modelId: string) => {
    setSelectedLlmProviderId(providerId)
    setSelectedLlmModelId(modelId)
  }, [])

  // 当 key 变化（如 employeeId 切换）时，从 localStorage 重新读取对应的值
  // 避免 useState 初始化只执行一次导致切换员工/重启程序后模型不恢复的问题。
  // 无条件重置：新 key 无存储且无默认值时置空，防止旧员工的模型残留并回写串扰
  useEffect(() => {
    const storedProvider = localStorage.getItem(providerKey)
    const fallback = getCachedSceneDefaultModel('workbench')
    setSelectedLlmProviderId(storedProvider || fallback?.provider_id || '')
    const storedModel = localStorage.getItem(modelKey)
    setSelectedLlmModelId(storedModel || fallback?.model_id || '')
    const storedThinking = localStorage.getItem(thinkingKey)
    if (storedThinking === 'true') setEnableThinking('high')
    else if (storedThinking === 'false') setEnableThinking(false)
    else if (storedThinking === 'low' || storedThinking === 'medium' || storedThinking === 'high') setEnableThinking(storedThinking)
    else setEnableThinking(false)
    // 恢复完成标记：持久化 effect 据此跳过 key 刚切换、state 尚未恢复的窗口期
    syncedKeysRef.current = providerKey + '|' + modelKey + '|' + thinkingKey
  }, [providerKey, modelKey, thinkingKey])

  const syncedKeysRef = useRef('')
  const currentKeys = providerKey + '|' + modelKey + '|' + thinkingKey

  useEffect(() => {
    // key 刚切换（恢复 effect 尚未把新值写入 state）时跳过持久化，
    // 否则旧员工的 provider/model 会被写入新员工的 key
    if (syncedKeysRef.current !== currentKeys) return
    localStorage.setItem(providerKey, selectedLlmProviderId)
  }, [selectedLlmProviderId, currentKeys, providerKey])
  useEffect(() => {
    if (syncedKeysRef.current !== currentKeys) return
    localStorage.setItem(modelKey, selectedLlmModelId)
  }, [selectedLlmModelId, currentKeys, modelKey])
  useEffect(() => {
    if (syncedKeysRef.current !== currentKeys) return
    localStorage.setItem(thinkingKey, String(enableThinking))
  }, [enableThinking, currentKeys, thinkingKey])

  const loadProviders = async () => {
    if (_cachedProviders && Date.now() - _cachedProvidersTime < PROVIDERS_CACHE_TTL) {
      setProviders(_cachedProviders)
      return
    }
    try {
      const result = await window.electronAPI.llm.getProviders()
      _cachedProviders = result as any[]
      _cachedProvidersTime = Date.now()
      setProviders(result as any[])
    } catch (e) { console.error('Failed to load providers:', e) }
  }

  // 设置页更新 providers 后强制刷新，保证已挂载页面无需重启即可看到新模型
  useEffect(() => {
    return subscribeProviders(() => {
      window.electronAPI.llm.getProviders().then((result: any) => {
        _cachedProviders = result as any[]
        _cachedProvidersTime = Date.now()
        setProviders(result as any[])
      }).catch(() => {})
    })
  }, [])

  return {
    providers,
    setProviders,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedCollectionIds,
    setSelectedCollectionIds,
    minimalMode,
    setMinimalMode,
    loadProviders,
  }
}
