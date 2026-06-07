import { useMemo, useState } from 'react'
import { useStore } from '../store'
import FileCard from './FileCard'
import type { TeleFile } from '../api/client'

type SortKey = 'date' | 'name' | 'size'
type SortDir = 'asc' | 'desc'

interface Props {
  onOpenGallery: (files: TeleFile[], index: number) => void
  onOpenPreview: (file: TeleFile) => void
  onLoadMore?: () => void
}

function FileCardSkeleton() {
  return (
    <div className="card file-card file-card-skeleton" aria-hidden>
      <div className="file-thumb skeleton-thumb" />
      <div className="file-info">
        <div className="skeleton-line" style={{ width: '80%' }} />
        <div className="skeleton-line" style={{ width: '45%', marginTop: 6 }} />
      </div>
    </div>
  )
}

const EMPTY_STATE_CONFIG = {
  all:    { icon: 'cloud_off',      message: 'No files yet',              hint: 'Files you send to Telegram Saved Messages will appear here.' },
  folder: { icon: 'folder_open',    message: 'This folder is empty',      hint: 'Move files here using the selection toolbar.' },
  search: { icon: 'search_off',     message: 'No results',                hint: 'Try a different search term.' },
}

export default function FileGrid({ onOpenGallery, onOpenPreview, onLoadMore }: Props) {
  const { files, selectedIds, toggleSelect, selectAll, clearSelection, isLoading, hasMore, view } = useStore()
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const imageFiles = useMemo(() => files.filter(f => f.mime_type.startsWith('image/')), [files])

  const sorted = useMemo(() => {
    const copy = [...files]
    copy.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortKey === 'size') cmp = a.size - b.size
      else cmp = (a.date ?? '').localeCompare(b.date ?? '')
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [files, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  // Initial load — show skeleton grid, no toolbar
  if (isLoading && files.length === 0) {
    return (
      <div className="card-grid file-grid">
        {Array.from({ length: 12 }).map((_, i) => <FileCardSkeleton key={i} />)}
      </div>
    )
  }

  // Empty state
  if (!isLoading && files.length === 0) {
    const cfg = EMPTY_STATE_CONFIG[view as keyof typeof EMPTY_STATE_CONFIG]
      ?? { icon: 'folder_open', message: 'No files found', hint: '' }
    return (
      <div className="empty-state">
        <span className="material-symbols-rounded empty-state-icon">{cfg.icon}</span>
        <div className="empty-state-message">{cfg.message}</div>
        {cfg.hint && <div className="empty-state-hint">{cfg.hint}</div>}
      </div>
    )
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="file-toolbar">
        <div className="file-toolbar-left">
          <button className="btn btn-sm btn-ghost" onClick={selectAll}>Select all</button>
          {selectedIds.size > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={clearSelection}>
              Deselect ({selectedIds.size})
            </button>
          )}
        </div>
        <div className="sort-controls">
          <span className="sort-label">Sort:</span>
          {(['date', 'name', 'size'] as SortKey[]).map(k => (
            <button
              key={k}
              className={`btn btn-sm btn-ghost${sortKey === k ? ' sort-active' : ''}`}
              onClick={() => toggleSort(k)}
            >
              {k}
              {sortKey === k && (
                <span className="material-symbols-rounded sort-arrow">
                  {sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="card-grid file-grid">
        {sorted.map(file => {
          const isImage = file.mime_type.startsWith('image/')
          const galleryIdx = isImage ? imageFiles.indexOf(file) : -1
          return (
            <FileCard
              key={file.id}
              file={file}
              selected={selectedIds.has(file.id)}
              onToggle={() => toggleSelect(file.id)}
              onOpenGallery={isImage ? () => onOpenGallery(imageFiles, galleryIdx) : undefined}
              onOpenPreview={!isImage ? () => onOpenPreview(file) : undefined}
            />
          )
        })}

        {/* Inline skeletons at bottom for "load more" */}
        {isLoading && Array.from({ length: 6 }).map((_, i) => <FileCardSkeleton key={`sk-${i}`} />)}
      </div>

      {!isLoading && hasMore && (
        <button className="btn btn-ghost load-more" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </div>
  )
}
