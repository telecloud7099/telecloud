import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useStore } from '../store'
import { abortUploadSession } from '../api/client'
import { fmtSpeed, fmtEta, fmtElapsed } from '../utils/format'
import ConfirmModal from './ConfirmModal'

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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // A chunked upload still in flight (or paused/recovered) has a real server-side session
  // backing it — dismissing it without aborting that session just hides the widget; the
  // session survives and reattaches on the next dashboard load, looking like it "came back".
  // Only these need a confirm-and-abort; a finished/errored entry or a small single-shot
  // batch upload has no resumable session to lose, so those still dismiss immediately.
  function hasLiveSession(u: { status: string; phase: string }) {
    return u.status === 'uploading' && u.phase !== 'batch'
  }

  function requestDismiss(u: { id: string; status: string; phase: string }) {
    if (hasLiveSession(u)) {
      setConfirmDeleteId(u.id)
    } else {
      removeUpload(u.id)
    }
  }

  async function confirmDismiss() {
    const id = confirmDeleteId
    setConfirmDeleteId(null)
    if (!id) return
    try {
      await abortUploadSession(id)
    } catch {
      toast.error('Failed to cancel upload — it may still be running')
    }
    removeUpload(id)
  }

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
                onClick={e => { e.stopPropagation(); requestDismiss(u) }}
                title={hasLiveSession(u) ? 'Cancel upload' : 'Dismiss'}
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
      {confirmDeleteId && (
        <ConfirmModal
          message="Cancel this upload? It cannot be resumed — any parts already sent will be removed."
          danger
          onConfirm={confirmDismiss}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  )
}
