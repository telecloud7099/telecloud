import { useState } from 'react'
import { toast } from 'sonner'
import { useStore } from '../store'
import { renameFolder, deleteFolder } from '../api/client'
import ConfirmModal from './ConfirmModal'
import type { Folder } from '../api/client'

interface FolderCardProps {
  folder: Folder
  onClick: () => void
}

function FolderCard({ folder, onClick }: FolderCardProps) {
  const { folders, setFolders } = useStore()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(folder.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  async function saveRename() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === folder.name) {
      setEditing(false)
      setName(folder.name)
      return
    }
    setSaving(true)
    try {
      const res = await renameFolder(folder.name, trimmed)
      const d = await res.json()
      if (d.status === 'success') {
        setFolders(folders.map(f => f.name === folder.name ? { ...f, name: trimmed } : f))
        toast.success(`Renamed to "${trimmed}"`)
      } else {
        toast.error(d.message || 'Rename failed')
        setName(folder.name)
      }
    } catch {
      toast.error('Network error')
      setName(folder.name)
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  async function confirmDeleteFolder() {
    try {
      const res = await deleteFolder(folder.name)
      const d = await res.json()
      if (d.status === 'success') {
        setFolders(folders.filter(f => f.name !== folder.name))
        toast.success(`"${folder.name}" removed`)
      } else {
        toast.error(d.message || 'Delete failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setConfirmDelete(false)
    }
  }

  return (
    <>
      <div className="card folder-card" onClick={!editing ? onClick : undefined}>
        <span className="material-symbols-rounded card-icon">folder</span>

        {editing ? (
          <input
            className="form-input rename-input"
            value={name}
            autoFocus
            disabled={saving}
            onChange={e => setName(e.target.value)}
            onBlur={saveRename}
            onKeyDown={e => {
              if (e.key === 'Enter') saveRename()
              if (e.key === 'Escape') { setEditing(false); setName(folder.name) }
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className="card-title">{folder.name}</div>
        )}

        {folder.count !== undefined && (
          <div className="card-meta">{folder.count} file{folder.count !== 1 ? 's' : ''}</div>
        )}

        <div className="card-actions" onClick={e => e.stopPropagation()}>
          <button
            className="icon-btn"
            title="Rename"
            onClick={() => setEditing(true)}
          >
            <span className="material-symbols-rounded">edit</span>
          </button>
          <button
            className="icon-btn danger"
            title="Delete folder"
            onClick={() => setConfirmDelete(true)}
          >
            <span className="material-symbols-rounded">delete</span>
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          message={`Remove folder "${folder.name}"? Files stay in Telegram.`}
          danger
          onConfirm={confirmDeleteFolder}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}

function FolderSkeleton() {
  return (
    <div className="card folder-card folder-card-skeleton" aria-hidden>
      <div className="skeleton-folder-icon" />
      <div className="skeleton-line" style={{ width: '65%' }} />
      <div className="skeleton-line" style={{ width: '35%', marginTop: 6 }} />
    </div>
  )
}

interface FolderGridProps {
  onFolderClick: (name: string) => void
  loading?: boolean
}

export default function FolderGrid({ onFolderClick, loading }: FolderGridProps) {
  const folders = useStore(s => s.folders)

  if (loading) {
    return (
      <div className="card-grid">
        {Array.from({ length: 6 }).map((_, i) => <FolderSkeleton key={i} />)}
      </div>
    )
  }

  if (folders.length === 0) {
    return (
      <div className="empty-state">
        <span className="material-symbols-rounded empty-state-icon">create_new_folder</span>
        <div className="empty-state-message">No folders yet</div>
        <div className="empty-state-hint">Use the "New Folder" button in the sidebar to get started.</div>
      </div>
    )
  }

  return (
    <div className="card-grid">
      {folders.map(f => (
        <FolderCard key={f.name} folder={f} onClick={() => onFolderClick(f.name)} />
      ))}
    </div>
  )
}
