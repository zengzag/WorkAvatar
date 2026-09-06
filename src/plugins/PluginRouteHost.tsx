/**
 * 插件路由动态分发容器：router 仅静态注册 `/plugin/:pluginId/*` 占位路由，
 * 实际路由由 loader 的运行态 registry 决定——插件加载/卸载/覆盖升级无需重建 router，
 * 页面挂在当前插件下持续可用，达到免整页刷新的增量热加载。
 */
import React from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { getLoadedPlugin } from './loader'

export function PluginRouteHost(): React.ReactElement | null {
  const { pluginId } = useParams()
  const plugin = pluginId ? getLoadedPlugin(pluginId) : undefined
  // 插件已卸载/未加载 → 回退到任务页（内置兜底，避免空路由）
  if (!plugin || plugin.routes.length === 0) return <Navigate to="/tasks" replace />
  return (
    <Routes>
      <Route path="" element={plugin.routes.find(r => r.path === '')?.element ?? <Navigate to="/tasks" replace />} />
      {plugin.routes.filter(r => r.path !== '').map(r => (
        <Route key={r.path} path={r.path} element={r.element} />
      ))}
      <Route path="*" element={<Navigate to="/tasks" replace />} />
    </Routes>
  )
}

export default PluginRouteHost