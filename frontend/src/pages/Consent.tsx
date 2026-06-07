import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'

const CONSENT_ITEMS = [
  {
    icon: 'phone_iphone',
    title: 'Your phone number',
    desc: 'Used only to send you a Telegram login code. Never stored in plain text.',
  },
  {
    icon: 'folder_open',
    title: 'Your Telegram Saved Messages',
    desc: 'TeleCloud reads files from your Saved Messages to display them here. We never access your chats or contacts.',
  },
  {
    icon: 'lock',
    title: 'Your session is private',
    desc: 'Your login session and API credentials are encrypted and stored only on this server. Nothing is shared.',
  },
]

export default function Consent() {
  const nav = useNavigate()
  const [checked, setChecked] = useState(CONSENT_ITEMS.map(() => false))
  const [error, setError] = useState(false)
  const [declining, setDeclining] = useState(false)

  useEffect(() => {
    if (localStorage.getItem('user_consent') === 'true') nav('/login')
  }, [])

  function toggle(i: number) {
    setChecked(prev => prev.map((v, idx) => idx === i ? !v : v))
    setError(false)
  }

  function accept() {
    if (!checked.every(Boolean)) { setError(true); return }
    localStorage.setItem('user_consent', 'true')
    localStorage.setItem('consent_date', new Date().toISOString())
    nav('/login')
  }

  return (
    <div className="auth-container">
      <div className="auth-card consent-card">

        <div className="auth-logo">
          <span className="material-symbols-rounded" style={{ fontSize: '2.5rem', color: 'var(--accent)' }}>
            security
          </span>
          <h1 className="auth-title">Before you continue</h1>
          <p className="auth-subtitle">TeleCloud uses your Telegram account to store and access files. Here's exactly what it does:</p>
        </div>

        <div className="consent-items">
          {CONSENT_ITEMS.map((item, i) => (
            <label key={i} className={`consent-item${checked[i] ? ' checked' : ''}`} onClick={() => toggle(i)}>
              <span className="material-symbols-rounded consent-item-icon">{item.icon}</span>
              <div className="consent-item-body">
                <div className="consent-item-title">{item.title}</div>
                <div className="consent-item-desc">{item.desc}</div>
              </div>
              <div className={`consent-check${checked[i] ? ' checked' : ''}`}>
                {checked[i] && <span className="material-symbols-rounded" style={{ fontSize: '1rem' }}>check</span>}
              </div>
            </label>
          ))}
        </div>

        {error && (
          <div className="auth-error" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="material-symbols-rounded">warning</span>
            Please read and accept all items to continue.
          </div>
        )}

        {declining ? (
          <div className="consent-decline-confirm">
            <p>Are you sure? You won't be able to use TeleCloud without accepting.</p>
            <div className="consent-actions">
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setDeclining(false)}>
                Go back
              </button>
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => nav('/')}>
                Leave
              </button>
            </div>
          </div>
        ) : (
          <div className="consent-actions">
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={accept}>
              Accept &amp; Continue
            </button>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setDeclining(true)}>
              Decline
            </button>
          </div>
        )}

        <p className="auth-hint">
          <Link to="/privacy-policy" target="_blank" rel="noopener noreferrer">Read our Privacy Policy</Link>
        </p>

      </div>
    </div>
  )
}
