import { create } from 'zustand'
import type { TeleFile, Folder } from '../api/client'

export type View = 'folders' | 'all' | 'folder' | 'search'

interface AppState {
  // Auth
  phone: string
  setPhone: (phone: string) => void

  // Folders
  folders: Folder[]
  setFolders: (folders: Folder[]) => void
  currentFolder: string | null
  setCurrentFolder: (name: string | null) => void

  // Files
  files: TeleFile[]
  setFiles: (files: TeleFile[]) => void
  appendFiles: (files: TeleFile[]) => void
  hasMore: boolean
  setHasMore: (v: boolean) => void
  scanLimit: number
  setScanLimit: (n: number) => void
  scanned: number | null
  setScanned: (n: number | null) => void

  // Selection
  selectedIds: Set<number>
  toggleSelect: (id: number) => void
  selectAll: () => void
  clearSelection: () => void

  // View
  view: View
  setView: (v: View) => void
  searchQuery: string
  setSearchQuery: (q: string) => void

  // Loading
  isLoading: boolean
  setLoading: (v: boolean) => void
}

export const useStore = create<AppState>((set) => ({
  phone: '',
  setPhone: (phone) => set({ phone }),

  folders: [],
  setFolders: (folders) => set({ folders }),
  currentFolder: null,
  setCurrentFolder: (name) => set({ currentFolder: name }),

  files: [],
  setFiles: (files) => set({ files }),
  appendFiles: (incoming) => set((s) => ({ files: [...s.files, ...incoming] })),
  hasMore: false,
  setHasMore: (v) => set({ hasMore: v }),
  scanLimit: 2000,
  setScanLimit: (n) => set({ scanLimit: n }),
  scanned: null,
  setScanned: (n) => set({ scanned: n }),

  selectedIds: new Set(),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds)
      next.has(id) ? next.delete(id) : next.add(id)
      return { selectedIds: next }
    }),
  selectAll: () =>
    set((s) => ({ selectedIds: new Set(s.files.map((f) => f.id)) })),
  clearSelection: () => set({ selectedIds: new Set() }),

  view: 'folders',
  setView: (v) => set({ view: v, selectedIds: new Set() }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  isLoading: false,
  setLoading: (v) => set({ isLoading: v }),
}))
