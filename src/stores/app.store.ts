import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Employee, Skill, Conversation } from '../types'

interface AppState {
  employees: Employee[]
  currentEmployeeId: string | null
  skills: Record<string, Skill[]>
  conversations: Record<string, Conversation[]>
  loading: Record<string, boolean>
  error: string | null

  setLoading: (key: string, value: boolean) => void
  setError: (error: string | null) => void

  setEmployees: (employees: Employee[]) => void
  setCurrentEmployeeId: (id: string | null) => void
  addEmployee: (employee: Employee) => void
  updateEmployee: (id: string, data: Partial<Employee>) => void
  removeEmployee: (id: string) => void

  setSkills: (employeeId: string, skills: Skill[]) => void
  addSkill: (employeeId: string, skill: Skill) => void
  updateSkill: (employeeId: string, id: string, data: Partial<Skill>) => void
  removeSkill: (employeeId: string, id: string) => void

  setConversations: (employeeId: string, conversations: Conversation[]) => void
  addConversation: (employeeId: string, conversation: Conversation) => void
  updateConversation: (employeeId: string, id: string, data: Partial<Conversation>) => void
  removeConversation: (employeeId: string, id: string) => void
}

export const useAppStore = create<AppState>()(
  immer((set) => ({
    employees: [],
    currentEmployeeId: null,
    skills: {},
    conversations: {},
    loading: {},
    error: null,

    setLoading: (key, value) =>
      set((state) => {
        state.loading[key] = value
      }),

    setError: (error) =>
      set((state) => {
        state.error = error
      }),

    setEmployees: (employees) =>
      set((state) => {
        state.employees = employees
      }),

    setCurrentEmployeeId: (id) =>
      set((state) => {
        state.currentEmployeeId = id
      }),

    addEmployee: (employee) =>
      set((state) => {
        state.employees.unshift(employee)
      }),

    updateEmployee: (id, data) =>
      set((state) => {
        const index = state.employees.findIndex((e) => e.id === id)
        if (index !== -1) {
          state.employees[index] = { ...state.employees[index], ...data }
        }
      }),

    removeEmployee: (id) =>
      set((state) => {
        state.employees = state.employees.filter((e) => e.id !== id)
        if (state.currentEmployeeId === id) {
          state.currentEmployeeId = null
        }
      }),

    setSkills: (employeeId, skills) =>
      set((state) => {
        state.skills[employeeId] = skills
      }),

    addSkill: (employeeId, skill) =>
      set((state) => {
        if (!state.skills[employeeId]) {
          state.skills[employeeId] = []
        }
        state.skills[employeeId].push(skill)
      }),

    updateSkill: (employeeId, id, data) =>
      set((state) => {
        const skills = state.skills[employeeId]
        if (skills) {
          const index = skills.findIndex((s) => s.id === id)
          if (index !== -1) {
            skills[index] = { ...skills[index], ...data }
          }
        }
      }),

    removeSkill: (employeeId, id) =>
      set((state) => {
        if (state.skills[employeeId]) {
          state.skills[employeeId] = state.skills[employeeId].filter((s) => s.id !== id)
        }
      }),

    setConversations: (employeeId, conversations) =>
      set((state) => {
        state.conversations[employeeId] = conversations
      }),

    addConversation: (employeeId, conversation) =>
      set((state) => {
        if (!state.conversations[employeeId]) {
          state.conversations[employeeId] = []
        }
        state.conversations[employeeId].unshift(conversation)
      }),

    updateConversation: (employeeId, id, data) =>
      set((state) => {
        const conversations = state.conversations[employeeId]
        if (conversations) {
          const index = conversations.findIndex((c) => c.id === id)
          if (index !== -1) {
            conversations[index] = { ...conversations[index], ...data }
          }
        }
      }),

    removeConversation: (employeeId, id) =>
      set((state) => {
        if (state.conversations[employeeId]) {
          state.conversations[employeeId] = state.conversations[employeeId].filter(
            (c) => c.id !== id
          )
        }
      }),
  }))
)
