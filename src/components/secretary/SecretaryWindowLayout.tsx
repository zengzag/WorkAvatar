import { useEffect } from 'react'

/**
 * 小秘书窗口外壳：透明窗口需要 body 背景透明，否则圆角外是白底。
 * 权限 / ask_user 弹窗挂在面板窗（发起任务的窗口）里，见 PanelWindow。
 */
const SecretaryWindowLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    // index.html 里已在首帧前打过标记；这里兜底（开发热更新 / 直接导航进来的情况）
    document.documentElement.classList.add('wa-secretary-window')
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => document.documentElement.classList.remove('wa-secretary-window')
  }, [])

  return <>{children}</>
}

export default SecretaryWindowLayout
