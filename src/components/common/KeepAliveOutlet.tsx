import { useRef, type ReactNode } from 'react'
import { useOutlet, useLocation } from 'react-router-dom'

/**
 * 导航栏主页面 KeepAlive 缓存：
 * - 按路由前缀生成 cacheKey，同一 pattern 共享一个缓存实例
 * - 已访问的页面保持挂载（display:none 隐藏），切换时仅切换可见性
 * - 非缓存路由（如 / 重定向）直接渲染，不进入缓存
 */
const CACHEABLE_PREFIXES: Array<[string, string]> = [
  ['/employee', 'employee'],
  ['/settings', 'settings'],
  ['/kms', 'kms'],
  ['/voice', 'voice'],
  ['/calendar', 'calendar'],
  ['/automation', 'automation'],
  ['/notes', 'notes'],
]

function getCacheKey(pathname: string): string | null {
  for (const [prefix, key] of CACHEABLE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/') || pathname.startsWith(prefix)) {
      return key
    }
  }
  return null
}

const KeepAliveOutlet: React.FC = () => {
  const location = useLocation()
  const outlet = useOutlet()
  const cacheRef = useRef<Map<string, ReactNode>>(new Map())

  const cacheKey = getCacheKey(location.pathname)

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
