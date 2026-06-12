import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAdminHealth, getToken } from '../api/client'

interface HealthData {
  status: string
  uptime_seconds: number
  uptime_human: string
  db: {
    status: string
    latency_ms: number
    total_files: number
    total_folders: number
    error?: string
  }
  telegram: {
    count: number
    user_ids: number[]
  }
  cache: {
    hits: number
    misses: number
    hit_rate_pct: number
    entries: number
  }
  memory_mb: number | null
  requests: {
    total: number
    errors: number
    avg_response_ms: number | null
  }
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#0f0f0f',
    color: '#e0e0e0',
    fontFamily: 'system-ui, sans-serif',
    padding: '24px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginBottom: '28px',
  },
  backBtn: {
    background: '#1e1e1e',
    border: '1px solid #333',
    color: '#aaa',
    borderRadius: '8px',
    padding: '8px 14px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  title: {
    fontSize: '22px',
    fontWeight: 700,
    color: '#fff',
    flex: 1,
  },
  refreshBtn: {
    background: '#1a3a5c',
    border: '1px solid #2a5a9c',
    color: '#7eb8f7',
    borderRadius: '8px',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  timestamp: {
    fontSize: '12px',
    color: '#555',
    marginBottom: '20px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  card: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '12px',
    padding: '20px',
  },
  cardTitle: {
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: '#666',
    marginBottom: '14px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 0',
    borderBottom: '1px solid #222',
  },
  rowLast: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 0',
  },
  label: { fontSize: '13px', color: '#888' },
  value: { fontSize: '13px', fontWeight: 600, color: '#e0e0e0' },
  ok: { color: '#4caf50' },
  warn: { color: '#ff9800' },
  err: { color: '#f44336' },
  dot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    marginRight: '6px',
  },
  error: {
    background: '#1a0a0a',
    border: '1px solid #5a2a2a',
    borderRadius: '8px',
    padding: '16px',
    color: '#f44336',
    marginBottom: '16px',
  },
  loading: {
    color: '#555',
    textAlign: 'center' as const,
    paddingTop: '80px',
    fontSize: '14px',
  },
}

function latencyColor(ms: number | null): React.CSSProperties {
  if (ms === null) return s.err
  if (ms < 200) return s.ok
  if (ms < 800) return s.warn
  return s.err
}

function hitRateColor(pct: number): React.CSSProperties {
  if (pct >= 70) return s.ok
  if (pct >= 30) return s.warn
  return s.err
}

export default function Admin() {
  const nav = useNavigate()
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchHealth = useCallback(async () => {
    if (!getToken()) { nav('/login'); return }
    try {
      const res = await getAdminHealth()
      if (res.status === 401) { nav('/login'); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: HealthData = await res.json()
      setData(json)
      setError(null)
      setLastUpdated(new Date())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load health data')
    } finally {
      setLoading(false)
    }
  }, [nav])

  useEffect(() => {
    fetchHealth()
    const id = setInterval(fetchHealth, 30_000)
    return () => clearInterval(id)
  }, [fetchHealth])

  if (loading) return <div style={s.page}><div style={s.loading}>Loading health data…</div></div>

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={() => nav('/dashboard')}>← Back</button>
        <span style={s.title}>Health Dashboard</span>
        <button style={s.refreshBtn} onClick={fetchHealth}>Refresh</button>
      </div>

      {lastUpdated && (
        <div style={s.timestamp}>
          Last updated: {lastUpdated.toLocaleTimeString()} · auto-refreshes every 30s
        </div>
      )}

      {error && <div style={s.error}>Error: {error}</div>}

      {data && (
        <div style={s.grid}>

          {/* Uptime */}
          <div style={s.card}>
            <div style={s.cardTitle}>Uptime</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: '#7eb8f7', marginBottom: '10px' }}>
              {data.uptime_human}
            </div>
            <div style={{ ...s.label, fontSize: '12px' }}>{data.uptime_seconds.toLocaleString()}s since last restart</div>
          </div>

          {/* Database */}
          <div style={s.card}>
            <div style={s.cardTitle}>Database</div>
            <div style={s.row}>
              <span style={s.label}>Status</span>
              <span style={data.db.status === 'ok' ? s.ok : s.err}>
                <span style={{ ...s.dot, background: data.db.status === 'ok' ? '#4caf50' : '#f44336' }} />
                {data.db.status}
              </span>
            </div>
            <div style={s.row}>
              <span style={s.label}>Latency</span>
              <span style={{ ...s.value, ...latencyColor(data.db.latency_ms) }}>
                {data.db.latency_ms}ms
              </span>
            </div>
            <div style={s.row}>
              <span style={s.label}>Total files</span>
              <span style={s.value}>{data.db.total_files.toLocaleString()}</span>
            </div>
            <div style={s.rowLast}>
              <span style={s.label}>Total folders</span>
              <span style={s.value}>{data.db.total_folders.toLocaleString()}</span>
            </div>
          </div>

          {/* Telegram */}
          <div style={s.card}>
            <div style={s.cardTitle}>Telegram</div>
            <div style={s.row}>
              <span style={s.label}>Active sessions</span>
              <span style={{ ...s.value, ...(data.telegram.count > 0 ? s.ok : s.warn) }}>
                <span style={{ ...s.dot, background: data.telegram.count > 0 ? '#4caf50' : '#ff9800' }} />
                {data.telegram.count}
              </span>
            </div>
            <div style={s.rowLast}>
              <span style={s.label}>Connected users</span>
              <span style={s.value}>
                {data.telegram.user_ids.length > 0
                  ? data.telegram.user_ids.join(', ')
                  : '—'}
              </span>
            </div>
          </div>

          {/* Cache */}
          <div style={s.card}>
            <div style={s.cardTitle}>Cache</div>
            <div style={s.row}>
              <span style={s.label}>Hit rate</span>
              <span style={{ ...s.value, ...hitRateColor(data.cache.hit_rate_pct) }}>
                {data.cache.hit_rate_pct}%
              </span>
            </div>
            <div style={s.row}>
              <span style={s.label}>Hits / Misses</span>
              <span style={s.value}>{data.cache.hits} / {data.cache.misses}</span>
            </div>
            <div style={s.rowLast}>
              <span style={s.label}>Entries in memory</span>
              <span style={s.value}>{data.cache.entries}</span>
            </div>
          </div>

          {/* Requests */}
          <div style={s.card}>
            <div style={s.cardTitle}>Requests</div>
            <div style={s.row}>
              <span style={s.label}>Total served</span>
              <span style={s.value}>{data.requests.total.toLocaleString()}</span>
            </div>
            <div style={s.row}>
              <span style={s.label}>Errors (5xx)</span>
              <span style={{ ...s.value, ...(data.requests.errors > 0 ? s.err : s.ok) }}>
                {data.requests.errors}
              </span>
            </div>
            <div style={s.rowLast}>
              <span style={s.label}>Avg response time</span>
              <span style={{ ...s.value, ...latencyColor(data.requests.avg_response_ms) }}>
                {data.requests.avg_response_ms !== null ? `${data.requests.avg_response_ms}ms` : '—'}
              </span>
            </div>
          </div>

          {/* Memory */}
          <div style={s.card}>
            <div style={s.cardTitle}>Memory</div>
            {data.memory_mb !== null ? (
              <>
                <div style={{ fontSize: '28px', fontWeight: 700, color: data.memory_mb > 400 ? '#f44336' : data.memory_mb > 256 ? '#ff9800' : '#4caf50', marginBottom: '10px' }}>
                  {data.memory_mb} MB
                </div>
                <div style={{ ...s.label, fontSize: '12px' }}>
                  RSS · {data.memory_mb > 400 ? 'High — approaching Render free-tier limit' : data.memory_mb > 256 ? 'Moderate' : 'Healthy'}
                </div>
              </>
            ) : (
              <div style={s.label}>Not available on this platform</div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
