import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

interface AppState {
  loading: Record<string, boolean>
  setLoading: (key: string, value: boolean) => void
}

export const useAppStore = create<AppState>()(
  immer((set) => ({
    loading: {},

    setLoading: (key, value) =>
      set((state) => {
        state.loading[key] = value
      }),
  }))
)
