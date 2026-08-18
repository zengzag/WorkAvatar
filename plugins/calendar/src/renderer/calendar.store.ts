import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  CalendarEventInstance,
  CalendarTodo,
  CalendarTodoInstance,
  CalendarTodoStats,
  CalendarSettings,
  TodoFilters,
  CalendarView,
} from './types'

export type { TodoFilters, CalendarView }

interface CalendarState {
  events: CalendarEventInstance[]
  todos: CalendarTodo[]
  todoInstances: CalendarTodoInstance[]
  stats: CalendarTodoStats | null
  settings: CalendarSettings | null
  view: CalendarView
  currentDate: number // unix ms
  filters: TodoFilters
  loadingEvents: boolean
  loadingTodos: boolean
  loadingTodoInstances: boolean
}

interface CalendarActions {
  setEvents: (events: CalendarEventInstance[]) => void
  setTodos: (todos: CalendarTodo[]) => void
  setTodoInstances: (instances: CalendarTodoInstance[]) => void
  setStats: (stats: CalendarTodoStats) => void
  setSettings: (settings: CalendarSettings) => void
  setView: (view: CalendarView) => void
  setCurrentDate: (date: number) => void
  setFilters: (filters: Partial<TodoFilters>) => void
  setLoadingEvents: (loading: boolean) => void
  setLoadingTodos: (loading: boolean) => void
  setLoadingTodoInstances: (loading: boolean) => void
}

const initialState: CalendarState = {
  events: [],
  todos: [],
  todoInstances: [],
  stats: null,
  settings: null,
  view: 'week',
  currentDate: Date.now(),
  filters: {},
  loadingEvents: false,
  loadingTodos: false,
  loadingTodoInstances: false,
}

export const useCalendarStore = create<CalendarState & CalendarActions>()(
  immer((set) => ({
    ...initialState,

    setEvents: (events) => set((s) => { s.events = events }),
    setTodos: (todos) => set((s) => { s.todos = todos }),
    setTodoInstances: (instances) => set((s) => { s.todoInstances = instances }),
    setStats: (stats) => set((s) => { s.stats = stats }),
    setSettings: (settings) => set((s) => { s.settings = settings }),
    setView: (view) => set((s) => { s.view = view }),
    setCurrentDate: (date) => set((s) => { s.currentDate = date }),
    setFilters: (filters) => set((s) => { s.filters = { ...s.filters, ...filters } }),
    setLoadingEvents: (loading) => set((s) => { s.loadingEvents = loading }),
    setLoadingTodos: (loading) => set((s) => { s.loadingTodos = loading }),
    setLoadingTodoInstances: (loading) => set((s) => { s.loadingTodoInstances = loading }),
  }))
)
