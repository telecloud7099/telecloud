import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setupApi, checkSetup } from '../api/client'

const STEPS = [
  { n: 1, text: 'Open my.telegram.org and sign in with your phone number' },
  { n: 2, text: 'Click "API development tools" in the menu' },
  { n: 3, text: 'Fill in any App title and short name, then click "Create application"' },
  { n: 4, text: 'Copy the App api_id (a number) and App api_hash (32-character string) shown on that page' },
]

export default function Setup() {
  const nav = useNavigate()
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    checkSetup().then(d => { if (d.configured) nav('/login') })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await setupApi(apiId.trim(), apiHash.trim())
      const d = await res.json()
      if (d.status === 'success') {
        nav('/login')
      } else {
        setError(d.message || 'Setup failed')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card setup-card">

        {/* Header */}
        <div className="auth-logo">
          <span className="material-symbols-rounded" style={{ fontSize: '2.5rem', color: 'var(--accent)' }}>cloud</span>
          <h1 className="auth-title">TeleCloud</h1>
          <p className="auth-subtitle">One-time setup — connect to your Telegram account</p>
        </div>

        {/* Instructions */}
        <div className="setup-guide">
          <div className="setup-guide-header">
            <span className="material-symbols-rounded">help_outline</span>
            How to get your API credentials
          </div>
          <ol className="setup-steps">
            {STEPS.map(s => (
              <li key={s.n} className="setup-step">
                <span className="setup-step-num">{s.n}</span>
                <span className="setup-step-text">{s.text}</span>
              </li>
            ))}
          </ol>
          <a
            href="https://my.telegram.org"
            target="_blank"
            rel="noopener noreferrer"
            className="setup-guide-link"
          >
            <span className="material-symbols-rounded">open_in_new</span>
            Open my.telegram.org
          </a>
        </div>

        {/* Form */}
        <form onSubmit={submit} className="auth-form">
          <div className="form-group">
            <label className="form-label">API ID</label>
            <input
              className="form-input"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 12345678"
              value={apiId}
              onChange={e => setApiId(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">API Hash</label>
            <input
              className="form-input form-input-mono"
              type="text"
              placeholder="0123456789abcdef0123456789abcdef"
              value={apiHash}
              onChange={e => setApiHash(e.target.value)}
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            {loading
              ? <><span className="material-symbols-rounded spin" style={{ fontSize: '1rem' }}>progress_activity</span> Saving…</>
              : 'Save & Continue'
            }
          </button>
        </form>

      </div>
    </div>
  )
}
