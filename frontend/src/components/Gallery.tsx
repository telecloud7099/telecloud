import { useEffect, useRef, useState } from 'react'
import { thumbnailUrl, fileUrl } from '../api/client'
import type { TeleFile } from '../api/client'

interface Props {
  files: TeleFile[]
  initialIndex: number
  onClose: () => void
}

export default function Gallery({ files, initialIndex, onClose }: Props) {
  const [index, setIndex] = useState(initialIndex)
  const [fullRes, setFullRes] = useState(false)
  const [imgError, setImgError] = useState(false)
  const touchStartX = useRef<number | null>(null)

  const file = files[index]

  useEffect(() => {
    setFullRes(false)
    setImgError(false)
  }, [index])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, files.length])

  function prev() { setIndex(i => (i - 1 + files.length) % files.length) }
  function next() { setIndex(i => (i + 1) % files.length) }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    if (Math.abs(dx) > 50) dx < 0 ? next() : prev()
    touchStartX.current = null
  }

  if (!file) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="gallery-box" onClick={e => e.stopPropagation()}>
        <button className="gallery-close icon-btn" onClick={onClose}>
          <span className="material-symbols-rounded">close</span>
        </button>

        <button className="gallery-nav left" onClick={prev} disabled={files.length <= 1}>
          <span className="material-symbols-rounded">chevron_left</span>
        </button>

        <div
          className="gallery-img-wrap"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {imgError ? (
            <div className="gallery-fallback">
              <span className="material-symbols-rounded">broken_image</span>
              <span>Image unavailable</span>
            </div>
          ) : (
            <img
              className="gallery-img"
              src={fullRes ? fileUrl(file.id) : thumbnailUrl(file.id)}
              alt={file.name}
              onClick={() => setFullRes(true)}
              onError={() => setImgError(true)}
              title={fullRes ? '' : 'Click for full resolution'}
            />
          )}
        </div>

        <button className="gallery-nav right" onClick={next} disabled={files.length <= 1}>
          <span className="material-symbols-rounded">chevron_right</span>
        </button>

        <div className="gallery-footer">
          <span className="gallery-filename">{file.name}</span>
          <span className="gallery-counter">{index + 1} / {files.length}</span>
          <a className="icon-btn" href={fileUrl(file.id, true)} title="Download" onClick={e => e.stopPropagation()}>
            <span className="material-symbols-rounded">download</span>
          </a>
        </div>
      </div>
    </div>
  )
}
