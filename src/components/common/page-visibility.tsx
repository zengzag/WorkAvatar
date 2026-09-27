import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * 页面活动可见性上下文：
 * - 主窗口 KeepAliveOutlet 为每个缓存页提供：切到其它导航 tab（页内隐藏）
 *   或整个窗口最小化/被遮挡（document.visibilityState）时为 false。
 * - 独立窗口由 PageVisibleBoundary 按窗口可见性提供。
 *
 * 页面据此暂停 requestAnimationFrame / 高频轮询 / 流式增量 setState 等主线程开销，
 * 避免后台缓存页占满渲染主线程导致导航点击长时间无响应。
 * 注意：display:none / content-visibility 隐藏不会触发 document.visibilitychange，
 * 页内 tab 切换的可见性只能依赖本上下文。
 */
export const PageVisibleContext = createContext<boolean>(true)

/** 当前页面是否活动可见（KeepAlive 后台或窗口隐藏时为 false） */
export function usePageVisible(): boolean {
  return useContext(PageVisibleContext)
}

/** 窗口级可见性（最小化 / OS 窗口切换） */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/**
 * 独立窗口边界：窗口内无 KeepAlive 页内切换，活动态完全等于窗口可见性。
 */
export function PageVisibleBoundary({ children }: { children: ReactNode }) {
  const visible = useDocumentVisible()
  return <PageVisibleContext.Provider value={visible}>{children}</PageVisibleContext.Provider>
}
