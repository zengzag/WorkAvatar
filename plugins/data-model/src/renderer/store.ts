// 渲染端桥接封装：bridge + i18n + IPC 通道

import { useState, useEffect } from 'react'
import type { PluginBridge, PluginHostCapabilities } from '../../../plugin-sdk/src/renderer'
import type { DataModel } from '../shared/domain'

let bridge: PluginBridge | null = null
let hostI18n: ((key: string, options?: Record<string, unknown>) => string) | null = null
let hostCaps: PluginHostCapabilities | null = null

export function setBridge(b: PluginBridge): void { bridge = b }
export function setHostI18n(t: (key: string, options?: Record<string, unknown>) => string): void { hostI18n = t }
export function setHostCapabilities(c: PluginHostCapabilities | undefined): void { hostCaps = c ?? null }

export function getHostCapabilities(): PluginHostCapabilities | null {
  return hostCaps
}

export function hostT(key: string, options?: Record<string, unknown>): string {
  if (hostI18n) return hostI18n(key, options)
  return key
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('插件桥未就绪'))
  return bridge.invoke<T>(channel, payload)
}

export function onEvent(event: string, callback: (payload: unknown) => void): () => void {
  if (!bridge) return () => {}
  return bridge.onEvent(event, callback)
}

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

export function useAppearance(): { isDark: boolean } {
  const [isDark, setIsDark] = useState(() => isDarkTheme())
  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(isDarkTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-locale'] })
    return () => observer.disconnect()
  }, [])
  return { isDark }
}

// ====== IPC 通道封装 ======

export interface ProjectRecord {
  id: string
  name: string
  model: DataModel
  updatedAt: number
}

export const dm = {
  listProjects: () => invoke<ProjectRecord[]>('project-list'),
  createProject: (name?: string) => invoke<{ model: DataModel } | { error: string }>('project-create', { name }),
  openProject: (id: string) => invoke<{ model: DataModel } | { error: string }>('project-open', { id }),
  deleteProject: (id: string) => invoke<{ ok: boolean } | { error: string }>('project-delete', { id }),
  saveProject: () => invoke<{ ok: boolean } | { error: string }>('project-save'),
  getModel: () => invoke<{ model: DataModel | null }>('model-get'),
  syncModel: (model: DataModel) => invoke<{ ok: boolean } | { error: string }>('model-sync', { model }),
  importDbml: (dbml: string, name?: string) => invoke<{ model: DataModel } | { error: string }>('dbml-import', { dbml, name }),
  exportDbml: () => invoke<{ dbml: string } | { error: string }>('dbml-export'),
  listProviders: () => invoke<any[]>('providers-list'),
  sendChat: (payload: { providerId: string; modelId?: string; messages: Array<{ role: string; content: string; images?: string[] }>; conversationId?: string }) =>
    invoke<{ conversationId: string } | { error: string }>('chat-send', payload),
  cancelChat: () => invoke<{ ok: boolean }>('chat-cancel'),
  chatHistory: (conversationId: string) => invoke<any[]>('chat-history', { conversationId }),
  listChats: () => invoke<Array<{ conversationId: string; title: string; updatedAt: number }>>('chats-list'),
  deleteChat: (conversationId: string) => invoke<{ ok: boolean } | { error: string }>('chat-delete', { conversationId }),
  onChatsChanged: (cb: () => void) => onEvent('chats-changed', () => cb()),
  onMetaChanged: (cb: (payload: { scope: 'employees' | 'providers' }) => void) =>
    onEvent('meta-changed', (p) => cb(p as any)),
  onModelChanged: (cb: (payload: { model: DataModel; filePath?: string | null }) => void) =>
    onEvent('model-changed', (p) => cb(p as any)),
  onChatEvent: (cb: (payload: any) => void) => onEvent('chat-event', (p) => cb(p)),
  // 设置
  getSettings: () => invoke<{ settings: any }>('settings-get'),
  setSettings: (settings: any) => invoke<{ ok: boolean }>('settings-set', { settings }),
  getDataDir: () => invoke<{ dataDir: string }>('data-dir'),
  openDataDir: () => invoke<{ ok: boolean }>('data-dir-open'),
  // 项目导出/导入（文件）
  exportProjectFile: (model: DataModel) => invoke<{ ok: boolean; path?: string; error?: string }>('project-export-file', { model }),
  importProjectFile: () => invoke<{ model?: DataModel; error?: string }>('project-import-file')
}
