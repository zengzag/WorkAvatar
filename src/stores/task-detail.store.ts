import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

interface TaskDetailState {
  open: boolean
  docId: string | null
  docName: string
  openDetail: (docId: string, docName: string) => void
  closeDetail: () => void
}

export const useTaskDetailStore = create<TaskDetailState>()(
  immer((set) => ({
    open: false,
    docId: null,
    docName: '',

    openDetail: (docId, docName) =>
      set((state) => {
        state.open = true
        state.docId = docId
        state.docName = docName
      }),

    closeDetail: () =>
      set((state) => {
        state.open = false
        state.docId = null
        state.docName = ''
      }),
  }))
)
