import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { uploadFiles } from '../api/client'
import { useStore } from '../store'

interface Props {
  onUploaded: () => void
}

export default function UploadZone({ onUploaded }: Props) {
  const folders = useStore(s => s.folders)
  const [folder, setFolder] = useState('')
  const [pending, setPending] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setPending([...e.dataTransfer.files])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!pending.length) return
    setUploading(true)
    setProgress(0)

    try {
      const res = await uploadFiles(folder, pending, pct => setProgress(pct))
      const d = await res.json()

      const results: { name: string; success: boolean; error?: string }[] =
        d.results ?? (d.status === 'success' ? pending.map(f => ({ name: f.name, success: true })) : [])

      const ok = results.filter(r => r.success).length
      const fail = results.filter(r => !r.success)

      if (ok > 0) toast.success(`${ok} file${ok !== 1 ? 's' : ''} uploaded`)
      fail.forEach(r => toast.error(`Failed: ${r.name}${r.error ? ` — ${r.error}` : ''}`))

      setPending([])
      onUploaded()
    } catch {
      toast.error('Upload failed — network error')
    } finally {
      setUploading(false)
      setProgress(0)
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
          <div className="progress-fill" style={{ width: `${progress}%` }} />
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
            {progress}%
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
