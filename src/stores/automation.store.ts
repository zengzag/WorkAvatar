import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  AutomationTask,
  AutomationRun,
} from '../../electron/shared/ipc-channels'
import type { TaskFilters, RunFilters } from '../types/automation'

export type AutomationTab = 'tasks' | 'history'

interface AutomationState {
  tasks: AutomationTask[]
  runs: AutomationRun[]
  taskFilters: TaskFilters
  runFilters: RunFilters
  activeTab: AutomationTab
  loadingTasks: boolean
  loadingRuns: boolean
}

interface AutomationActions {
  setTasks: (tasks: AutomationTask[]) => void
  setRuns: (runs: AutomationRun[]) => void
  setTaskFilters: (filters: Partial<TaskFilters>) => void
  setRunFilters: (filters: Partial<RunFilters>) => void
  setActiveTab: (tab: AutomationTab) => void
  setLoadingTasks: (loading: boolean) => void
  setLoadingRuns: (loading: boolean) => void
  resetFilters: () => void
}

const initialState: AutomationState = {
  tasks: [],
  runs: [],
  taskFilters: {},
  runFilters: {},
  activeTab: 'tasks',
  loadingTasks: false,
  loadingRuns: false,
}

export const useAutomationStore = create<AutomationState & AutomationActions>()(
  immer((set) => ({
    ...initialState,

    setTasks: (tasks) => set((s) => { s.tasks = tasks }),
    setRuns: (runs) => set((s) => { s.runs = runs }),
    setTaskFilters: (filters) => set((s) => { s.taskFilters = { ...s.taskFilters, ...filters } }),
    setRunFilters: (filters) => set((s) => { s.runFilters = { ...s.runFilters, ...filters } }),
    setActiveTab: (tab) => set((s) => { s.activeTab = tab }),
    setLoadingTasks: (loading) => set((s) => { s.loadingTasks = loading }),
    setLoadingRuns: (loading) => set((s) => { s.loadingRuns = loading }),
    resetFilters: () => set((s) => { s.taskFilters = {}; s.runFilters = {} }),
  }))
)
