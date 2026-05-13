import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Switch,
  App,
  Tag,
  Popconfirm,
  Typography,
  Select,
  TimePicker,
  InputNumber,
  Tooltip,
  theme,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  FieldTimeOutlined,
  BellOutlined,
  BellFilled,
} from '@ant-design/icons'
import dayjs from 'dayjs'

const { Text } = Typography

interface ScheduleItem {
  id: string
  employee_id: string
  name: string
  cron_expr: string
  is_enabled: boolean
  run_mode: 'recurring' | 'once'
  notify_on_complete: boolean
  task_ids_json: string
  last_run_at: number | null
  next_run_at: number | null
  created_at: number
  updated_at: number
}

interface TaskItem {
  id: string
  name: string
  is_enabled: boolean
}

interface ScheduleSectionProps {
  employeeId: string
}

type FrequencyType = 'daily' | 'weekly' | 'monthly' | 'hourly' | 'interval' | 'custom'

function buildCronExpr(freq: FrequencyType, data: {
  time?: dayjs.Dayjs | null
  weekDays?: number[]
  monthDay?: number
  intervalMinutes?: number
  customCron?: string
}): string {
  switch (freq) {
    case 'daily': {
      const h = data.time ? data.time.hour() : 9
      const m = data.time ? data.time.minute() : 0
      return `${m} ${h} * * *`
    }
    case 'weekly': {
      const h = data.time ? data.time.hour() : 9
      const m = data.time ? data.time.minute() : 0
      const days = (data.weekDays && data.weekDays.length > 0) ? data.weekDays.join(',') : '1'
      return `${m} ${h} * * ${days}`
    }
    case 'monthly': {
      const h = data.time ? data.time.hour() : 9
      const m = data.time ? data.time.minute() : 0
      const d = data.monthDay || 1
      return `${m} ${h} ${d} * *`
    }
    case 'hourly': {
      const m = data.time ? data.time.minute() : 0
      return `${m} * * * *`
    }
    case 'interval': {
      const mins = data.intervalMinutes || 60
      if (mins < 60) return `*/${mins} * * * *`
      if (mins % 60 === 0) {
        const hours = mins / 60
        return `0 */${hours} * * *`
      }
      return `*/${mins} * * * *`
    }
    case 'custom': {
      return data.customCron || '0 9 * * *'
    }
    default:
      return '0 9 * * *'
  }
}

function parseCronToHuman(cronExpr: string, t: (key: string, options?: any) => string): string {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) return cronExpr

  const [min, hour, dayOfMonth, month, dayOfWeek] = parts

  if (dayOfMonth === '*' && month === '*') {
    if (dayOfWeek === '*') {
      if (min.startsWith('*/')) return t('empTask.freqIntervalMinutes', { n: min.slice(2) })
      if (hour.startsWith('*/')) return t('empTask.freqIntervalHours', { n: hour.slice(2) })
      if (hour !== '*' && min !== '*') return t('empTask.freqDailyAt', { time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` })
    }
    if (dayOfWeek !== '*' && hour !== '*' && min !== '*') {
      const dayNames = t('empTask.weekDayNames').split(',')
      const days = dayOfWeek.split(',').map(d => {
        const idx = parseInt(d, 10)
        return dayNames[idx] || d
      })
      return t('empTask.freqWeeklyAt', { days: days.join(', '), time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` })
    }
  }

  if (dayOfMonth !== '*' && dayOfWeek === '*' && month === '*' && hour !== '*' && min !== '*') {
    return t('empTask.freqMonthlyAt', { day: dayOfMonth, time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` })
  }

  return cronExpr
}

function guessFrequencyFromCron(cronExpr: string): { freq: FrequencyType; data: any } {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) return { freq: 'custom', data: { customCron: cronExpr } }

  const [min, hour, dayOfMonth, month, dayOfWeek] = parts

  if (dayOfMonth === '*' && month === '*') {
    if (dayOfWeek === '*') {
      if (min.startsWith('*/')) {
        const n = parseInt(min.slice(2), 10)
        return { freq: 'interval', data: { intervalMinutes: n } }
      }
      if (hour.startsWith('*/')) {
        const n = parseInt(hour.slice(2), 10)
        return { freq: 'interval', data: { intervalMinutes: n * 60 } }
      }
      if (hour !== '*' && min !== '*') {
        return { freq: 'daily', data: { time: dayjs().hour(parseInt(hour, 10)).minute(parseInt(min, 10)) } }
      }
    }
    if (dayOfWeek !== '*') {
      const days = dayOfWeek.split(',').map(d => parseInt(d, 10))
      return {
        freq: 'weekly',
        data: {
          time: dayjs().hour(parseInt(hour, 10)).minute(parseInt(min, 10)),
          weekDays: days,
        },
      }
    }
  }

  if (dayOfMonth !== '*' && dayOfWeek === '*' && month === '*') {
    return {
      freq: 'monthly',
      data: {
        time: dayjs().hour(parseInt(hour, 10)).minute(parseInt(min, 10)),
        monthDay: parseInt(dayOfMonth, 10),
      },
    }
  }

  return { freq: 'custom', data: { customCron: cronExpr } }
}

const WEEK_DAY_OPTIONS = [
  { value: 0, label: 'empTask.weekSunday' },
  { value: 1, label: 'empTask.weekMonday' },
  { value: 2, label: 'empTask.weekTuesday' },
  { value: 3, label: 'empTask.weekWednesday' },
  { value: 4, label: 'empTask.weekThursday' },
  { value: 5, label: 'empTask.weekFriday' },
  { value: 6, label: 'empTask.weekSaturday' },
]

const ScheduleSection: React.FC<ScheduleSectionProps> = ({ employeeId }) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [schedules, setSchedules] = useState<ScheduleItem[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<ScheduleItem | null>(null)
  const [form] = Form.useForm()

  const [frequencyType, setFrequencyType] = useState<FrequencyType>('daily')
  const [scheduleTime, setScheduleTime] = useState<dayjs.Dayjs | null>(dayjs().hour(9).minute(0))
  const [weekDays, setWeekDays] = useState<number[]>([1])
  const [monthDay, setMonthDay] = useState<number>(1)
  const [intervalMinutes, setIntervalMinutes] = useState<number>(60)
  const [customCron, setCustomCron] = useState<string>('0 9 * * *')
  const [cronValid, setCronValid] = useState<{ valid: boolean; error?: string; nextRun?: string } | null>(null)
  const [runMode, setRunMode] = useState<'recurring' | 'once'>('recurring')
  const [notifyOnComplete, setNotifyOnComplete] = useState<boolean>(true)

  useEffect(() => {
    loadData()
  }, [employeeId])

  const loadData = async () => {
    setLoading(true)
    try {
      const [schedResult, taskResult] = await Promise.all([
        window.electronAPI.employeeTask.listSchedules(employeeId),
        window.electronAPI.employeeTask.list(employeeId),
      ])
      setSchedules(schedResult || [])
      setTasks((taskResult || []).filter((t: any) => t.is_enabled))
    } catch {
      message.error(t('empTask.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const validateCron = async (expr: string) => {
    if (!expr || expr.trim().split(/\s+/).length !== 5) {
      setCronValid({ valid: false, error: t('empTask.cronFormatError') })
      return
    }
    try {
      const result = await window.electronAPI.employeeTask.validateCron(expr)
      setCronValid(result)
    } catch {
      setCronValid({ valid: false, error: t('empTask.cronValidateFailed') })
    }
  }

  const getCurrentCronExpr = () => {
    return buildCronExpr(frequencyType, {
      time: scheduleTime,
      weekDays,
      monthDay,
      intervalMinutes,
      customCron,
    })
  }

  const handleFrequencyChange = (freq: FrequencyType) => {
    setFrequencyType(freq)
    const expr = buildCronExpr(freq, {
      time: scheduleTime,
      weekDays,
      monthDay,
      intervalMinutes,
      customCron,
    })
    form.setFieldsValue({ cron_expr: expr })
    if (freq !== 'custom') {
      validateCron(expr)
    } else {
      validateCron(customCron)
    }
  }

  const handleTimeChange = (time: dayjs.Dayjs | null) => {
    setScheduleTime(time)
    const expr = buildCronExpr(frequencyType, {
      time,
      weekDays,
      monthDay,
      intervalMinutes,
      customCron,
    })
    form.setFieldsValue({ cron_expr: expr })
    validateCron(expr)
  }

  const handleWeekDaysChange = (days: number[]) => {
    setWeekDays(days)
    const expr = buildCronExpr(frequencyType, {
      time: scheduleTime,
      weekDays: days,
      monthDay,
      intervalMinutes,
      customCron,
    })
    form.setFieldsValue({ cron_expr: expr })
    validateCron(expr)
  }

  const handleMonthDayChange = (day: number | null) => {
    setMonthDay(day || 1)
    const expr = buildCronExpr(frequencyType, {
      time: scheduleTime,
      weekDays,
      monthDay: day || 1,
      intervalMinutes,
      customCron,
    })
    form.setFieldsValue({ cron_expr: expr })
    validateCron(expr)
  }

  const handleIntervalChange = (val: number | null) => {
    const v = val || 60
    setIntervalMinutes(v)
    const expr = buildCronExpr(frequencyType, {
      time: scheduleTime,
      weekDays,
      monthDay,
      intervalMinutes: v,
      customCron,
    })
    form.setFieldsValue({ cron_expr: expr })
    validateCron(expr)
  }

  const handleCustomCronChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setCustomCron(val)
    form.setFieldsValue({ cron_expr: val })
    if (val.trim().split(/\s+/).length === 5) {
      validateCron(val)
    } else {
      setCronValid(null)
    }
  }

  const handleCreate = () => {
    setEditingSchedule(null)
    form.resetFields()
    const defaultTime = dayjs().hour(9).minute(0)
    setFrequencyType('daily')
    setScheduleTime(defaultTime)
    setWeekDays([1])
    setMonthDay(1)
    setIntervalMinutes(60)
    setCustomCron('0 9 * * *')
    setRunMode('recurring')
    setNotifyOnComplete(true)
    form.setFieldsValue({
      is_enabled: true,
      cron_expr: '0 9 * * *',
      run_mode: 'recurring',
    })
    setCronValid(null)
    setModalOpen(true)
    setTimeout(() => validateCron('0 9 * * *'), 100)
  }

  const handleEdit = (schedule: ScheduleItem) => {
    setEditingSchedule(schedule)
    let taskIds: string[] = []
    try { taskIds = JSON.parse(schedule.task_ids_json) } catch {}

    const { freq, data } = guessFrequencyFromCron(schedule.cron_expr)
    setFrequencyType(freq)
    setScheduleTime(data.time || dayjs().hour(9).minute(0))
    setWeekDays(data.weekDays || [1])
    setMonthDay(data.monthDay || 1)
    setIntervalMinutes(data.intervalMinutes || 60)
    setCustomCron(data.customCron || schedule.cron_expr)
    setRunMode(schedule.run_mode || 'recurring')
    setNotifyOnComplete(schedule.notify_on_complete !== false)

    form.setFieldsValue({
      name: schedule.name,
      cron_expr: schedule.cron_expr,
      is_enabled: schedule.is_enabled,
      task_ids: taskIds,
      run_mode: schedule.run_mode || 'recurring',
    })
    setCronValid(null)
    setModalOpen(true)
    setTimeout(() => validateCron(schedule.cron_expr), 100)
  }

  const handleSave = async (values: any) => {
    try {
      if (editingSchedule) {
        await window.electronAPI.employeeTask.updateSchedule({
          id: editingSchedule.id,
          name: values.name,
          cron_expr: values.cron_expr,
          is_enabled: values.is_enabled,
          task_ids: values.task_ids || [],
          run_mode: runMode,
          notify_on_complete: notifyOnComplete,
        })
        message.success(t('common.updateSuccess'))
      } else {
        await window.electronAPI.employeeTask.createSchedule({
          employee_id: employeeId,
          name: values.name,
          cron_expr: values.cron_expr,
          task_ids: values.task_ids || [],
          run_mode: runMode,
          notify_on_complete: notifyOnComplete,
        })
        message.success(t('common.createSuccess'))
      }
      setModalOpen(false)
      loadData()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }

  const handleDelete = async (scheduleId: string) => {
    try {
      await window.electronAPI.employeeTask.deleteSchedule(scheduleId)
      message.success(t('common.deleteSuccess'))
      loadData()
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const handleToggleEnabled = async (scheduleId: string, enabled: boolean) => {
    try {
      await window.electronAPI.employeeTask.updateSchedule({ id: scheduleId, is_enabled: enabled })
      message.success(enabled ? t('common.enable') + t('common.success') : t('common.disable') + t('common.success'))
      loadData()
    } catch {
      message.error(t('common.failed'))
    }
  }

  const columns = [
    {
      title: t('common.name'),
      dataIndex: 'name',
      key: 'name',
      width: 150,
    },
    {
      title: t('empTask.scheduleRule'),
      key: 'cron_expr',
      width: 200,
      render: (_: any, record: ScheduleItem) => (
        <Tooltip title={`Cron: ${record.cron_expr}`}>
          <Tag icon={<FieldTimeOutlined />} color="blue">
            {parseCronToHuman(record.cron_expr, t)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: t('empTask.runModeLabel'),
      dataIndex: 'run_mode',
      key: 'run_mode',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'once' ? 'orange' : 'blue'}>
          {v === 'once' ? t('empTask.runModeOnce') : t('empTask.runModeRecurring')}
        </Tag>
      ),
    },
    {
      title: t('empTask.selectedTasks'),
      key: 'task_ids_json',
      width: 200,
      render: (_: any, record: ScheduleItem) => {
        let taskIds: string[] = []
        try { taskIds = JSON.parse(record.task_ids_json) } catch {}
        return (
          <div>
            {taskIds.length > 0 ? taskIds.map(tid => {
              const task = tasks.find(ta => ta.id === tid)
              return task ? <Tag key={tid} style={{ marginBottom: 2 }}>{task.name}</Tag> : null
            }) : <Text type="secondary">{t('empTask.noTaskSelected')}</Text>}
          </div>
        )
      },
    },
    {
      title: t('empTask.lastRun'),
      dataIndex: 'last_run_at',
      key: 'last_run_at',
      width: 130,
      render: (v: number | null) => v ? dayjs(v * 1000).format('MM-DD HH:mm') : <Text type="secondary">-</Text>,
    },
    {
      title: t('empTask.nextRun'),
      dataIndex: 'next_run_at',
      key: 'next_run_at',
      width: 130,
      render: (v: number | null) => v ? dayjs(v * 1000).format('MM-DD HH:mm') : <Text type="secondary">-</Text>,
    },
    {
      title: t('empTask.notifyLabel'),
      dataIndex: 'notify_on_complete',
      key: 'notify_on_complete',
      width: 70,
      render: (v: boolean) => (
        <Tooltip title={v ? t('empTask.notifyEnabled') : t('empTask.notifyDisabled')}>
          {v ? <BellFilled style={{ color: token.colorPrimary }} /> : <BellOutlined style={{ color: token.colorTextQuaternary }} />}
        </Tooltip>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'is_enabled',
      key: 'is_enabled',
      width: 70,
      render: (enabled: boolean, record: ScheduleItem) => (
        <Switch size="small" checked={enabled} onChange={(v) => handleToggleEnabled(record.id, v)} />
      ),
    },
    {
      title: t('common.action'),
      key: 'action',
      width: 100,
      render: (_: any, record: ScheduleItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm
            title={t('common.confirmDelete')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const frequencyOptions = [
    { value: 'daily', label: t('empTask.freqDaily') },
    { value: 'weekly', label: t('empTask.freqWeekly') },
    { value: 'monthly', label: t('empTask.freqMonthly') },
    { value: 'hourly', label: t('empTask.freqHourly') },
    { value: 'interval', label: t('empTask.freqInterval') },
    { value: 'custom', label: t('empTask.freqCustom') },
  ]

  return (
    <div>
      <Card
        title={t('empTask.scheduleTitle')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            {t('empTask.createSchedule')}
          </Button>
        }
      >
        <Table
          dataSource={schedules}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="small"
          locale={{ emptyText: t('empTask.noSchedules') }}
        />
      </Card>

      <Modal
        open={modalOpen}
        title={editingSchedule ? t('empTask.editSchedule') : t('empTask.createSchedule')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={() => form.submit()}
        onCancel={() => setModalOpen(false)}
        width={640}
      >
        <Form form={form} layout="vertical" onFinish={handleSave} style={{ marginTop: 16 }}>
          <Form.Item name="name" label={t('common.name')} rules={[{ required: true, message: t('empTask.nameRequired') }]}>
            <Input placeholder={t('empTask.scheduleNamePlaceholder')} />
          </Form.Item>

          <Form.Item name="run_mode" label={t('empTask.runModeLabel')} rules={[{ required: true }]}>
            <Select
              value={runMode}
              onChange={(v) => setRunMode(v as 'recurring' | 'once')}
              options={[
                { label: t('empTask.runModeRecurring'), value: 'recurring' },
                { label: t('empTask.runModeOnce'), value: 'once' },
              ]}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item label={t('empTask.frequencyLabel')} required>
            <Select
              value={frequencyType}
              onChange={handleFrequencyChange}
              options={frequencyOptions}
              style={{ width: '100%' }}
            />
          </Form.Item>

          {frequencyType === 'daily' && (
            <Form.Item label={t('empTask.executionTimeLabel')}>
              <TimePicker
                value={scheduleTime}
                onChange={handleTimeChange}
                format="HH:mm"
                minuteStep={5}
                style={{ width: '100%' }}
              />
            </Form.Item>
          )}

          {frequencyType === 'weekly' && (
            <>
              <Form.Item label={t('empTask.selectWeekDays')}>
                <Select
                  mode="multiple"
                  value={weekDays}
                  onChange={handleWeekDaysChange}
                  options={WEEK_DAY_OPTIONS.map(d => ({ value: d.value, label: t(d.label) }))}
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item label={t('empTask.executionTimeLabel')}>
                <TimePicker
                  value={scheduleTime}
                  onChange={handleTimeChange}
                  format="HH:mm"
                  minuteStep={5}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </>
          )}

          {frequencyType === 'monthly' && (
            <>
              <Form.Item label={t('empTask.selectMonthDay')}>
                <InputNumber
                  value={monthDay}
                  onChange={handleMonthDayChange}
                  min={1}
                  max={31}
                  addonAfter={t('empTask.daySuffix')}
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item label={t('empTask.executionTimeLabel')}>
                <TimePicker
                  value={scheduleTime}
                  onChange={handleTimeChange}
                  format="HH:mm"
                  minuteStep={5}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </>
          )}

          {frequencyType === 'hourly' && (
            <Form.Item label={t('empTask.minuteOfHourLabel')}>
              <InputNumber
                value={scheduleTime ? scheduleTime.minute() : 0}
                onChange={(v) => {
                  const newTime = (scheduleTime || dayjs().hour(0)).minute(v || 0)
                  handleTimeChange(newTime)
                }}
                min={0}
                max={59}
                addonAfter={t('empTask.minuteSuffix')}
                style={{ width: '100%' }}
              />
            </Form.Item>
          )}

          {frequencyType === 'interval' && (
            <Form.Item label={t('empTask.intervalLabel')}>
              <InputNumber
                value={intervalMinutes}
                onChange={handleIntervalChange}
                min={5}
                max={1440}
                step={5}
                addonAfter={t('empTask.minuteSuffix')}
                style={{ width: '100%' }}
              />
            </Form.Item>
          )}

          {frequencyType === 'custom' && (
            <Form.Item
              label={t('empTask.cronExpr')}
              help={cronValid ? (cronValid.valid
                ? <span style={{ color: token.colorSuccess }}><CheckCircleOutlined /> {t('empTask.nextRunAt')}: {cronValid.nextRun ? dayjs(cronValid.nextRun).format('YYYY-MM-DD HH:mm') : '-'}</span>
                : <span style={{ color: token.colorError }}>{cronValid.error}</span>
              ) : null}
            >
              <Input
                value={customCron}
                onChange={handleCustomCronChange}
                placeholder="0 9 * * *"
              />
            </Form.Item>
          )}

          {frequencyType !== 'custom' && cronValid && cronValid.valid && (
            <div style={{ marginBottom: 16, padding: '8px 12px', background: token.colorBgLayout, borderRadius: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                <FieldTimeOutlined /> {t('empTask.nextRunAt')}: {cronValid.nextRun ? dayjs(cronValid.nextRun).format('YYYY-MM-DD HH:mm') : '-'}
                <span style={{ marginLeft: 12, color: token.colorTextQuaternary }}>Cron: {getCurrentCronExpr()}</span>
              </Text>
            </div>
          )}

          <Form.Item name="cron_expr" hidden>
            <Input />
          </Form.Item>

          <Form.Item name="task_ids" label={t('empTask.selectedTasks')} rules={[{ required: true, message: t('empTask.selectTaskRequired') }]}>
            <Select
              mode="multiple"
              placeholder={t('empTask.selectTaskPlaceholder')}
              options={tasks.map(ta => ({ label: ta.name, value: ta.id }))}
            />
          </Form.Item>
          <Form.Item name="is_enabled" label={t('empTask.enabledLabel')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label={t('empTask.notifyLabel')} tooltip={t('empTask.notifyTooltip')}>
            <Switch
              checked={notifyOnComplete}
              onChange={setNotifyOnComplete}
              checkedChildren={<BellFilled />}
              unCheckedChildren={<BellOutlined />}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ScheduleSection
