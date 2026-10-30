import { useEffect, useState } from 'react'
import { App, Card, Input, Slider, Space, Switch, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SecretaryRuntimeState, SecretarySettings } from '../../../electron/shared/channels/secretary'

const { Text } = Typography

/** 设置 → 小秘书：启用、挂件尺寸/不透明度、免打扰与快捷键 */
const SecretarySettingsPanel: React.FC = () => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [state, setState] = useState<SecretaryRuntimeState | null>(null)
  const [hotkey, setHotkey] = useState('')
  /** 拖动中的临时值：Slider 是受控组件，必须有 onChange 才能移动，落手后再落库 */
  const [sizeDraft, setSizeDraft] = useState<number | null>(null)
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)

  useEffect(() => {
    window.electronAPI.secretary.getState().then((s) => {
      setState(s)
      setHotkey(s.settings.hotkey)
    }).catch(() => {})
  }, [])

  const update = async (patch: Partial<SecretarySettings>) => {
    try {
      const next = await window.electronAPI.secretary.setSettings(patch)
      setState(next)
      setHotkey(next.settings.hotkey)
    } catch {
      message.error(t('secretary.saveFailed'))
    }
  }

  if (!state) return null
  const settings = state.settings
  const sizeValue = sizeDraft ?? settings.size
  const opacityValue = opacityDraft ?? Math.round(settings.opacity * 100)

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minHeight: 36,
    padding: '6px 0',
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
  }
  const labelStyle: React.CSSProperties = { width: 120, flexShrink: 0, color: token.colorTextSecondary, fontSize: 13 }
  const hintStyle: React.CSSProperties = { fontSize: 12, color: token.colorTextTertiary, marginTop: 2 }

  return (
    <Card title={t('secretary.title')}>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('secretary.enabled')}</span>
        <Switch checked={settings.enabled} onChange={(checked) => void update({ enabled: checked })} />
        <Text style={hintStyle}>{t('secretary.enabledHint')}</Text>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{t('secretary.size')}</span>
        <Slider
          style={{ width: 200, margin: 0 }}
          min={64}
          max={192}
          step={8}
          value={sizeValue}
          onChange={(value) => setSizeDraft(value as number)}
          onChangeComplete={(value) => {
            setSizeDraft(null)
            void update({ size: value as number })
          }}
        />
        <Text style={{ fontSize: 12, color: token.colorTextTertiary }}>{sizeValue}px</Text>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{t('secretary.opacity')}</span>
        <Slider
          style={{ width: 200, margin: 0 }}
          min={40}
          max={100}
          step={5}
          value={opacityValue}
          onChange={(value) => setOpacityDraft(value as number)}
          onChangeComplete={(value) => {
            setOpacityDraft(null)
            void update({ opacity: (value as number) / 100 })
          }}
        />
        <Text style={{ fontSize: 12, color: token.colorTextTertiary }}>{opacityValue}%</Text>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{t('secretary.dnd')}</span>
        <Switch checked={settings.dnd} onChange={(checked) => void update({ dnd: checked })} />
        <Text style={hintStyle}>{t('secretary.dndHint')}</Text>
      </div>

      <div style={{ ...rowStyle, borderBottom: 'none' }}>
        <span style={labelStyle}>{t('secretary.hotkey')}</span>
        <Space.Compact style={{ width: 220 }}>
          <Input
            value={hotkey}
            onChange={(e) => setHotkey(e.target.value)}
            placeholder="Control+Alt+Space"
          />
        </Space.Compact>
        <Text
          style={{ ...hintStyle, cursor: 'pointer', color: token.colorPrimary }}
          onClick={() => void update({ hotkey: hotkey.trim() })}
        >
          {t('secretary.hotkeySave')}
        </Text>
      </div>
      <Text style={{ display: 'block', marginTop: 8, fontSize: 12, color: token.colorTextTertiary }}>
        {t('secretary.hotkeyHint')}
      </Text>
      {settings.enabled && settings.hotkey && !state.hotkeyRegistered && (
        <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: token.colorError }}>
          {t('secretary.hotkeyConflict')}
        </Text>
      )}
    </Card>
  )
}

export default SecretarySettingsPanel
