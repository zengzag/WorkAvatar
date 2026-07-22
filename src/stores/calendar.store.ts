import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoStats,
  CalendarSettings,
} from '../../electron/shared/ipc-channels'
import type { TodoFilters } from '../types/calendar'

export type { TodoFilters } from '../types/calendar'
export type CalendarView = 'month' | 'week' | 'day'

interface CalendarState {
  events: CalendarEventInstance[]
  todos: CalendarTodo[]
  stats: CalendarTodoStats | null
  settings: CalendarSettings | null
  view: CalendarView
  currentDate: number // unix ms
  filters: TodoFilters
  loadingEvents: boolean
  loadingTodos: boolean
}

interface CalendarActions {
  setEvents: (events: CalendarEventInstance[]) => void
  setTodos: (todos: CalendarTodo[]) => void
  setStats: (stats: CalendarTodoStats) => void
  setSettings: (settings: CalendarSettings) => void
  setView: (view: CalendarView) => void
  setCurrentDate: (date: number) => void
  setFilters: (filters: Partial<TodoFilters>) => void
  setLoadingEvents: (loading: boolean) => void
  setLoadingTodos: (loading: boolean) => void
}

const initialState: CalendarState = {
  events: [],
  todos: [],
  stats: null,
  settings: null,
  view: 'week',
  currentDate: Date.now(),
  filters: {},
  loadingEvents: false,
  loadingTodos: false,
}

export const useCalendarStore = create<CalendarState & CalendarActions>()(
  immer((set) => ({
    ...initialState,

    setEvents: (events) => set((s) => { s.events = events }),
    setTodos: (todos) => set((s) => { s.todos = todos }),
    setStats: (stats) => set((s) => { s.stats = stats }),
    setSettings: (settings) => set((s) => { s.settings = settings }),
    setView: (view) => set((s) => { s.view = view }),
    setCurrentDate: (date) => set((s) => { s.currentDate = date }),
    setFilters: (filters) => set((s) => { s.filters = { ...s.filters, ...filters } }),
    setLoadingEvents: (loading) => set((s) => { s.loadingEvents = loading }),
    setLoadingTodos: (loading) => set((s) => { s.loadingTodos = loading }),
  }))
)
