import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { useStore } from '../store'
import {
  getMe, logout, listFolders, getFolderCounts, listFiles,
  listFilesInFolder, getFileStats, createFolder,
  moveFiles, deleteFiles, syncFiles,
} from '../api/client'
import type { TeleFile } from '../api/client'
import FolderGrid from '../components/FolderGrid'
import FileGrid from '../components/FileGrid'
import UploadZone from '../components/UploadZone'
import Gallery from '../components/Gallery'
import PreviewModal from '../components/PreviewModal'
import SearchBar from '../components/SearchBar'
import ConfirmModal from '../components/ConfirmModal'
import { formatSize } from '../components/FileCard'

const PAGE = 50

type Category = 'All' | 'Images' | 'Videos' | 'Audio' | 'Docs' | 'Archives'

const CATEGORIES: { id: Category; icon: string }[] = [
  { id: 'All',      icon: 'apps' },
  { id: 'Images',   icon: 'image' },
  { id: 'Videos',   icon: 'movie' },
  { id: 'Audio',    icon: 'music_note' },
  { id: 'Docs',     icon: 'description' },
  { id: 'Archives', icon: 'folder_zip' },
]


export default function Dashboard() {
  const nav = useNavigate()
  const {
    phone, setPhone,
    folders, setFolders,
    setFiles, appendFiles,
    setHasMore,
    scanLimit, setScanLimit,
    selectedIds, clearSelection,
    view, setView,
    currentFolder, setCurrentFolder,
    setLoading,
  } = useStore()

  const [totalFiles, setTotalFiles] = useState(0)
  const [totalSize, setTotalSize] = useState(0)
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [scanWarning, setScanWarning] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [category, setCategory] = useState<Category>('All')
  const [offset, setOffset] = useState(0)
  const [gallery, setGallery] = useState<{ files: TeleFile[]; index: number } | null>(null)
  const [preview, setPreview] = useState<TeleFile | null>(null)
  const [confirmMove, setConfirmMove] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const loadGenRef = useRef(0)

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    getMe()
      .then(r => r.json())
      .then(d => {
        if (d.status !== 'success') { nav('/login'); return }
        setPhone(d.phone)
      })
      .catch(() => nav('/login'))

    loadFolders()
    loadStats()
    loadAllFiles(true)
  }, [])

  // ── Auto-poll every 60s for new Telegram files ────────────────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await syncFiles()
        const d = await res.json()
        if (d.new_files > 0) {
          toast.success(`${d.new_files} new file${d.new_files !== 1 ? 's' : ''} synced from Telegram`)
          loadAllFiles(true)
          loadFolders()
        }
      } catch { /* silent background poll */ }
    }, 60000)
    return () => clearInterval(id)
  }, [])

  // ── Manual sync ───────────────────────────────────────────────────────────
  async function handleSync() {
    setSyncing(true)
    try {
      const res = await syncFiles()
      const d = await res.json()
      if (d.new_files > 0) {
        toast.success(`${d.new_files} new file${d.new_files !== 1 ? 's' : ''} synced`)
        loadAllFiles(true)
        loadFolders()
      } else {
        toast.success('Already up to date')
      }
    } catch {
      toast.error('Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  async function loadFolders() {
    setFoldersLoading(true)
    try {
      const [fRes, cRes] = await Promise.all([listFolders(), getFolderCounts()])
      const fData = await fRes.json()
      const cData = await cRes.json()
      if (fData.status === 'success') {
        const counts: Record<string, number> = cData.status === 'success' ? cData.counts : {}
        setFolders(fData.folders.map((name: string) => ({ name, count: counts[name] ?? 0 })))
        if (cData.status === 'success') {
          setTotalFiles(cData.total_files ?? 0)
          setTotalSize(cData.total_size ?? 0)
        }
      }
    } catch {
      toast.error('Failed to load folders')
    } finally {
      setFoldersLoading(false)
    }
  }

  async function loadStats() {
    try {
      const res = await getFileStats()
      const d = await res.json()
      if (d.has_more === true) { setScanWarning(true); setScanLimit(d.scan_limit) }
    } catch { /* non-critical */ }
  }

  // ── Load files ────────────────────────────────────────────────────────────
  function cancelPending() {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
  }

  async function loadAllFiles(reset = false) {
    if (reset) cancelPending()
    const gen = ++loadGenRef.current
    setLoading(true)
    const off = reset ? 0 : offset
    const signal = abortRef.current?.signal
    try {
      const res = await listFiles({ offset: off, limit: PAGE, category, refresh: reset }, signal)
      const d = await res.json()
      if (loadGenRef.current !== gen) return
      if (d.status === 'success') {
        if (reset) setFiles(d.files); else appendFiles(d.files)
        setHasMore(d.has_more)
        setOffset(off + d.files.length)
      } else {
        toast.error(d.message || 'Failed to load files')
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      toast.error('Failed to load files')
    } finally {
      if (loadGenRef.current === gen) setLoading(false)
    }
  }

  async function loadFolderFiles(name: string) {
    cancelPending()
    setLoading(true)
    try {
      const res = await listFilesInFolder(name)
      const d = await res.json()
      if (d.status === 'success') {
        setFiles(d.files)
        setHasMore(false)
        setOffset(d.files.length)
      } else {
        toast.error(d.message || 'Failed to load folder')
      }
    } catch {
      toast.error('Failed to load folder')
    } finally {
      setLoading(false)
    }
  }

  function openFolder(name: string) {
    clearSelection()
    setFiles([])
    setOffset(0)
    setCurrentFolder(name)
    setView('folder')
    loadFolderFiles(name)
  }

  function openAllFiles() {
    cancelPending()
    clearSelection()
    setFiles([])
    setOffset(0)
    setView('all')
    loadAllFiles(true)
  }

  // Re-load when category changes in All view
  useEffect(() => {
    if (view === 'all') {
      setFiles([])
      setOffset(0)
      loadAllFiles(true)
    }
  }, [category])

  // ── Create folder ─────────────────────────────────────────────────────────
  async function submitNewFolder(e: React.FormEvent) {
    e.preventDefault()
    const name = newFolderName.trim()
    if (!name) return
    try {
      const res = await createFolder(name)
      const d = await res.json()
      if (d.status === 'success') {
        setFolders([...folders, { name, count: 0 }])
        setNewFolderName('')
        setShowNewFolder(false)
        toast.success(`Folder "${name}" created`)
      } else {
        toast.error(d.message || 'Failed to create folder')
      }
    } catch {
      toast.error('Network error')
    }
  }

  // ── Move / Delete ─────────────────────────────────────────────────────────
  async function handleMove(targetFolder: string) {
    const ids = new Set(selectedIds)
    const idList = [...ids]

    // Optimistic: remove moved files from view immediately
    const snapshot = [...useStore.getState().files]
    if (view === 'folder' || view === 'all') {
      setFiles(snapshot.filter(f => !ids.has(f.id)))
    }
    clearSelection()
    setConfirmMove(null)

    try {
      const res = await moveFiles(targetFolder, idList)
      const d = await res.json()
      if (d.status === 'success') {
        toast.success(`Moved ${idList.length} file${idList.length !== 1 ? 's' : ''} to "${targetFolder}"`)
        loadFolders()
      } else {
        setFiles(snapshot) // restore on failure
        toast.error(d.message || 'Move failed')
      }
    } catch {
      setFiles(snapshot)
      toast.error('Network error')
    }
  }

  async function handleDelete() {
    const ids = new Set(selectedIds)
    const idList = [...ids]

    // Optimistic: remove files from view immediately
    const snapshot = [...useStore.getState().files]
    setFiles(snapshot.filter(f => !ids.has(f.id)))
    clearSelection()
    setConfirmDelete(false)

    try {
      const res = await deleteFiles(idList)
      const d = await res.json()
      if (d.status === 'success') {
        toast.success(`Deleted ${idList.length} file${idList.length !== 1 ? 's' : ''}`)
        loadFolders()
      } else {
        setFiles(snapshot) // restore on failure
        toast.error(d.message || 'Delete failed')
      }
    } catch {
      setFiles(snapshot)
      toast.error('Network error')
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  async function handleLogout() {
    await logout()
    nav('/login')
  }

  const showingFiles = view === 'all' || view === 'folder' || view === 'search'

  return (
    <>
      <Toaster position="bottom-right" richColors />

      <div className="app-shell">
        {/* ── Header ── */}
        <header className="app-header">
          <div className="header-left">
            <span className="material-symbols-rounded" style={{ color: 'var(--accent)', fontSize: '1.6rem' }}>cloud</span>
            <span className="header-title">TeleCloud</span>
          </div>
          <div className="header-right">
            {phone && <span className="header-phone">{phone}</span>}
            <button className="icon-btn" title="Sync from Telegram" onClick={handleSync} disabled={syncing}>
              <span className="material-symbols-rounded" style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }}>sync</span>
            </button>
            <button className="icon-btn" title="Logout" onClick={handleLogout}>
              <span className="material-symbols-rounded">logout</span>
            </button>
          </div>
        </header>

        <div className="app-body">
          {/* ── Sidebar ── */}
          <nav className="sidebar">
            <button
              className={`sidebar-item${view === 'folders' ? ' active' : ''}`}
              onClick={() => { setView('folders'); clearSelection() }}
            >
              <span className="material-symbols-rounded">folder_open</span> Folders
            </button>
            <button
              className={`sidebar-item${view === 'all' ? ' active' : ''}`}
              onClick={openAllFiles}
            >
              <span className="material-symbols-rounded">grid_view</span> All Files
            </button>
            <button
              className={`sidebar-item${view === 'search' ? ' active' : ''}`}
              onClick={() => { cancelPending(); setView('search'); setFiles([]) }}
            >
              <span className="material-symbols-rounded">search</span> Search
            </button>
            <hr className="sidebar-divider" />
            <button
              className="sidebar-item"
              onClick={() => { setView('folders'); clearSelection(); setShowNewFolder(v => !v) }}
            >
              <span className="material-symbols-rounded">create_new_folder</span> New Folder
            </button>
          </nav>

          {/* ── Main ── */}
          <main className="main-content">
            {/* Scan warning */}
            {scanWarning && (
              <div className="scan-warning">
                <span className="material-symbols-rounded">warning</span>
                Only the most recent {scanLimit.toLocaleString()} messages were scanned. Older files may not appear.
              </div>
            )}

            {/* Selection toolbar */}
            {selectedIds.size > 0 && (
              <div className="selection-bar">
                <span className="selection-count">
                  <span className="material-symbols-rounded" style={{ fontSize: '1rem' }}>check_circle</span>
                  {selectedIds.size} selected
                </span>
                <div className="selection-bar-actions">
                  {folders.length > 0 && (
                    <select
                      className="move-select"
                      value=""
                      onChange={e => { if (e.target.value) setConfirmMove(e.target.value) }}
                    >
                      <option value="">Move to folder…</option>
                      {folders.map(f => (
                        <option key={f.name} value={f.name}>{f.name}</option>
                      ))}
                    </select>
                  )}
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(true)}>
                    <span className="material-symbols-rounded" style={{ fontSize: '1rem' }}>delete</span>
                    Delete
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={clearSelection}>
                    Deselect all
                  </button>
                </div>
              </div>
            )}

            {/* ── Folders view ── */}
            {view === 'folders' && (
              <>
                <div className="view-header">
                  <div className="view-title">
                    <span className="material-symbols-rounded">folder_open</span>
                    Folders
                  </div>
                  {totalFiles > 0 && (
                    <span className="view-meta">{totalFiles} files · {formatSize(totalSize)}</span>
                  )}
                </div>

                {showNewFolder && (
                  <form onSubmit={submitNewFolder} className="inline-form">
                    <input
                      className="form-input"
                      placeholder="Folder name"
                      value={newFolderName}
                      onChange={e => setNewFolderName(e.target.value)}
                      autoFocus
                    />
                    <button className="btn btn-primary btn-sm" type="submit">Create</button>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowNewFolder(false)}>Cancel</button>
                  </form>
                )}

                <FolderGrid onFolderClick={openFolder} loading={foldersLoading} />

                <div className="view-header" style={{ marginTop: '2rem' }}>
                  <div className="view-title">
                    <span className="material-symbols-rounded">upload_file</span>
                    Upload
                  </div>
                </div>
                <UploadZone onUploaded={loadFolders} />
              </>
            )}

            {/* ── All files view ── */}
            {view === 'all' && (
              <>
                <div className="view-header">
                  <div className="view-title">
                    <span className="material-symbols-rounded">grid_view</span>
                    All Files
                  </div>
                  {totalFiles > 0 && (
                    <span className="view-meta">{totalFiles} files · {formatSize(totalSize)}</span>
                  )}
                </div>
                <div className="tab-bar">
                  {CATEGORIES.map(({ id, icon }) => (
                    <button
                      key={id}
                      className={`tab-item${category === id ? ' active' : ''}`}
                      onClick={() => setCategory(id)}
                    >
                      <span className="material-symbols-rounded">{icon}</span>
                      {id}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ── Folder content view ── */}
            {view === 'folder' && (
              <div className="breadcrumb">
                <button className="btn btn-sm btn-ghost" onClick={() => { setView('folders'); clearSelection() }}>
                  <span className="material-symbols-rounded" style={{ fontSize: '1rem' }}>arrow_back</span>
                  Folders
                </button>
                <span className="material-symbols-rounded breadcrumb-sep">chevron_right</span>
                <span className="breadcrumb-current">{currentFolder}</span>
              </div>
            )}

            {/* ── Search view ── */}
            {view === 'search' && (
              <>
                <div className="view-header">
                  <div className="view-title">
                    <span className="material-symbols-rounded">search</span>
                    Search
                  </div>
                </div>
                <SearchBar onResults={() => {}} />
              </>
            )}

            {/* File grid */}
            {showingFiles && (
              <FileGrid
                onOpenGallery={(imgs, idx) => setGallery({ files: imgs, index: idx })}
                onOpenPreview={file => setPreview(file)}
                onLoadMore={() => loadAllFiles()}
              />
            )}
          </main>
        </div>

        {/* ── Bottom nav (mobile only) ── */}
        <nav className="bottom-nav">
          <button
            className={`bottom-nav-item${view === 'folders' ? ' active' : ''}`}
            onClick={() => { setView('folders'); clearSelection() }}
          >
            <span className="material-symbols-rounded">folder_open</span>
            <span>Folders</span>
          </button>
          <button
            className={`bottom-nav-item${view === 'all' ? ' active' : ''}`}
            onClick={openAllFiles}
          >
            <span className="material-symbols-rounded">grid_view</span>
            <span>All Files</span>
          </button>
          <button
            className={`bottom-nav-item${view === 'search' ? ' active' : ''}`}
            onClick={() => { cancelPending(); setView('search'); setFiles([]) }}
          >
            <span className="material-symbols-rounded">search</span>
            <span>Search</span>
          </button>
          <button
            className="bottom-nav-item"
            onClick={() => { setView('folders'); clearSelection(); setShowNewFolder(v => !v) }}
          >
            <span className="material-symbols-rounded">create_new_folder</span>
            <span>New Folder</span>
          </button>
        </nav>
      </div>

      {/* Modals */}
      {gallery && (
        <Gallery
          files={gallery.files}
          initialIndex={gallery.index}
          onClose={() => setGallery(null)}
        />
      )}
      {preview && (
        <PreviewModal file={preview} onClose={() => setPreview(null)} />
      )}
      {confirmMove && (
        <ConfirmModal
          message={`Move ${selectedIds.size} file${selectedIds.size !== 1 ? 's' : ''} to "${confirmMove}"?`}
          onConfirm={() => handleMove(confirmMove)}
          onCancel={() => setConfirmMove(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          message={`Permanently delete ${selectedIds.size} file${selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`}
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}
