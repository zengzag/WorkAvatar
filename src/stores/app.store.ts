import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Project, File, Employee, Skill, Conversation } from '../types'

interface AppState {
  projects: Project[]
  currentProjectId: string | null
  employees: Employee[]
  currentEmployeeId: string | null
  files: Record<string, File[]>
  skills: Record<string, Skill[]>
  conversations: Record<string, Conversation[]>
  loading: Record<string, boolean>
  error: string | null

  setLoading: (key: string, value: boolean) => void
  setError: (error: string | null) => void

  setProjects: (projects: Project[]) => void
  setCurrentProjectId: (id: string | null) => void
  addProject: (project: Project) => void
  updateProject: (id: string, data: Partial<Project>) => void
  removeProject: (id: string) => void

  setEmployees: (employees: Employee[]) => void
  setCurrentEmployeeId: (id: string | null) => void
  addEmployee: (employee: Employee) => void
  updateEmployee: (id: string, data: Partial<Employee>) => void
  removeEmployee: (id: string) => void

  setFiles: (projectId: string, files: File[]) => void
  addFile: (projectId: string, file: File) => void
  updateFile: (projectId: string, id: string, data: Partial<File>) => void
  removeFile: (projectId: string, id: string) => void

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
    projects: [],
    currentProjectId: null,
    employees: [],
    currentEmployeeId: null,
    files: {},
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

    setProjects: (projects) =>
      set((state) => {
        state.projects = projects
      }),

    setCurrentProjectId: (id) =>
      set((state) => {
        state.currentProjectId = id
      }),

    addProject: (project) =>
      set((state) => {
        state.projects.unshift(project)
      }),

    updateProject: (id, data) =>
      set((state) => {
        const index = state.projects.findIndex((p) => p.id === id)
        if (index !== -1) {
          state.projects[index] = { ...state.projects[index], ...data }
        }
      }),

    removeProject: (id) =>
      set((state) => {
        state.projects = state.projects.filter((p) => p.id !== id)
        if (state.currentProjectId === id) {
          state.currentProjectId = null
        }
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

    setFiles: (projectId, files) =>
      set((state) => {
        state.files[projectId] = files
      }),

    addFile: (projectId, file) =>
      set((state) => {
        if (!state.files[projectId]) {
          state.files[projectId] = []
        }
        state.files[projectId].unshift(file)
      }),

    updateFile: (projectId, id, data) =>
      set((state) => {
        const files = state.files[projectId]
        if (files) {
          const index = files.findIndex((f) => f.id === id)
          if (index !== -1) {
            files[index] = { ...files[index], ...data }
          }
        }
      }),

    removeFile: (projectId, id) =>
      set((state) => {
        if (state.files[projectId]) {
          state.files[projectId] = state.files[projectId].filter((f) => f.id !== id)
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
