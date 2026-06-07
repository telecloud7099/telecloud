import { memo, useState } from 'react'
import type { TeleFile } from '../api/client'
import { fileUrl, thumbnailUrl } from '../api/client'
import { useLazyLoad } from '../hooks/useLazyLoad'

function fileIcon(mime: string): string {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'movie'
  if (mime.startsWith('audio/')) return 'music_note'
  if (mime.includes('pdf')) return 'picture_as_pdf'
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('7z')) return 'folder_zip'
  if (mime.includes('word') || mime.includes('document')) return 'description'
  if (mime.includes('sheet') || mime.includes('excel')) return 'table_chart'
  return 'draft'
}

interface Props {
  file: TeleFile
  selected: boolean
  onToggle: () => void
  onOpenGallery?: () => void
  onOpenPreview?: () => void
}

function FileCard({ file, selected, onToggle, onOpenGallery, onOpenPreview }: Props) {
  const [thumbError, setThumbError] = useState(false)
  const { ref, visible } = useLazyLoad()
  const isImage = file.mime_type.startsWith('image/')
  const isVideo = file.mime_type.startsWith('video/')
  const isAudio = file.mime_type.startsWith('audio/')
  const isPdf = file.mime_type.includes('pdf')
  const canPreview = isVideo || isAudio || isPdf

  function handleClick() {
    if (isImage && onOpenGallery) onOpenGallery()
    else if (canPreview && onOpenPreview) onOpenPreview()
    else onToggle()
  }

  return (
    <div
      className={`card file-card${selected ? ' selected' : ''}`}
      onClick={handleClick}
      ref={ref}
    >
      {/* Corner checkbox — appears on hover, always visible when selected */}
      <button
        className="card-select-check"
        onClick={e => { e.stopPropagation(); onToggle() }}
        title={selected ? 'Deselect' : 'Select'}
      >
        <span className="material-symbols-rounded">
          {selected ? 'check_circle' : 'radio_button_unchecked'}
        </span>
      </button>

      <div className="file-thumb">
        {isImage && !thumbError && visible ? (
          <img
            src={thumbnailUrl(file.id)}
            alt=""
            onError={() => setThumbError(true)}
          />
        ) : (
          <span className="material-symbols-rounded file-type-icon">
            {fileIcon(file.mime_type)}
          </span>
        )}
        {selected && (
          <div className="select-overlay" />
        )}
        {(isVideo || isAudio) && (
          <div className="media-badge">
            <span className="material-symbols-rounded">{isVideo ? 'play_circle' : 'music_note'}</span>
          </div>
        )}
      </div>

      <div className="file-info">
        <div className="file-name">{file.name}</div>
        <div className="card-meta">{formatSize(file.size)}</div>
      </div>

      <div className="card-actions" onClick={e => e.stopPropagation()}>
        <a
          className="icon-btn"
          href={fileUrl(file.id, true)}
          title="Download"
          onClick={e => e.stopPropagation()}
        >
          <span className="material-symbols-rounded">download</span>
        </a>
      </div>
    </div>
  )
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default memo(FileCard)
