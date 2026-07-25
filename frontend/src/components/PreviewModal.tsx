import { useEffect, useState } from 'react'
import { fileUrl } from '../api/client'
import type { TeleFile } from '../api/client'
import { formatSize } from './FileCard'

interface Props {
  file: TeleFile
  onClose: () => void
}

export default function PreviewModal({ file, onClose }: Props) {
  const [loaded, setLoaded] = useState(false)
  const isMobile = window.innerWidth <= 768

  const isVideo = file.mime_type.startsWith('video/')
  const isAudio = file.mime_type.startsWith('audio/')
  const isPdf   = file.mime_type.includes('pdf')

  useEffect(() => {
    // Mobile PDF needs no async loading — show immediately
    setLoaded(isMobile && isPdf)
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [file.id])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box preview-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="preview-header">
          <span className="material-symbols-rounded preview-icon">
            {isVideo ? 'movie' : isAudio ? 'music_note' : 'picture_as_pdf'}
          </span>
          <div className="preview-header-info">
            <span className="preview-filename">{file.name}</span>
            {file.size > 0 && (
              <span className="preview-filesize">{formatSize(file.size)}</span>
            )}
          </div>
          <a className="icon-btn" href={fileUrl(file.id, true)} title="Download" onClick={e => e.stopPropagation()}>
            <span className="material-symbols-rounded">download</span>
          </a>
          <button className="icon-btn" onClick={onClose} title="Close">
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="preview-body">
          {/* Loading spinner shown until media is ready */}
          {!loaded && (
            <div className="preview-loading">
              <span className="material-symbols-rounded spin">progress_activity</span>
            </div>
          )}

          {isVideo && (
            <video
              src={fileUrl(file.id)}
              controls
              autoPlay
              className="preview-video"
              style={{ display: loaded ? 'block' : 'none' }}
              onCanPlay={() => setLoaded(true)}
            />
          )}

          {isAudio && (
            <div className="audio-wrap" style={{ display: loaded ? 'flex' : 'none' }}>
              <div className="audio-art">
                <span className="material-symbols-rounded">music_note</span>
              </div>
              <div className="audio-info">
                <div className="audio-title">{file.name.replace(/\.[^.]+$/, '')}</div>
                {file.size > 0 && <div className="audio-meta">{formatSize(file.size)}</div>}
              </div>
              <audio
                src={fileUrl(file.id)}
                controls
                autoPlay
                style={{ width: '100%' }}
                onCanPlay={() => setLoaded(true)}
              />
            </div>
          )}

          {isPdf && (
            isMobile ? (
              // iframes don't work well on mobile browsers — open in tab instead
              <div className="pdf-mobile" style={{ display: loaded ? 'flex' : 'none' }}>
                <span className="material-symbols-rounded pdf-mobile-icon">picture_as_pdf</span>
                <p className="pdf-mobile-name">{file.name}</p>
                <a
                  href={fileUrl(file.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                  onClick={() => setLoaded(true)}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '1rem' }}>open_in_new</span>
                  Open PDF
                </a>
              </div>
            ) : (
              <iframe
                src={fileUrl(file.id)}
                className="preview-pdf"
                title={file.name}
                sandbox=""
                style={{ display: loaded ? 'block' : 'none' }}
                onLoad={() => setLoaded(true)}
              />
            )
          )}
        </div>
      </div>
    </div>
  )
}

