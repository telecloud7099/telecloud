import { createUploadSession, getUploadSession, uploadPart, completeUploadSession, safeJson } from './client'

/** Thrown when the backend decides a file fits in a single Telegram document after all
 * (e.g. a Premium account's larger cap) — the caller should fall back to the plain upload. */
export class NotChunkedError extends Error {}

/** A part failed or stalled server-side in a way that re-sending the same part can fix
 * (Telegram hiccup, backend restart mid-part). Internal to the retry loop. */
class PartRetryableError extends Error {}

export type UploadPhase = 'sending' | 'telegram' | 'finalizing'

export interface ChunkedUploadProgress {
  phase: UploadPhase
  partNumber: number
  totalParts: number
  /** 0–100 within the current phase of the current part (browser→server bytes while
   * sending, server→Telegram bytes while relaying). */
  partPct: number
  /** 0–100 for the whole logical file, counting only bytes that have reached (or are
   * mid-flight to) Telegram — this is the honest "how done is my upload" number. */
  overallPct: number
  speedBps?: number
  etaSeconds?: number
}

const RESUME_KEY_PREFIX = 'tc_upload_session:'
const POLL_INTERVAL_MS = 1000
// Consecutive polls with the part neither confirmed nor reporting live progress before
// we conclude the backend restarted mid-part and the part must be re-sent.
const STALLED_POLLS = 8
const MAX_PART_ATTEMPTS = 3

// Keyed by name+size+lastModified — a reasonable proxy for "the same file" across a page
// reload, without needing to hash the whole file client-side just to resume.
function resumeKey(file: File): string {
  return `${RESUME_KEY_PREFIX}${file.name}:${file.size}:${file.lastModified}`
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function uploadChunkedFile(
  file: File,
  folderName: string,
  onProgress: (p: ChunkedUploadProgress) => void,
): Promise<void> {
  const key = resumeKey(file)
  let sessionId = localStorage.getItem(key)
  let totalChunks = 0
  let chunkSize = 0
  let nextPart = 1

  if (sessionId) {
    let status: any = null
    try {
      status = await safeJson(await getUploadSession(sessionId), 'Checking previous upload')
    } catch {
      // Couldn't confirm the cached session is still good — safer to start fresh than to
      // get stuck retrying against a reference we can't verify.
    }
    if (status?.status === 'success' && status.session_status === 'uploading') {
      totalChunks = status.total_chunks
      chunkSize = status.chunk_size
      nextPart = status.next_part_number
    } else {
      // Stale, foreign, or already-finished reference — start a fresh session.
      localStorage.removeItem(key)
      sessionId = null
    }
  }

  if (!sessionId) {
    const created = await safeJson(await createUploadSession(
      file.name, file.size, file.type || 'application/octet-stream', folderName,
    ), 'Starting upload')
    if (created.status !== 'success') throw new Error('Could not start upload')
    if (!created.chunked) throw new NotChunkedError()

    sessionId = created.session_id ?? null
    totalChunks = created.total_chunks ?? 0
    chunkSize = created.chunk_size
    nextPart = created.next_part_number ?? 1
    if (!sessionId) throw new Error('Upload session response missing session_id')
    localStorage.setItem(key, sessionId)
  }

  for (let part = nextPart; part <= totalChunks; part++) {
    // Parts confirm strictly in order, so everything before this part is already on Telegram.
    const confirmedBefore = Math.min((part - 1) * chunkSize, file.size)

    for (let attempt = 1; ; attempt++) {
      try {
        // If the server already has this part (confirmed, or mid-flight to Telegram —
        // e.g. we're resuming after a client-side failure while the background transfer
        // survived), don't re-send gigabytes it doesn't need — go straight to watching.
        if (!(await serverHasPart(sessionId, part))) {
          const start = (part - 1) * chunkSize
          const end = Math.min(start + chunkSize, file.size)
          const blob = file.slice(start, end)

          let res: Response
          try {
            res = await uploadPart(sessionId, part, blob, pct =>
              onProgress({
                phase: 'sending', partNumber: part, totalParts: totalChunks,
                partPct: pct,
                overallPct: pctOf(confirmedBefore, file.size),
              }),
            )
          } catch (err) {
            // Network-level XHR failure — the server may still have received and kept the
            // part, so this is retryable: the next attempt checks serverHasPart first.
            throw new PartRetryableError(err instanceof Error ? err.message : `Part ${part} send failed`)
          }
          const d = await safeJson(res, `Uploading part ${part}/${totalChunks}`)
          if (d.status !== 'success') throw new Error(d.message || `Part ${part} failed`)
          if (d.confirmed) break // retry of a part that already made it to Telegram
        }

        await waitForPartConfirmed(sessionId, part, totalChunks, file.size, onProgress)
        break
      } catch (err) {
        if (err instanceof PartRetryableError && attempt < MAX_PART_ATTEMPTS) continue
        throw err
      }
    }
  }

  onProgress({ phase: 'finalizing', partNumber: totalChunks, totalParts: totalChunks, partPct: 100, overallPct: 100 })
  const completed = await safeJson(await completeUploadSession(sessionId), 'Finishing upload')
  if (completed.status !== 'success') throw new Error(completed.message || 'Failed to finalize upload')
  localStorage.removeItem(key)
}

/** Polls the session until this part is confirmed on Telegram, forwarding live
 * server→Telegram progress (speed/ETA) to the caller. The PUT already returned, so
 * these are all short requests — nothing here can die to a long-request timeout. */
async function waitForPartConfirmed(
  sessionId: string,
  part: number,
  totalParts: number,
  totalSize: number,
  onProgress: (p: ChunkedUploadProgress) => void,
): Promise<void> {
  let stalled = 0
  while (true) {
    await sleep(POLL_INTERVAL_MS)

    // Only a definitive 404 means the session is truly gone. Anything else — network
    // blip, backend restarting, a transient 500 from a database hiccup — must NOT abort
    // the upload, because the server-side Telegram transfer usually survives it.
    const res = await getUploadSession(sessionId).catch(() => null)
    if (res?.status === 404) throw new Error('Upload session lost — please retry the upload')
    let status: any = null
    if (res) {
      try {
        status = await safeJson(res, 'Checking upload progress')
      } catch { /* unreadable body — treat as a stalled poll */ }
    }
    if (!status || status.status !== 'success') {
      if (++stalled >= STALLED_POLLS) throw new PartRetryableError(`Lost contact while uploading part ${part}`)
      continue
    }
    if (status.next_part_number > part) return // confirmed

    const p = status.part_progress
    if (p && p.part_number === part) {
      if (p.phase === 'failed') throw new PartRetryableError(p.error || `Part ${part} failed on the server`)
      stalled = 0
      onProgress({
        phase: 'telegram', partNumber: part, totalParts,
        partPct: pctOf(p.bytes_done, p.bytes_total),
        overallPct: pctOf((status.bytes_uploaded ?? 0) + (p.bytes_done ?? 0), totalSize),
        speedBps: p.speed_bps || undefined,
        etaSeconds: p.eta_seconds ?? undefined,
      })
    } else if (++stalled >= STALLED_POLLS) {
      // Not confirmed and no live progress — the backend likely restarted and lost the
      // in-memory transfer. The part is unconfirmed, so re-sending it is safe.
      throw new PartRetryableError(`Server lost track of part ${part}`)
    }
  }
}

/** True when the server already holds this part — confirmed on Telegram, or currently
 * being pushed there by a background task — so re-sending the bytes would be wasted. */
async function serverHasPart(sessionId: string, part: number): Promise<boolean> {
  try {
    const res = await getUploadSession(sessionId)
    if (!res.ok) return false
    const status = await safeJson(res, 'Checking upload state')
    if (status.status !== 'success') return false
    if (status.next_part_number > part) return true // already confirmed
    const p = status.part_progress
    return !!(p && p.part_number === part && p.phase === 'uploading_telegram')
  } catch {
    return false
  }
}

function pctOf(done: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.round((done / total) * 100))
}
