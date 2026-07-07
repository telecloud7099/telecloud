import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { uploadFiles, safeJson, makeSpeedTracker } from '../api/client'
import { uploadChunkedFile, NotChunkedError, type ChunkedUploadProgress } from '../api/chunkedUpload'
import { useStore } from '../store'

interface Props {
  onUploaded: () => void
}

// Smaller of Telegram's two per-account document caps (free vs. Premium) — anything under
// this is guaranteed to fit in one document regardless of account type, so it's not worth
// the extra round-trip of asking the backend. Anything at or above it might still turn out
// to fit (a Premium account's larger cap), in which case NotChunkedError signals a fallback.
const CHUNK_PROBE_THRESHOLD = 1900 * 1024 * 1024

interface ChunkedFileProgress extends ChunkedUploadProgress {
  fileName: string
}

interface BatchProgress {
  pct: number
  speedBps?: number
  etaSeconds?: number
}

function fmtSpeed(bps?: number): string | null {
  if (!bps) return null
  const mbps = bps / (1024 * 1024)
  return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`
}

function fmtEta(seconds?: number): string | null {
  if (seconds == null) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export default function UploadZone({ onUploaded }: Props) {
  const folders = useStore(s => s.folders)
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

  async function uploadSmallBatch(files: File[]) {
    const speedOf = makeSpeedTracker()
    const res = await uploadFiles(folder, files, (pct, loaded, total) => {
      const bps = speedOf(loaded)
      setProgress({
        pct,
        speedBps: bps || undefined,
        etaSeconds: bps > 0 ? Math.round((total - loaded) / bps) : undefined,
      })
    })
    const d = await safeJson(res, 'Upload')

    const results: { name: string; success: boolean; error?: string }[] =
      d.results ?? (d.status === 'success' ? files.map(f => ({ name: f.name, success: true })) : [])

    const ok = results.filter(r => r.success).length
    const fail = results.filter(r => !r.success)

    if (ok > 0) toast.success(`${ok} file${ok !== 1 ? 's' : ''} uploaded`)
    fail.forEach(r => toast.error(`Failed: ${r.name}${r.error ? ` — ${r.error}` : ''}`))
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
        try {
          await uploadChunkedFile(f, folder, p => setChunkedProgress({ fileName: f.name, ...p }))
          toast.success(`${f.name} uploaded`)
        } catch (err) {
          if (err instanceof NotChunkedError) {
            // Backend decided this file fits in one Telegram document after all.
            await uploadSmallBatch([f])
          } else {
            toast.error(`Failed: ${f.name}${err instanceof Error ? ` — ${err.message}` : ''}`)
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
