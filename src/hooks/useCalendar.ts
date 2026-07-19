import { useCallback, useEffect } from 'react'
import { useCalendarStore } from '../stores/calendar.store'
import type {
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoStats,
  CalendarSettings,
  CreateEventInput,
  UpdateEventInput,
  CreateTodoInput,
  UpdateTodoInput,
} from '../types/calendar'

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
    events, todos, stats, settings, view, currentDate, filters,
    loadingEvents, loadingTodos,
    setEvents, setTodos, setStats, setSettings, setView, setCurrentDate, setFilters,
    setLoadingEvents, setLoadingTodos,
  } = useCalendarStore()

  const refreshEvents = useCallback(async () => {
    setLoadingEvents(true)
    try {
      const range = getViewRange(view, currentDate)
      const result = await window.electronAPI.calendar.listEvents(range)
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
      const result = await window.electronAPI.calendar.listTodos({})
      if (Array.isArray(result)) setTodos(result as CalendarTodo[])
    } catch (err) {
      console.error('Failed to load todos:', err)
    } finally {
      setLoadingTodos(false)
    }
  }, [setTodos, setLoadingTodos])

  const refreshStats = useCallback(async () => {
    try {
      const result = await window.electronAPI.calendar.todoStats()
      if (result && !result.error) setStats(result as CalendarTodoStats)
    } catch (err) {
      console.error('Failed to load todo stats:', err)
    }
  }, [setStats])

  const refreshSettings = useCallback(async () => {
    try {
      const result = await window.electronAPI.calendar.getSettings()
      if (result && !result.error) setSettings(result as CalendarSettings)
    } catch (err) {
      console.error('Failed to load calendar settings:', err)
    }
  }, [setSettings])

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshEvents(), refreshTodos(), refreshStats(), refreshSettings()])
  }, [refreshEvents, refreshTodos, refreshStats, refreshSettings])

  // 初次加载
  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // 视图 / 当前日期变化时刷新事件
  useEffect(() => {
    refreshEvents()
  }, [refreshEvents])

  // 监听主进程推送的数据变更事件（含 agent 工具调用产生的变更）
  useEffect(() => {
    const unsubscribe = window.electronAPI.calendar.onDataChanged((payload) => {
      if (payload.scope === 'event') refreshEvents()
      if (payload.scope === 'todo') {
        refreshTodos()
        refreshStats()
      }
      if (payload.scope === 'settings') refreshSettings()
    })
    return () => { unsubscribe() }
  }, [refreshEvents, refreshTodos, refreshStats, refreshSettings])

  // 事件操作
  const createEvent = useCallback(async (input: CreateEventInput) => {
    const result = await window.electronAPI.calendar.createEvent(input)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  const updateEvent = useCallback(async (input: UpdateEventInput) => {
    const result = await window.electronAPI.calendar.updateEvent(input)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  const deleteEvent = useCallback(async (id: string) => {
    const result = await window.electronAPI.calendar.deleteEvent(id)
    if (result && !result.error) await refreshEvents()
    return result
  }, [refreshEvents])

  // TODO 操作
  const createTodo = useCallback(async (input: CreateTodoInput) => {
    const result = await window.electronAPI.calendar.createTodo(input)
    if (result && !result.error) {
      await refreshTodos()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshStats])

  const updateTodo = useCallback(async (input: UpdateTodoInput) => {
    const result = await window.electronAPI.calendar.updateTodo(input)
    if (result && !result.error) {
      await refreshTodos()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshStats])

  const deleteTodo = useCallback(async (id: string) => {
    const result = await window.electronAPI.calendar.deleteTodo(id)
    if (result && !result.error) {
      await refreshTodos()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshStats])

  const completeTodo = useCallback(async (id: string, completed: boolean) => {
    const result = await window.electronAPI.calendar.completeTodo(id, completed)
    if (result && !result.error) {
      await refreshTodos()
      await refreshStats()
    }
    return result
  }, [refreshTodos, refreshStats])

  const saveSettings = useCallback(async (partial: Partial<CalendarSettings>) => {
    const result = await window.electronAPI.calendar.setSettings(partial)
    if (result && !result.error) setSettings(result as CalendarSettings)
    return result
  }, [setSettings])

  return {
    events, todos, stats, settings, view, currentDate, filters,
    loadingEvents, loadingTodos,
    setView, setCurrentDate, setFilters,
    refreshAll, refreshEvents, refreshTodos, refreshStats, refreshSettings,
    createEvent, updateEvent, deleteEvent,
    createTodo, updateTodo, deleteTodo, completeTodo, saveSettings,
  }
}
