import { useRef, useEffect, type ReactNode } from 'react'
import { useOutlet, useLocation } from 'react-router-dom'
import { PageVisibleContext, useDocumentVisible } from './page-visibility'

/**
 * 导航栏主页面 KeepAlive 缓存：
 * - 按路由前缀生成 cacheKey，同一 pattern 共享一个缓存实例
 * - 已访问的页面保持挂载，切换时仅切换可见性（状态/滚动位置保留）
 * - 非缓存路由（如 / 重定向）直接渲染，不进入缓存
 * - clearKeys：需要清除缓存的 cacheKey 列表（如 tab 已分离为独立窗口时，主窗口清除该 tab 缓存避免数据陈旧）
 *
 * 隐藏方式刻意使用「绝对定位层叠 + content-visibility:hidden + visibility:hidden」而非 display:none：
 * 1. content-visibility:hidden 跳过隐藏子树的 layout/paint，但保留其布局状态（滚动位置、
 *    ReactFlow 节点测量值），切回时零成本恢复；
 * 2. 不会像 display:none 那样让 ResizeObserver 集体上报 0 尺寸，避免 ReactFlow 等画布类
 *    页面在切换瞬间触发整树重新测量与重排；
 * 3. 配合 PageVisibleContext 让页面 JS 侧也能暂停 rAF/高频 setState，双管齐下保证后台
 *    缓存页不占用渲染主线程。
 */
const CACHEABLE_PREFIXES: Array<[string, string]> = [
  ['/tasks', 'tasks'],
  ['/employees', 'employees'],
  ['/settings', 'settings'],
  ['/kms', 'kms'],
]

function getCacheKey(pathname: string): string | null {
  // 插件路由通用规则：/plugin/<id>/* 一律可缓存（不再按特定插件白名单）
  if (pathname.startsWith('/plugin/')) {
    return pathname.split('/')[2] || null
  }
  for (const [prefix, key] of CACHEABLE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      return key
    }
  }
  return null
}

const KeepAliveOutlet: React.FC<{ clearKeys?: string[] }> = ({ clearKeys }) => {
  const location = useLocation()
  const outlet = useOutlet()
  const cacheRef = useRef<Map<string, ReactNode>>(new Map())

  const cacheKey = getCacheKey(location.pathname)
  const documentVisible = useDocumentVisible()

  // 清除指定 cacheKey 的缓存（tab 分离时避免主窗口残留旧状态）
  useEffect(() => {
    if (!clearKeys || clearKeys.length === 0) return
    for (const key of clearKeys) {
      cacheRef.current.delete(key)
    }
  }, [clearKeys])

  if (cacheKey && outlet) {
    cacheRef.current.set(cacheKey, outlet)
  }

  const entries = Array.from(cacheRef.current.entries())

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      {entries.map(([key, element]) => {
        const active = key === cacheKey && documentVisible
        return (
          <PageVisibleContext.Provider key={key} value={active}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                // 隐藏层不接收指针/不进入可访问性树；content-visibility 跳过内部布局与绘制
                visibility: active ? 'visible' : 'hidden',
                pointerEvents: active ? 'auto' : 'none',
                contentVisibility: active ? 'visible' : 'hidden',
              }}
            >
              {element}
            </div>
          </PageVisibleContext.Provider>
        )
      })}
      {!cacheKey && outlet && (
        <PageVisibleContext.Provider value={documentVisible}>
          <div style={{ position: 'absolute', inset: 0 }}>{outlet}</div>
        </PageVisibleContext.Provider>
      )}
    </div>
  )
}

export default KeepAliveOutlet
