import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Collapse,
  Button,
  Space,
  Tag,
  Typography,
  Tooltip,
  Progress,
  App,
  theme,
} from 'antd'
import {
  ToolOutlined,
  ReloadOutlined,
  DownloadOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  StopOutlined,
} from '@ant-design/icons'
import type {
  RuntimeEnvTool,
  RuntimeEnvToolId,
  RuntimeEnvInstallProgress,
} from '../../../electron/shared/ipc-channels'

const { Text, Paragraph } = Typography

/**
 * 工具状态对应的 Tag 颜色：
 * - 已安装：绿色（success）
 * - 未安装但可一键安装：橙色（warning）
 * - 未安装且不可一键安装：灰色（default）
 */
function getStatusColor(tool: RuntimeEnvTool): string {
  if (tool.installed) return 'success'
  if (tool.installable) return 'warning'
  return 'default'
}

/**
 * 安装进度阶段 → 中文文案映射
 */
function getPhaseLabel(phase: RuntimeEnvInstallProgress['phase'], t: (k: string) => string): string {
  switch (phase) {
    case 'pending': return t('settings.runtimeEnvPhasePending')
    case 'downloading': return t('settings.runtimeEnvPhaseDownloading')
    case 'installing': return t('settings.runtimeEnvPhaseInstalling')
    case 'verifying': return t('settings.runtimeEnvPhaseVerifying')
    case 'done': return t('settings.runtimeEnvPhaseDone')
    case 'error': return t('settings.runtimeEnvPhaseError')
    case 'cancelled': return t('settings.runtimeEnvPhaseCancelled')
    default: return phase
  }
}

const RuntimeEnvSection: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [tools, setTools] = useState<RuntimeEnvTool[]>([])
  const [loading, setLoading] = useState(false)
  // 当前正在安装的工具 id 与进度
  const [installingId, setInstallingId] = useState<RuntimeEnvToolId | null>(null)
  const [installProgress, setInstallProgress] = useState<RuntimeEnvInstallProgress | null>(null)

  // 拉取检测状态
  const loadTools = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.runtimeEnv.list()
      setTools(result || [])
    } catch (err: any) {
      message.error(t('settings.runtimeEnvDetectFailed') + (err?.message ? `: ${err.message}` : ''))
    } finally {
      setLoading(false)
    }
  }, [message, t])

  useEffect(() => {
    loadTools()
  }, [loadTools])

  // 订阅安装进度事件
  useEffect(() => {
    const unsubscribe = window.electronAPI.runtimeEnv.onProgress((progress) => {
      setInstallProgress(progress)
      // 收到 done / error / cancelled 时，自动重新检测并清空安装状态
      if (progress.phase === 'done' || progress.phase === 'error' || progress.phase === 'cancelled') {
        // 延迟 300ms 重检测，给主进程一些时间完成状态收敛
        setTimeout(() => {
          setInstallingId(null)
          setInstallProgress(null)
          loadTools()
        }, 300)
      }
    })
    return () => { unsubscribe() }
  }, [loadTools])

  // 触发一键安装
  const handleInstall = useCallback(async (toolId: RuntimeEnvToolId) => {
    if (installingId) return
    setInstallingId(toolId)
    setInstallProgress({ toolId, phase: 'pending', message: t('settings.runtimeEnvPhasePending') })
    try {
      const result = await window.electronAPI.runtimeEnv.install({ toolId })
      if (result.success) {
        message.success(t('settings.runtimeEnvInstallSuccess'))
      } else if ((result as any).cancelled) {
        message.info(t('settings.runtimeEnvInstallCancelled'))
      } else {
        message.error(result.error || t('settings.runtimeEnvInstallFailed'))
      }
    } catch (err: any) {
      message.error(t('settings.runtimeEnvInstallFailed') + (err?.message ? `: ${err.message}` : ''))
    } finally {
      // 进度事件最终会触发清空；这里兜底
      setTimeout(() => {
        setInstallingId((cur) => (cur === toolId ? null : cur))
        setInstallProgress(null)
      }, 500)
    }
  }, [installingId, message, t])

  // 取消正在进行的安装
  const handleCancelInstall = useCallback(async () => {
    try {
      await window.electronAPI.runtimeEnv.cancelInstall()
      message.info(t('settings.runtimeEnvInstallCancelling'))
    } catch {
      // ignore
    }
  }, [message, t])

  return (
    <Collapse
      defaultActiveKey={['env']}
      items={[
        {
          key: 'env',
          label: (
            <Space>
              <ToolOutlined />
              <span>{t('settings.runtimeEnvTitle')}</span>
              {/* 折叠态下在标题旁快速显示摘要 */}
              <Space size={4}>
                {tools.length > 0 && tools.map((tool) => (
                  <Tag
                    key={tool.id}
                    color={getStatusColor(tool)}
                    style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', margin: 0 }}
                  >
                    {tool.name}{tool.installed && tool.version ? ` v${tool.version}` : ''}
                  </Tag>
                ))}
              </Space>
            </Space>
          ),
          extra: (
            <Button
              icon={<ReloadOutlined />}
              onClick={(e) => { e.stopPropagation(); loadTools() }}
              loading={loading}
              disabled={installingId !== null}
              size="small"
            >
              {t('common.refresh')}
            </Button>
          ),
          children: (
            <>
              <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
                {t('settings.runtimeEnvDesc')}
              </Paragraph>

              <div>
                {tools.map((tool) => {
                  const isInstallingThis = installingId === tool.id
                  const progress = isInstallingThis ? installProgress : null
                  return (
                    <div
                      key={tool.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        padding: '12px 0',
                        borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        gap: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                        <ToolOutlined
                          style={{
                            fontSize: 18,
                            color: tool.installed ? token.colorSuccess : token.colorTextTertiary,
                            marginTop: 4,
                            flexShrink: 0,
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <Text strong>{tool.name}</Text>
                            {tool.installed && tool.version && (
                              <Tag color="blue" style={{ flexShrink: 0 }}>v{tool.version}</Tag>
                            )}
                            <Tag color={getStatusColor(tool)} style={{ flexShrink: 0 }}>
                              {tool.installed ? (
                                <CheckCircleFilled style={{ marginRight: 4 }} />
                              ) : tool.installable ? (
                                <ExclamationCircleFilled style={{ marginRight: 4 }} />
                              ) : null}
                              {tool.installed
                                ? t('settings.runtimeEnvInstalled')
                                : t('settings.runtimeEnvNotInstalled')}
                            </Tag>
                          </div>
                          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                            {tool.description}
                          </Text>
                          {tool.installed && tool.path && (
                            <Tooltip title={tool.path}>
                              <Text
                                type="secondary"
                                ellipsis
                                style={{ display: 'block', fontSize: 11, marginTop: 2, maxWidth: '100%' }}
                              >
                                {tool.path}
                              </Text>
                            </Tooltip>
                          )}
                          {!tool.installed && !tool.installable && tool.installHint && (
                            <Text type="warning" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                              {tool.installHint}
                            </Text>
                          )}
                          {/* 安装进度区 */}
                          {isInstallingThis && progress && (
                            <div style={{ marginTop: 8, padding: 8, background: token.colorFillQuaternary, borderRadius: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <Tag color="processing">{getPhaseLabel(progress.phase, t)}</Tag>
                                <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
                                  {progress.message}
                                </Text>
                              </div>
                              {typeof progress.progress === 'number' && (
                                <Progress percent={progress.progress} size="small" status="active" />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        {!tool.installed && tool.installable && !isInstallingThis && (
                          <Button
                            type="primary"
                            size="small"
                            icon={<DownloadOutlined />}
                            onClick={() => handleInstall(tool.id)}
                            disabled={installingId !== null}
                          >
                            {t('settings.runtimeEnvOneClickInstall')}
                          </Button>
                        )}
                        {isInstallingThis && (
                          <Button
                            danger
                            size="small"
                            icon={<StopOutlined />}
                            onClick={handleCancelInstall}
                          >
                            {t('common.cancel')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {tools.length === 0 && !loading && (
                  <Text type="secondary">{t('settings.runtimeEnvEmpty')}</Text>
                )}
              </div>
            </>
          ),
        },
      ]}
    />
  )
}

export default React.memo(RuntimeEnvSection)