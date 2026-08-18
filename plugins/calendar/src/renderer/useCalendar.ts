import { useCallback, useEffect } from 'react'
import { useCalendarStore } from './calendar.store'
import { cal } from './store'
import type {
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoInstance,
  CalendarTodoStats,
  CalendarSettings,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
  DeleteEventInstanceParams,
  DeleteTodoInstanceParams,
} from './types'

const SECONDS = 1000

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const endOfDay = (ms: number): number => startOfDay(ms) + 86400 * SECONDS - 1

const startOfWeek = (ms: number): number => {
  const d = new Date(ms)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff)
  return monday.getTime()
}

const startOfMonth = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

const endOfMonth = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime()
}

/** 获取当前视图对应的查询区间（unix 秒） */
export function getViewRange(view: 'month' | 'week' | 'day', currentDateMs: number): { start_at: number; end_at: number } {
  if (view === 'day') {
    return { start_at: Math.floor(startOfDay(currentDateMs) / SECONDS), end_at: Math.floor(endOfDay(currentDateMs) / SECONDS) }
  }
  if (view === 'week') {
    const start = startOfWeek(currentDateMs)
    return { start_at: Math.floor(start / SECONDS), end_at: Math.floor((start + 7 * 86400 * SECONDS - 1) / SECONDS) }
  }
  // 月视图：前后各多取 7 天，保证上月末与下月初的事件也能在日历格上显示
  const start = startOfMonth(currentDateMs) - 7 * 86400 * SECONDS
  const end = endOfMonth(currentDateMs) + 7 * 86400 * SECONDS
  return { start_at: Math.floor(start / SECONDS), end_at: Math.floor(end / SECONDS) }
}

export function useCalendar() {
  const {
    events, todos, todoInstances, stats, settings, view, currentDate, filters,
    loadingEvents, loadingTodos, loadingTodoInstances,
    setEvents, setTodos, setTodoInstances, setStats, setSettings, setView, setCurrentDate, setFilters,
    setLoadingEvents, setLoadingTodos, setLoadingTodoInstances,
  } = useCalendarStore()

  const refreshEvents = useCallback(async () => {
    setLoadingEvents(true)
    try {
      const range = getViewRange(view, currentDate)
      const result = await cal.listEvents(range)
      if (Array.isArray(result)) setEvents(result as CalendarEventInstance[])
    } catch (err) {
      console.error('Failed to load events:', err)
    } finally {
      setLoadingEvents(false)
    }
  }, [view, currentDate, setEvents, setLoadingEvents])

  const refreshTodos = useCallback(async () => {
    setLoadingTodos(true)
    try {
      // 面板模式：重复 TODO 展开为「下一个未完成实例 + 已完成实例」，已完成的不再消失
      const result = await cal.listTodos({ expand_instances: true })
      if (Array.isArray(result)) setTodos(result as CalendarTodo[])
    } catch (err) {
      console.error('Failed to load todos:', err)
    } finally {
      setLoadingTodos(false)
    }
  }, [setTodos, setLoadingTodos])

  const refreshTodoInstances = useCallback(async () => {
    setLoadingTodoInstances(true)
    try {
      const range = getViewRange(view, currentDate)
      const result = await cal.listTodoInstances(range)
      if (Array.isArray(result)) setTodoInstances(result as CalendarTodoInstance[])
    } catch (err) {
      console.error('Failed to load todo instances:', err)
    } finally {
      setLoadingTodoInstances(false)
    }
  }, [view, currentDate, setTodoInstances, setLoadingTodoInstances])

  const refreshStats = useCallback(async () => {
    try {
      const result = await cal.todoStats()
      if (result && !result.error) setStats(result as CalendarTodoStats)
    } catch (err) {
      console.error('Failed to load todo stats:', err)
    }
  }, [setStats])

  const refreshSettings = useCallback(async () => {
    try {
      const result = await cal.getSettings()
      if (result && !result.error) setSettings(result as CalendarSettings)
    } catch (err) {
      console.error('Failed to load calendar settings:', err)
    }
  }, [setSettings])

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshEvents(), refreshTodos(), refreshTodoInstances(), refreshStats(), refreshSettings()])
  }, [refreshEvents, refreshTodos, refreshTodoInstances, refreshStats, refreshSettings])

  // 初次加载
  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // 视图 / 当前日期变化时刷新事件和 TODO 实例
  useEffect(() => {
    refreshEvents()
  }, [refreshEvents])

  useEffect(() => {
    refreshTodoInstances()
  }, [refreshTodoInstances])

  // 监听主进程推送的数据变更事件（含 agent 工具调用产生的变更）
  useEffect(() => {
    const unsubscribe = cal.onDataChanged((payload) => {
      if (payload.scope === 'event') refreshEvents()
      if (payload.scope === 'todo') {
        refreshTodos()
        refreshTodoInstances()
        refreshStats()
      }
      if (payload.scope === 'settings') refreshSettings()
    })
    return () => { unsubscribe() }
  }, [refreshEvents, refreshTodos, refreshTodoInstances, refreshStats, refreshSettings])

  // 事件操作
  const createEvent = useCallback(async (input: CreateEventInput) => {
    const result = await cal.createEvent(input)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  const updateEvent = useCallback(async (input: UpdateEventInput) => {
    const result = await cal.updateEvent(input)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  const deleteEvent = useCallback(async (id: string) => {
    const result = await cal.deleteEvent(id)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  const deleteEventInstance = useCallback(async (params: DeleteEventInstanceParams) => {
    const result = await cal.deleteEventInstance(params)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  // TODO 操作
  const createTodo = useCallback(async (input: CreateTodoInput) => {
    const result = await cal.createTodo(input)
    if (result && !result.error) {
      await refreshTodos()
      await refreshTodoInstances()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshTodoInstances, refreshStats])

  const updateTodo = useCallback(async (input: UpdateTodoInput) => {
    const result = await cal.updateTodo(input)
    if (result && !result.error) {
      await refreshTodos()
      await refreshTodoInstances()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshTodoInstances, refreshStats])

  const deleteTodo = useCallback(async (id: string) => {
    const result = await cal.deleteTodo(id)
    if (result && !result.error) {
      await refreshTodos()
      await refreshTodoInstances()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshTodoInstances, refreshStats])

  const deleteTodoInstance = useCallback(async (params: DeleteTodoInstanceParams) => {
    const result = await cal.deleteTodoInstance(params)
    if (result && !result.error) {
      await refreshTodos()
      await refreshTodoInstances()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshTodoInstances, refreshStats])

  const completeTodo = useCallback(async (id: string, completed: boolean, instance_due_at?: number) => {
    const result = await cal.completeTodo(id, completed, instance_due_at)
    if (result && !result.error) {
      await refreshTodos()
      await refreshTodoInstances()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshTodoInstances, refreshStats])

  const saveSettings = useCallback(async (partial: Partial<CalendarSettings>) => {
    const result = await cal.setSettings(partial)
    if (result && !result.error) setSettings(result as CalendarSettings)
    return result
  }, [setSettings])

  return {
    events, todos, todoInstances, stats, settings, view, currentDate, filters,
    loadingEvents, loadingTodos, loadingTodoInstances,
    setView, setCurrentDate, setFilters,
    refreshAll, refreshEvents, refreshTodos, refreshTodoInstances, refreshStats, refreshSettings,
    createEvent, updateEvent, deleteEvent, deleteEventInstance,
    createTodo, updateTodo, deleteTodo, deleteTodoInstance, completeTodo, saveSettings,
  }
}
