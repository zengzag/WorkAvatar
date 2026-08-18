import { useRef, useEffect, type ReactNode } from 'react'
import { useOutlet, useLocation } from 'react-router-dom'

/**
 * 导航栏主页面 KeepAlive 缓存：
 * - 按路由前缀生成 cacheKey，同一 pattern 共享一个缓存实例
 * - 已访问的页面保持挂载（display:none 隐藏），切换时仅切换可见性
 * - 非缓存路由（如 / 重定向）直接渲染，不进入缓存
 * - clearKeys：需要清除缓存的 cacheKey 列表（如 tab 已分离为独立窗口时，主窗口清除该 tab 缓存避免数据陈旧）
 */
const CACHEABLE_PREFIXES: Array<[string, string]> = [
  ['/tasks', 'tasks'],
  ['/employees', 'employees'],
  ['/settings', 'settings'],
  ['/kms', 'kms'],
  ['/automation', 'automation'],
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
    <>
      {entries.map(([key, element]) => (
        <div
          key={key}
          style={{
            display: key === cacheKey ? 'block' : 'none',
            height: '100%',
          }}
        >
          {element}
        </div>
      ))}
      {!cacheKey && outlet && (
        <div style={{ height: '100%' }}>{outlet}</div>
      )}
    </>
  )
}

export default KeepAliveOutlet
