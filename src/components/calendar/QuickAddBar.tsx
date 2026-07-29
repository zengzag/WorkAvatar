import { useState, useRef, useCallback } from 'react'
import { Input, Popover, DatePicker, Button, theme, message as Message } from 'antd'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import { ClockCircleOutlined } from '@ant-design/icons'
import type { CreateTodoInput } from '../../types/calendar'

const MS = 1000

type QuickTimeKey = 'today' | 'tomorrow' | 'thisWeek' | 'nextMon' | 'none' | 'custom'

interface QuickAddBarProps {
  onSubmit: (input: CreateTodoInput) => Promise<any>
}

const endOfTodaySec = (): number => {
  const now = new Date()
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0).getTime() / MS)
}

const endOfTomorrowSec = (): number => endOfTodaySec() + 86400

const endOfThisWeekSec = (): number => {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? 0 : 7 - day
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 18, 0, 0, 0).getTime() / MS)
}

const nextMondaySec = (): number => {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? 1 : 8 - day
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 18, 0, 0, 0).getTime() / MS)
}

const QuickAddBar: React.FC<QuickAddBarProps> = ({ onSubmit }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [text, setText] = useState('')
  const [timeKey, setTimeKey] = useState<QuickTimeKey>('today')
  const [customDue, setCustomDue] = useState<dayjs.Dayjs | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<any>(null)

  const computeDueAt = useCallback((): number | null => {
    switch (timeKey) {
      case 'today': return endOfTodaySec()
      case 'tomorrow': return endOfTomorrowSec()
      case 'thisWeek': return endOfThisWeekSec()
      case 'nextMon': return nextMondaySec()
      case 'none': return null
      case 'custom': return customDue ? Math.floor(customDue.valueOf() / MS) : null
    }
  }, [timeKey, customDue])

  const chipLabel = useCallback((): string => {
    switch (timeKey) {
      case 'today': return t('calendar.quickAddToday')
      case 'tomorrow': return t('calendar.quickAddTomorrow')
      case 'thisWeek': return t('calendar.quickAddThisWeek')
      case 'nextMon': return t('calendar.quickAddNextMonday')
      case 'none': return t('calendar.quickAddNoDue')
      case 'custom': {
        if (!customDue) return t('calendar.quickAddCustom')
        const d = customDue
        const now = new Date()
        const sameDay = d.toDate().toDateString() === now.toDateString()
        const hm = `${d.hour().toString().padStart(2, '0')}:${d.minute().toString().padStart(2, '0')}`
        if (sameDay) return hm
        return `${d.month() + 1}/${d.date()} ${hm}`
      }
    }
  }, [timeKey, customDue, t])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      const lines = trimmed.split('\n')
      const title = lines[0]
      const description = lines.length > 1 ? lines.slice(1).join('\n').trim() : ''
      const input: CreateTodoInput = {
        title,
        description,
        due_at: computeDueAt(),
        priority: 'none',
        status: 'pending',
        reminders: [],
      }
      const result = await onSubmit(input)
      if (result && !result.error) {
        setText('')
        setTimeKey('today')
        setCustomDue(null)
        inputRef.current?.focus()
      } else if (result?.error) {
        Message.error(result.error)
      }
    } catch (err: any) {
      Message.error(err?.message || 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }, [text, submitting, computeDueAt, onSubmit])

  const quickOptions: { key: QuickTimeKey; label: string }[] = [
    { key: 'today', label: t('calendar.quickAddToday') },
    { key: 'tomorrow', label: t('calendar.quickAddTomorrow') },
    { key: 'thisWeek', label: t('calendar.quickAddThisWeek') },
    { key: 'nextMon', label: t('calendar.quickAddNextMonday') },
    { key: 'none', label: t('calendar.quickAddNoDue') },
  ]

  const popoverContent = pickerMode ? (
    <div style={{ padding: 4 }}>
      <DatePicker
        showTime={{ format: 'HH:mm', minuteStep: 5 }}
        format="YYYY-MM-DD HH:mm"
        value={customDue}
        onChange={(v) => {
          if (v) {
            setCustomDue(v)
            setTimeKey('custom')
          }
          setPickerMode(false)
          setPopoverOpen(false)
        }}
        allowClear={false}
        size="small"
      />
    </div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 4, minWidth: 120 }}>
      {quickOptions.map(opt => (
        <Button
          key={opt.key}
          type="text"
          size="small"
          style={{ textAlign: 'left', justifyContent: 'flex-start' }}
          onClick={() => {
            setTimeKey(opt.key)
            setCustomDue(null)
            setPopoverOpen(false)
          }}
        >
          {opt.label}
        </Button>
      ))}
      <Button
        type="text"
        size="small"
        style={{ textAlign: 'left', justifyContent: 'flex-start' }}
        onClick={() => setPickerMode(true)}
      >
        {t('calendar.quickAddCustom')}
      </Button>
    </div>
  )

  const chipColor = timeKey === 'none'
    ? token.colorTextTertiary
    : (timeKey === 'custom' && customDue && customDue.valueOf() < Date.now())
      ? token.colorError
      : token.colorPrimary

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px 6px 14px',
        borderRadius: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        transition: 'border-color 0.2s',
      }}
      onFocusCapture={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = token.colorPrimary
      }}
      onBlurCapture={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = token.colorBorderSecondary
      }}
    >
      <Input.TextArea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
          }
          if (e.key === 'Escape') {
            setText('')
          }
        }}
        placeholder={t('calendar.quickAddPlaceholder')}
        autoSize={{ minRows: 1, maxRows: 6 }}
        className="quick-add-input"
        style={{
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          resize: 'none',
          fontSize: 13,
          lineHeight: 1.5,
          padding: '8px 0',
          minHeight: 36,
        }}
        disabled={submitting}
      />
      <Popover
        open={popoverOpen}
        onOpenChange={(v) => {
          setPopoverOpen(v)
          if (!v) setPickerMode(false)
        }}
        content={popoverContent}
        trigger="click"
        placement="bottomRight"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 10px',
            borderRadius: 6,
            cursor: 'pointer',
            color: chipColor,
            fontSize: 12,
            whiteSpace: 'nowrap',
            flexShrink: 0,
            background: token.colorFillQuaternary,
            height: 36,
          }}
        >
          <ClockCircleOutlined style={{ fontSize: 12 }} />
          {chipLabel()}
        </div>
      </Popover>
    </div>
  )
}

export default QuickAddBar
