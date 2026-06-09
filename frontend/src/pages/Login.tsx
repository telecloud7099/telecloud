import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { checkPhone, sendCode, verifyCode, verifyPassword, getMe, setToken } from '../api/client'
import { useStore } from '../store'

type Step = 'phone' | 'code' | 'password'

const STEP_CONFIG: Record<Step, { index: number; title: string; subtitle: (phone?: string) => string }> = {
  phone:    { index: 0, title: 'Sign in',               subtitle: () => 'Enter your Telegram phone number' },
  code:     { index: 1, title: 'Verify code',           subtitle: (p) => `Code sent to ${p}` },
  password: { index: 2, title: 'Two-step verification', subtitle: () => 'Enter your Telegram cloud password' },
}

export default function Login() {
  const nav = useNavigate()
  const location = useLocation()
  const setDisplayName = useStore(s => s.setPhone)

  const locationState = location.state as { phone?: string; step?: Step } | null
  const [step, setStep] = useState<Step>(locationState?.step ?? 'phone')
  const [phone, setPhoneInput] = useState(locationState?.phone ?? '')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Already have a valid JWT → skip to dashboard
    getMe()
      .then(r => r.json())
      .then(d => { if (d.status === 'success') nav('/dashboard', { replace: true }) })
      .catch(() => {/* no token yet, stay on login */})
  }, [])

  async function submitPhone(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const trimmed = phone.trim()
    try {
      const d = await checkPhone(trimmed)
      if (d.needs_setup) {
        nav('/setup', { state: { phone: trimmed } })
        return
      }
      await doSendCode(trimmed)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  async function doSendCode(ph: string) {
    const d = await sendCode(ph)
    if (d.status === 'code_sent') {
      setStep('code')
    } else if (d.needs_setup) {
      nav('/setup', { state: { phone: ph } })
    } else {
      setError(d.message || 'Failed to send code')
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const d = await verifyCode(phone.trim(), code.trim())
      if (d.status === 'success') {
        setToken(d.access_token)
        setDisplayName(phone.trim())
        nav('/dashboard')
      } else if (d.status === '2fa_required') {
        setStep('password')
      } else {
        setError(d.error || d.message || 'Invalid code')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const d = await verifyPassword(phone.trim(), password)
      if (d.status === 'success') {
        setToken(d.access_token)
        setDisplayName(phone.trim())
        nav('/dashboard')
      } else {
        setError(d.error || d.message || 'Wrong password')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  const cfg = STEP_CONFIG[step]

  return (
    <div className="auth-container">
      <div className="auth-card">

        <div className="auth-logo">
          <span className="material-symbols-rounded" style={{ fontSize: '2.5rem', color: 'var(--accent)' }}>cloud</span>
          <h1 className="auth-title">TeleCloud</h1>
        </div>

        <div className="step-dots">
          {(['phone', 'code', 'password'] as Step[]).map((s, i) => (
            <div
              key={s}
              className={`step-dot${cfg.index === i ? ' active' : cfg.index > i ? ' done' : ''}`}
            >
              {cfg.index > i
                ? <span className="material-symbols-rounded" style={{ fontSize: '0.85rem' }}>check</span>
                : i + 1
              }
            </div>
          ))}
        </div>

        <div className="auth-step-header">
          <div className="auth-step-title">{cfg.title}</div>
          <div className="auth-step-subtitle">{cfg.subtitle(phone)}</div>
        </div>

        {step === 'phone' && (
          <form onSubmit={submitPhone} className="auth-form">
            <div className="form-group">
              <label className="form-label">Phone number</label>
              <input
                className="form-input"
                type="tel"
                placeholder="+91 99999 99999"
                value={phone}
                onChange={e => setPhoneInput(e.target.value)}
                required
                autoFocus
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading
                ? <><span className="material-symbols-rounded spin" style={{ fontSize: '1rem' }}>progress_activity</span> Checking…</>
                : 'Continue'
              }
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={submitCode} className="auth-form">
            <div className="form-group">
              <label className="form-label">Verification code</label>
              <input
                className="form-input otp-input"
                type="text"
                inputMode="numeric"
                placeholder="12345"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                autoFocus
                maxLength={6}
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading
                ? <><span className="material-symbols-rounded spin" style={{ fontSize: '1rem' }}>progress_activity</span> Verifying…</>
                : 'Verify Code'
              }
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => { setStep('phone'); setCode(''); setError('') }}
            >
              ← Change number
            </button>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={submitPassword} className="auth-form">
            <div className="form-group">
              <label className="form-label">Cloud password</label>
              <input
                className="form-input"
                type="password"
                placeholder="Your 2FA password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoFocus
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading
                ? <><span className="material-symbols-rounded spin" style={{ fontSize: '1rem' }}>progress_activity</span> Signing in…</>
                : 'Sign In'
              }
            </button>
          </form>
        )}

      </div>
    </div>
  )
}
