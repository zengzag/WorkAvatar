import { useState, useEffect, useCallback } from 'react'
import { getCachedSceneDefaultModel } from '../utils/default-model'

export function useLlmSettings(employeeId: string | undefined) {
  const providerKey = employeeId ? `employeeWorkbench:selectedProviderId:${employeeId}` : 'employeeWorkbench:selectedProviderId'
  const modelKey = employeeId ? `employeeWorkbench:selectedModelId:${employeeId}` : 'employeeWorkbench:selectedModelId'
  const thinkingKey = employeeId ? `employeeWorkbench:enableThinking:${employeeId}` : 'employeeWorkbench:enableThinking'

  const [providers, setProviders] = useState<any[]>([])

  const [selectedLlmProviderId, setSelectedLlmProviderId] = useState<string>(() => {
    const stored = localStorage.getItem(providerKey)
    return stored || getCachedSceneDefaultModel('workbench')?.provider_id || ''
  })
  const [selectedLlmModelId, setSelectedLlmModelId] = useState<string>(() => {
    const stored = localStorage.getItem(modelKey)
    return stored || getCachedSceneDefaultModel('workbench')?.model_id || ''
  })
  const [enableThinking, setEnableThinking] = useState<boolean>(() => {
    const stored = localStorage.getItem(thinkingKey)
    return stored === 'true'
  })
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([])
  const [minimalMode, setMinimalMode] = useState(false)

  const handleLlmChange = useCallback((providerId: string, modelId: string) => {
    setSelectedLlmProviderId(providerId)
    setSelectedLlmModelId(modelId)
  }, [])

  useEffect(() => {
    localStorage.setItem(providerKey, selectedLlmProviderId)
  }, [selectedLlmProviderId, providerKey])
  useEffect(() => {
    localStorage.setItem(modelKey, selectedLlmModelId)
  }, [selectedLlmModelId, modelKey])
  useEffect(() => {
    localStorage.setItem(thinkingKey, String(enableThinking))
  }, [enableThinking, thinkingKey])

  const loadProviders = async () => {
    try {
      const result = await window.electronAPI.llm.getProviders()
      setProviders(result as any[])
    } catch (e) { console.error('Failed to load providers:', e) }
  }

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
