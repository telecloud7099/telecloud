import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { fmtSpeed, fmtEta, fmtElapsed } from '../utils/format'

interface Props {
  /** Navigate to where the file will land — a folder view, or All Files if none. */
  onNavigate: (folderName: string) => void
}

const PHASE_LABEL: Record<string, string> = {
  batch: 'Uploading',
  sending: 'Receiving file',
  telegram: 'Uploading to Telegram',
  finalizing: 'Finalizing',
  paused: 'Waiting',
}

export default function UploadWidget({ onNavigate }: Props) {
  const uploads = useStore(s => s.uploads)
  const removeUpload = useStore(s => s.removeUpload)

  // Elapsed time has to keep advancing even between progress updates (e.g. while paused,
  // or between sparse poll ticks on a recovered session) — a 1s clock forces that re-render.
  const [now, setNow] = useState(() => Date.now())
  const hasActive = uploads.some(u => u.status === 'uploading')
  useEffect(() => {
    if (!hasActive) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [hasActive])

  if (!uploads.length) return null

  return (
    <div className="upload-widget">
      <div className="upload-widget-header">
        <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>cloud_upload</span>
        Uploads
      </div>
      <div className="upload-widget-list">
        {uploads.map(u => (
          <div
            key={u.id}
            className={`upload-widget-item upload-widget-item-${u.status}${u.phase === 'paused' ? ' upload-widget-item-paused' : ''}`}
            onClick={() => onNavigate(u.folderName)}
            title="Go to this file's location"
          >
            <div className="upload-widget-item-top">
              <span className="material-symbols-rounded upload-widget-item-icon">
                {u.status === 'done' ? 'check_circle' : u.status === 'error' ? 'error' : u.phase === 'paused' ? 'pause_circle' : 'progress_activity'}
              </span>
              <span className="upload-widget-item-name">{u.fileName}</span>
              <button
                className="upload-widget-item-close"
                onClick={e => { e.stopPropagation(); removeUpload(u.id) }}
                title="Dismiss"
              >
                <span className="material-symbols-rounded">close</span>
              </button>
            </div>

            {u.status === 'uploading' && (
              <>
                <div className="progress-bar upload-widget-progress">
                  <div className="progress-fill" style={{ width: `${u.pct}%` }} />
                </div>
                <div className="upload-widget-item-meta">
                  {PHASE_LABEL[u.phase] ?? 'Uploading'}… {u.pct}%
                  {!!u.totalParts && u.totalParts > 1 && ` · Part ${u.partNumber} of ${u.totalParts}`}
                  {fmtSpeed(u.speedBps) && ` · ${fmtSpeed(u.speedBps)}`}
                  {fmtEta(u.etaSeconds) && ` · ETA ${fmtEta(u.etaSeconds)}`}
                </div>
                <div className="upload-widget-item-meta upload-widget-item-elapsed">
                  Elapsed {fmtElapsed(u.startedAt, now)}
                </div>
                {u.phase === 'paused' && (
                  <div className="upload-widget-item-meta upload-widget-item-hint">
                    {u.recovered
                      ? 'Reattach this file to resume — the upload is paused, not lost.'
                      : 'Waiting for the next part…'}
                  </div>
                )}
              </>
            )}
            {u.status === 'done' && (
              <div className="upload-widget-item-meta">Uploaded — click to view</div>
            )}
            {u.status === 'error' && (
              <div className="upload-widget-item-meta upload-widget-item-error">{u.error || 'Upload failed'}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
