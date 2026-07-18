import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { uploadFiles, safeJson, makeSpeedTracker } from '../api/client'
import { uploadChunkedFile, NotChunkedError, type ChunkedUploadProgress } from '../api/chunkedUpload'
import { useStore, WIDGET_LINGER_MS } from '../store'
import type { UploadItem } from '../store'
import { fmtSpeed, fmtEta } from '../utils/format'

interface Props {
  onUploaded: () => void
}

// Files at or above this size go through the durable, resumable upload-session flow
// instead of a single plain POST — matches the backend's RESUMABLE_THRESHOLD. That's what
// lets an upload survive a page refresh and retry just the failed part on a network blip,
// rather than losing (or fully re-sending) the whole file. Below it, a file is small/quick
// enough that a full-request retry (see uploadFiles in client.ts) is cheap enough on its own.
const CHUNK_PROBE_THRESHOLD = 10 * 1024 * 1024

interface ChunkedFileProgress extends ChunkedUploadProgress {
  fileName: string
}

interface BatchProgress {
  pct: number
  speedBps?: number
  etaSeconds?: number
}

export default function UploadZone({ onUploaded }: Props) {
  const folders = useStore(s => s.folders)
  const addUpload = useStore(s => s.addUpload)
  const updateUpload = useStore(s => s.updateUpload)
  const removeUpload = useStore(s => s.removeUpload)
  const renameUploadId = useStore(s => s.renameUploadId)
  const [folder, setFolder] = useState('')
  const [pending, setPending] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<BatchProgress>({ pct: 0 })
  const [chunkedProgress, setChunkedProgress] = useState<ChunkedFileProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setPending([...e.dataTransfer.files])
  }

  function finishWidget(id: string, patch: Partial<UploadItem>) {
    updateUpload(id, patch)
    setTimeout(() => removeUpload(id), WIDGET_LINGER_MS)
  }

  async function uploadSmallBatch(files: File[]) {
    const widgetId = crypto.randomUUID()
    const label = files.length === 1 ? files[0].name : `${files.length} files`
    addUpload({ id: widgetId, fileName: label, folderName: folder, status: 'uploading', phase: 'batch', pct: 0, startedAt: Date.now() })

    const speedOf = makeSpeedTracker()
    let res: Response
    try {
      res = await uploadFiles(folder, files, (pct, loaded, total) => {
        const bps = speedOf(loaded)
        const etaSeconds = bps > 0 ? Math.round((total - loaded) / bps) : undefined
        setProgress({ pct, speedBps: bps || undefined, etaSeconds })
        updateUpload(widgetId, { pct, speedBps: bps || undefined, etaSeconds })
      })
    } catch (err) {
      finishWidget(widgetId, { status: 'error', error: 'Network error' })
      throw err
    }
    const d = await safeJson(res, 'Upload')

    const results: { name: string; success: boolean; error?: string }[] =
      d.results ?? (d.status === 'success' ? files.map(f => ({ name: f.name, success: true })) : [])

    const ok = results.filter(r => r.success).length
    const fail = results.filter(r => !r.success)

    if (ok > 0) toast.success(`${ok} file${ok !== 1 ? 's' : ''} uploaded`)
    fail.forEach(r => toast.error(`Failed: ${r.name}${r.error ? ` — ${r.error}` : ''}`))

    finishWidget(widgetId, fail.length && !ok
      ? { status: 'error', error: fail[0]?.error || 'Upload failed' }
      : { status: 'done', pct: 100 })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!pending.length) return
    setUploading(true)
    setProgress({ pct: 0 })
    setChunkedProgress(null)

    const smallFiles = pending.filter(f => f.size <= CHUNK_PROBE_THRESHOLD)
    const largeFiles = pending.filter(f => f.size > CHUNK_PROBE_THRESHOLD)

    try {
      if (smallFiles.length) {
        await uploadSmallBatch(smallFiles)
      }

      for (const f of largeFiles) {
        // Widget entry starts under a throwaway id; renamed to the real session id as
        // soon as one exists so a page refresh can find and reattach to the same entry.
        let activeId: string = crypto.randomUUID()
        addUpload({ id: activeId, fileName: f.name, folderName: folder, status: 'uploading', phase: 'sending', pct: 0, startedAt: Date.now() })
        try {
          await uploadChunkedFile(
            f, folder,
            p => {
              setChunkedProgress({ fileName: f.name, ...p })
              updateUpload(activeId, {
                phase: p.phase, pct: p.overallPct, speedBps: p.speedBps, etaSeconds: p.etaSeconds,
                partNumber: p.partNumber, totalParts: p.totalParts,
              })
            },
            sessionId => {
              if (sessionId !== activeId) {
                renameUploadId(activeId, sessionId)
                activeId = sessionId
              }
            },
          )
          toast.success(`${f.name} uploaded`)
          finishWidget(activeId, { status: 'done', pct: 100 })
        } catch (err) {
          if (err instanceof NotChunkedError) {
            // Backend decided this file fits in one Telegram document after all.
            removeUpload(activeId)
            await uploadSmallBatch([f])
          } else {
            const message = err instanceof Error ? err.message : 'Upload failed'
            toast.error(`Failed: ${f.name} — ${message}`)
            finishWidget(activeId, { status: 'error', error: message })
          }
        }
      }

      setPending([])
      onUploaded()
    } catch {
      toast.error('Upload failed — network error')
    } finally {
      setUploading(false)
      setProgress({ pct: 0 })
      setChunkedProgress(null)
    }
  }

  return (
    <form className="upload-form" onSubmit={handleSubmit}>
      <select
        className="form-input"
        value={folder}
        onChange={e => setFolder(e.target.value)}
        disabled={uploading}
      >
        <option value="">No folder (uncategorised)</option>
        {folders.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
      </select>

      <div
        className={`drop-zone${pending.length ? ' has-files' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        <span className="material-symbols-rounded" style={{ fontSize: '2rem', opacity: 0.5 }}>
          upload_file
        </span>
        {pending.length ? (
          <span>{pending.length} file{pending.length !== 1 ? 's' : ''} selected</span>
        ) : (
          <span>Drag & drop or click to select</span>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => setPending([...(e.target.files ?? [])])}
          disabled={uploading}
        />
      </div>

      {uploading && (
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${chunkedProgress ? chunkedProgress.overallPct : progress.pct}%` }} />
        </div>
      )}

      {uploading && !chunkedProgress && progress.pct > 0 && (
        <div className="progress-text">
          Uploading… {progress.pct}%
          {fmtSpeed(progress.speedBps) && ` · ${fmtSpeed(progress.speedBps)}`}
          {fmtEta(progress.etaSeconds) && ` · ETA ${fmtEta(progress.etaSeconds)}`}
        </div>
      )}

      {chunkedProgress && (
        <div className="progress-text">
          <div>{chunkedProgress.fileName}</div>
          {chunkedProgress.phase === 'sending' && (
            <div>
              Receiving file… {chunkedProgress.partPct}%
              {fmtSpeed(chunkedProgress.speedBps) && ` · ${fmtSpeed(chunkedProgress.speedBps)}`}
              {fmtEta(chunkedProgress.etaSeconds) && ` · ETA ${fmtEta(chunkedProgress.etaSeconds)}`}
            </div>
          )}
          {chunkedProgress.phase === 'telegram' && (
            <>
              <div>✓ Received — uploading to Telegram… {chunkedProgress.partPct}%</div>
              <div>
                Part {chunkedProgress.partNumber} of {chunkedProgress.totalParts}
                {fmtSpeed(chunkedProgress.speedBps) && ` · ${fmtSpeed(chunkedProgress.speedBps)}`}
                {fmtEta(chunkedProgress.etaSeconds) && ` · ETA ${fmtEta(chunkedProgress.etaSeconds)}`}
              </div>
            </>
          )}
          {chunkedProgress.phase === 'finalizing' && <div>Finalizing…</div>}
        </div>
      )}

      <button
        className="btn btn-primary"
        type="submit"
        disabled={uploading || !pending.length}
      >
        {uploading ? (
          <>
            <span className="material-symbols-rounded spin" style={{ fontSize: '1rem' }}>
              progress_activity
            </span>
            {chunkedProgress ? chunkedProgress.overallPct : progress.pct}%
          </>
        ) : (
          <>
            <span className="material-symbols-rounded" style={{ fontSize: '1rem' }}>upload</span>
            Upload
          </>
        )}
      </button>
    </form>
  )
}
