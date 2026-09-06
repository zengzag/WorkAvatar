import React from 'react'
import ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as antd from 'antd'
import * as icons from '@ant-design/icons'
import * as reactI18n from 'react-i18next'
import i18n from '../i18n'
import { useNavConfigStore } from '../stores/nav.store'
import { useAppearanceStore, getEffectiveTheme } from '../stores/appearance.store'
import { registerPluginViews, unregisterPluginViews } from './view-slot'
import { GenericChatView } from '../components/workbench'
import type {
  PluginBridge,
  PluginRendererEntry,
  PluginRendererHost,
  PluginViewDefinition,
} from '../../plugin-sdk/src/renderer'
import type { PluginRendererInfo } from '../../electron/shared/channels/plugin'

/** 已加载的插件渲染端描述（路由 + 导航贡献） */
export interface LoadedPlugin {
  id: string
  name: string
  /** 插件版本（增量同步时识别覆盖升级；也作为动态 import 的 cache-bust 参数） */
  version: string
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
  /** 注册的语言列表（卸载时逐个 removeResourceBundle） */
  localeLngs: string[]
  /** 渲染端入口 dispose（卸载/覆盖升级时调用，清理插件侧订阅） */
  dispose?: () => void
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

/** 已加载的插件渲染端（pluginId → LoadedPlugin），增量同步/卸载/查询的统一来源 */
const loadedPlugins = new Map<string, LoadedPlugin>()

export function getPluginNavIcon(id: string): React.ComponentType<{ active: boolean }> | undefined {
  return pluginNavIcons.get(id)
}

/** 查询已加载的单个插件（PluginRouteHost 动态分发路由时使用） */
export function getLoadedPlugin(id: string): LoadedPlugin | undefined {
  return loadedPlugins.get(id)
}

/** 当前已加载的全部插件（增量同步 / 导航注入使用） */
export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values())
}

/** 把插件导航项注入 nav store（App 侧与内置导航合并渲染；按 order 排序交给 store） */
function syncNav(): void {
  useNavConfigStore.getState().setPlugins(
    Array.from(loadedPlugins.values())
      .filter(p => p.nav)
      .map(p => ({
        key: p.id,
        label: p.nav!.label,
        icon: p.nav!.icon,
        order: p.nav!.order,
        detachable: p.nav!.detachable,
      }))
  )
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

/** 卸载单个插件的渲染端：调用 dispose → 移除 locale/导航图标/视图注入/路由，并从 nav.store 摘除 */
export function unloadPluginById(id: string): void {
  const plugin = loadedPlugins.get(id)
  if (!plugin) return
  try { plugin.dispose?.() } catch (err) { console.error(`[PluginLoader] 插件 dispose 失败: ${id}`, err) }
  for (const lng of plugin.localeLngs) {
    i18n.removeResourceBundle(lng, id)
  }
  pluginNavIcons.delete(id)
  unregisterPluginViews(id)
  loadedPlugins.delete(id)
  syncNav()
}

/**
 * 加载单个插件的渲染端（增量热加载核心）：
 * 注册 locale → 动态 import plugin:// 入口 → init(host) → 收集路由/导航/视图 → 登记 registry。
 * 版本相同已加载则跳过（幂等）；覆盖升级时**新版本就绪后原子替换**旧 registry
 * （不预先把旧渲染端摘除，插件页面升级不闪断、不跳转）。
 * 单插件失败仅跳过自身（主进程已隔离激活，这里兜底渲染端异常）。
 */
async function loadSinglePlugin(info: PluginRendererInfo): Promise<void> {
  const existing = loadedPlugins.get(info.id)
  if (existing && existing.version === info.version) return

  const localeLngs: string[] = []
  // 升级前旧 bundle 快照：新版本加载失败时恢复（避免 removeResourceBundle 把旧版本仍显示的文案整体清掉）
  const prevBundles = new Map<string, Record<string, unknown>>()
  const fail = (err: unknown) => {
    console.error(`[PluginLoader] 插件渲染端加载失败: ${info.id}`, err)
    for (const lng of localeLngs) {
      const prev = prevBundles.get(lng)
      if (prev) {
        i18n.removeResourceBundle(lng, info.id)
        i18n.addResourceBundle(lng, info.id, prev, true, true)
      } else {
        i18n.removeResourceBundle(lng, info.id)
      }
    }
  }

  try {
    // 宿主代为注册插件 locale（namespace = 插件 id；与旧版本同 ns 直接 merge 覆盖）
    for (const [lng, resources] of Object.entries(info.locales ?? {})) {
      const prev = i18n.getResourceBundle(lng, info.id) as Record<string, unknown> | undefined
      if (prev && Object.keys(prev).length > 0) prevBundles.set(lng, prev)
      i18n.addResourceBundle(lng, info.id, resources as Record<string, unknown>, true, true)
      localeLngs.push(lng)
    }

    // cache-bust：ESM 动态 import 按 URL 缓存模块，插件升级后必须带 version 参数防加载旧模块
    const cacheBust = `?v=${encodeURIComponent(info.version)}`
    const entry = await rendererModuleLoader.load(`plugin://${info.id}/${info.entry}${cacheBust}`)
    const def = entry.default
    if (!def || !Array.isArray(def.routes)) {
      fail(new Error('renderer 入口缺少 routes'))
      return
    }

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

    // 原子替换：新版本就绪后覆盖 registry / 图标 / 视图（不预删旧项，页面升级不闪断）
    // 覆盖升级场景对旧实例调用 dispose（清理其订阅），再由新入口 init 重建
    if (existing?.dispose) {
      try { existing.dispose() } catch (err) { console.error(`[PluginLoader] 插件 dispose 失败: ${info.id}`, err) }
    }
    // 先清后设：新版本未声明 navIcon 时移除旧图标，避免升级后残留
    pluginNavIcons.delete(info.id)
    if (def.navIcon) pluginNavIcons.set(info.id, def.navIcon)
    unregisterPluginViews(info.id)
    registerPluginViews(info.id, def.views)
    loadedPlugins.set(info.id, {
      id: info.id,
      name: info.name,
      version: info.version,
      nav: info.nav,
      navIcon: def.navIcon,
      views: def.views,
      routes: def.routes.map(r => ({
        path: r.path === '' || r.path === '/' ? '' : r.path.replace(/^\//, ''),
        element: React.createElement(r.component as React.ComponentType<{}>),
      })),
      localeLngs,
      dispose: def.dispose,
    })
    syncNav()
  } catch (err) {
    fail(err)
  }
}

/**
 * 渲染端入口模块加载器：plugin:// 协议 ESM 动态 import（URL 带 version cache-bust）。
 * 独立为对象属性：loadSinglePlugin 在调用时刻读取，单测可直接替换 .load 注入假模块
 * （函数声明闭包无法从外部替换，对象属性可被测试覆盖而不侵入生产调用路径）。
 * plugin:// 为特权协议，文件经主进程 servePluginFile 提供（no-store，禁止 Chromium 缓存）。
 */
export const rendererModuleLoader = {
  load(entryUrl: string): Promise<{ default: PluginRendererEntry }> {
    return import(/* @vite-ignore */ entryUrl) as Promise<{ default: PluginRendererEntry }>
  },
}

/** 串行同步队列：主进程广播（尤其多选导入）可能在短时间内触发多次 syncPlugins，逐个排队执行避免并发竞态
 * （并发时同一插件可能被重复 import/init/dispose，导航/视图/订阅双份） */
let syncChain: Promise<void> = Promise.resolve()

/**
 * 增量同步插件渲染端集合（与主进程广播的最新 rendererPlugins 做 diff）：
 * 已加载但主进程已不可用的 → 卸载；缺失或版本变化的 → 加载；其余保持不动（幂等）。
 * 主进程全量 reload / 整页刷新期间由启动期 loadPlugins 使用同一路径。
 */
export function syncPlugins(rendererPlugins: PluginRendererInfo[]): Promise<void> {
  syncChain = syncChain.catch(() => { /* 单次同步失败不阻塞后续队列 */ })
    .then(() => syncPluginsNow(rendererPlugins))
  return syncChain
}

async function syncPluginsNow(rendererPlugins: PluginRendererInfo[]): Promise<void> {
  const target = new Set(rendererPlugins.map(p => p.id))
  for (const id of Array.from(loadedPlugins.keys())) {
    if (!target.has(id)) unloadPluginById(id)
  }
  for (const info of rendererPlugins) {
    await loadSinglePlugin(info)
  }
}

/**
 * 启动期加载全部已启用插件的渲染端：
 * 拉清单 → 逐个加载（locale/路由/导航/视图）→ 注入 nav store。
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  const { rendererPlugins } = await window.electronAPI.plugin.list()
  await syncPlugins(rendererPlugins)
  return getLoadedPlugins()
}
