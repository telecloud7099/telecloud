import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TeleFile, Folder } from '../api/client'

export type View = 'folders' | 'all' | 'folder' | 'search'

// How long a finished (done/error) upload widget entry lingers before auto-dismissing.
export const WIDGET_LINGER_MS = 4000

export interface UploadItem {
  id: string
  fileName: string
  folderName: string
  status: 'uploading' | 'done' | 'error'
  phase: 'batch' | 'sending' | 'telegram' | 'finalizing' | 'paused'
  pct: number
  speedBps?: number
  etaSeconds?: number
  partNumber?: number
  totalParts?: number
  /** epoch ms — when this upload (or, for a recovered session, the reattachment) began.
   * Drives the widget's live elapsed-time display. */
  startedAt: number
  /** True for a chunked session reattached after a page refresh — the backend session is
   * live and being watched, but nothing in this tab is driving it until the user re-picks
   * the same file. */
  recovered?: boolean
  error?: string
}

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
  selectedIds: Set<string>
  toggleSelect: (id: string) => void
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

  // Uploads in progress — drives the persistent upload widget
  uploads: UploadItem[]
  addUpload: (item: UploadItem) => void
  updateUpload: (id: string, patch: Partial<UploadItem>) => void
  removeUpload: (id: string) => void
  renameUploadId: (oldId: string, newId: string) => void
}

export const useStore = create<AppState>()(persist((set) => ({
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

  uploads: [],
  addUpload: (item) =>
    set((s) => ({
      // Upsert — a recovered (post-refresh) session and a freshly-initiated one for the
      // same session id must merge into one widget entry, not duplicate.
      uploads: s.uploads.some((u) => u.id === item.id)
        ? s.uploads.map((u) => (u.id === item.id ? { ...u, ...item } : u))
        : [...s.uploads, item],
    })),
  updateUpload: (id, patch) =>
    set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u)) })),
  removeUpload: (id) => set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) })),
  renameUploadId: (oldId, newId) =>
    set((s) => ({ uploads: s.uploads.map((u) => (u.id === oldId ? { ...u, id: newId } : u)) })),
}), {
  name: 'tc_dashboard_view',
  // Only the current view + folder survive a refresh — everything else (files,
  // uploads, selection) is re-fetched or is inherently transient.
  partialize: (s) => ({ view: s.view, currentFolder: s.currentFolder }),
}))
