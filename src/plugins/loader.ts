import React from 'react'
import ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as antd from 'antd'
import * as icons from '@ant-design/icons'
import * as reactI18n from 'react-i18next'
import i18n from '../i18n'
import { useNavConfigStore } from '../stores/nav.store'
import { useAppearanceStore, getEffectiveTheme } from '../stores/appearance.store'
import { registerPluginViews } from './view-slot'
import { GenericChatView } from '../components/workbench'
import type {
  PluginBridge,
  PluginRendererEntry,
  PluginRendererHost,
  PluginViewDefinition,
} from '../../plugins/plugin-sdk/src/renderer'

/** 已加载的插件渲染端描述（路由 + 导航贡献） */
export interface LoadedPlugin {
  id: string
  name: string
  nav?: {
    /** 文案或 i18n key（App 侧以 namespace=插件 id 解析，语言切换自动生效） */
    label: string
    icon?: string
    order: number
    detachable: boolean
  }
  navIcon?: React.ComponentType<{ active: boolean }>
  routes: Array<{ path: string; element: React.ReactNode }>
  /** 视图注入（宿主界面指定注入点渲染组件） */
  views?: PluginViewDefinition[]
}

/** 共享库单例注入：插件构建时 external 并 shim 到 __WA_HOST__，避免双 React */
export function injectHostGlobals(): void {
  const g = globalThis as Record<string, unknown>
  g.__WA_HOST__ = { React, ReactDOM, jsxRuntime, antd, icons, i18n, reactI18n }
}

// ====== 外部文件打开能力（系统"打开方式"传入 .md 等） ======
// 全局统一监听主进程事件，入队并通知订阅者；插件页面挂载时订阅并回放暂存队列，
// 避免"窗口未就绪/插件未挂载"时文件丢失，同时避免多次订阅重复消费。

/** 已收到但插件尚未订阅消费的外部文件路径队列 */
const externalFileQueue: string[] = []
/** 外部文件订阅者（插件页面挂载时注册，卸载时移除） */
const externalFileSubscribers = new Set<(absPath: string) => void>()
/** 全局主进程事件监听是否已注册（懒注册一次） */
let externalFileListenerReady = false

function ensureExternalFileListener(): void {
  if (externalFileListenerReady) return
  externalFileListenerReady = true
  window.electronAPI.app.onOpenExternalFile((absPath) => {
    // 先入队，保证订阅者能通过回放拿到（即使此时无订阅者）
    externalFileQueue.push(absPath)
    for (const fn of externalFileSubscribers) fn(absPath)
  })
}

/** 订阅外部文件打开事件：先回放暂存队列，再订阅实时事件；返回取消订阅函数 */
function subscribeExternalFiles(callback: (absPath: string) => void): () => void {
  ensureExternalFileListener()
  // 回放暂存队列（队列在首个订阅者处清空，避免重复消费）
  while (externalFileQueue.length > 0) {
    callback(externalFileQueue.shift()!)
  }
  externalFileSubscribers.add(callback)
  return () => { externalFileSubscribers.delete(callback) }
}

// ====== 关闭守卫能力（tab 独立窗口未保存内容确认） ======
// 插件页面注册守卫（如 notes 有脏 tab），宿主 TabWindowLayout 关闭独立窗口时查询。
// 同一渲染进程（主窗口/tab 窗口）内所有插件共享；TabWindowLayout 仅在 tab 窗口渲染。

/** 已注册的关闭守卫（返回 true = 有未保存内容，需弹确认框） */
const closeGuards = new Set<() => boolean>()

/** 注册关闭守卫，返回取消注册函数 */
function registerCloseGuard(check: () => boolean): () => void {
  closeGuards.add(check)
  return () => { closeGuards.delete(check) }
}

/** 当前渲染进程内是否有任一守卫命中（有未保存内容需要确认） */
export function hasDirtyCloseGuard(): boolean {
  for (const fn of closeGuards) {
    try {
      if (fn()) return true
    } catch { /* 忽略单个守卫异常 */ }
  }
  return false
}

/** 插件动态导航图标组件（navIcon 贡献），App 侧按插件 id 取用 */
const pluginNavIcons = new Map<string, React.ComponentType<{ active: boolean }>>()

export function getPluginNavIcon(id: string): React.ComponentType<{ active: boolean }> | undefined {
  return pluginNavIcons.get(id)
}

function createBridge(pluginId: string): PluginBridge {
  return {
    invoke: <T,>(channel: string, payload?: unknown) =>
      window.electronAPI.plugin.invoke<T>(pluginId, channel, payload),
    // 宿主 preload 回调带 { event, payload }，这里按事件名过滤后只回调本事件的 payload
    onEvent: (event, callback) =>
      window.electronAPI.plugin.onEvent(pluginId, (msg) => {
        if (msg.event === event) callback(msg.payload)
      }),
  }
}

/**
 * 启动期加载全部已启用插件的渲染端：
 * 拉清单 → 注册 locale → 动态 import plugin:// 入口 → init(host) → 收集路由与导航。
 * 单插件失败仅跳过自身（主进程已隔离激活，这里兜底渲染端异常）。
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  const { rendererPlugins } = await window.electronAPI.plugin.list()
  const loaded: LoadedPlugin[] = []

  for (const info of rendererPlugins) {
    try {
      // 宿主代为注册插件 locale（namespace = 插件 id）
      for (const [lng, resources] of Object.entries(info.locales ?? {})) {
        i18n.addResourceBundle(lng, info.id, resources as Record<string, unknown>, true, true)
      }

      const entry = (await import(/* @vite-ignore */ `plugin://${info.id}/${info.entry}`)) as {
        default: PluginRendererEntry
      }
      const def = entry.default
      if (!def || !Array.isArray(def.routes)) continue

      // 提供宿主通用能力：外部文件打开 / 关闭守卫 / 文件对话框 / 剪贴板 / 主题与语言
      const hostCapabilities: PluginRendererHost['hostCapabilities'] = {
        subscribeExternalFiles,
        registerCloseGuard,
        showOpenDialog: async (options) => {
          const res = await window.electronAPI.app.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: options?.filters ?? [],
          })
          return res?.filePaths ?? []
        },
        showSaveDialog: async (options) => {
          const res = await window.electronAPI.app.showSaveDialog(options ?? {})
          return res?.filePath ?? ''
        },
        clipboard: {
          readText: async () => {
            try { return await navigator.clipboard.readText() } catch { return '' }
          },
          writeText: async (text) => {
            try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
          },
        },
        getTheme: () => getEffectiveTheme(useAppearanceStore.getState().themeMode),
        onThemeChange: (callback) =>
          useAppearanceStore.subscribe((state) => callback(getEffectiveTheme(state.themeMode) === 'dark')),
        getLocale: () => useAppearanceStore.getState().locale,
        onLocaleChange: (callback) => {
          let prev = useAppearanceStore.getState().locale
          return useAppearanceStore.subscribe((state) => {
            if (state.locale !== prev) {
              prev = state.locale
              callback(state.locale)
            }
          })
        },
        // 通用对话视图：复用宿主任务对话 UI，插件页面可直接渲染
        GenericChatView,
      }

      const host: PluginRendererHost = {
        bridge: createBridge(info.id),
        i18n: {
          t: (key, options) => {
            // common.* 由宿主 translation 命名空间提供，其余 key 走插件 namespace
            if (key.startsWith('common.')) return i18n.t(key, { ns: 'translation', ...options })
            return i18n.t(key, { ns: info.id, ...options })
          },
        },
        hostCapabilities,
      }
      await def.init?.(host)

      if (def.navIcon) pluginNavIcons.set(info.id, def.navIcon)
      registerPluginViews(info.id, def.views)
      loaded.push({
        id: info.id,
        name: info.name,
        nav: info.nav,
        navIcon: def.navIcon,
        views: def.views,
        routes: def.routes.map(r => ({
          path: r.path === '' || r.path === '/' ? '' : r.path.replace(/^\//, ''),
          element: React.createElement(r.component as React.ComponentType<{}>),
        })),
      })
    } catch (err) {
      console.error(`[PluginLoader] 插件渲染端加载失败: ${info.id}`, err)
    }
  }

  // 插件导航项注入 nav store（App 侧与内置导航合并渲染，不持久化）
  useNavConfigStore.getState().setPlugins(
    loaded.filter(p => p.nav).map(p => ({
      key: p.id,
      label: p.nav!.label,
      icon: p.nav!.icon,
      order: p.nav!.order,
      detachable: p.nav!.detachable,
    }))
  )
  return loaded
}
