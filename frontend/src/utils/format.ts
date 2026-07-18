export function fmtSpeed(bps?: number): string | null {
  if (!bps) return null
  const mbps = bps / (1024 * 1024)
  return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`
}

export function fmtEta(seconds?: number): string | null {
  if (seconds == null) return null
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** Elapsed time since `startedAt` (epoch ms), formatted the same way as fmtEta. */
export function fmtElapsed(startedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
