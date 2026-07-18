// ── API base URL (set VITE_API_URL on Vercel to point at Railway backend) ─────
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

// ── Token storage ─────────────────────────────────────────────────────────────

const TOKEN_KEY = 'tc_access_token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Folder {
  name: string
  count?: number
}

export interface TeleFile {
  id: string
  name: string
  size: number
  mime_type: string
  date: string | null
  category?: string
  folder_id?: string | null
  folder_name?: string | null
}

export interface FilesResponse {
  status: string
  files: TeleFile[]
  total: number
  has_more: boolean
  scan_limit: number
  scanned: number
}

export interface FolderCountsResponse {
  status: string
  counts: Record<string, number>
  total_files: number
  total_size: number
}

export interface StatsResponse {
  status: string
  scan_limit: number
  scanned: number | null
  has_more: boolean | null
  cache_warm: boolean
}

export interface MeResponse {
  status: string
  telegram_user_id: number
  username: string | null
  first_name: string | null
}

// ── Core fetch ───────────────────────────────────────────────────────────────

async function apiFetch(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers(options.headers)
  const token = getToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(`${API_BASE}${url}`, { ...options, headers, signal })

  if (res.status === 401) {
    clearToken()
    if (!['/login', '/setup'].includes(window.location.pathname)) {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }
  return res
}

// A dropped connection or a backend restart mid-request leaves the browser with a Response
// that has no (or garbled) body — calling .json() directly on that throws a cryptic
// "Unexpected end of JSON input" with no indication of what actually went wrong. Reading
// the text first lets us tell that case apart from a real application error and say
// something a user can act on.
export async function safeJson(res: Response, action: string): Promise<any> {
  const text = await res.text()
  if (!text) {
    throw new Error(`${action} failed: no response from the server — it may have restarted or your connection dropped. Try again.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${action} failed: the server sent back an unreadable response. Try again.`)
  }
}

function post<T>(url: string, body: T) {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function put<T>(url: string, body: T) {
  return apiFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function del(url: string, body?: unknown) {
  return apiFetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const checkPhone = (phone: string) =>
  fetch(`${API_BASE}/check-phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).then(r => r.json()) as Promise<{ status: string; needs_setup: boolean }>

export const setupApi = (phone: string, apiId: string, apiHash: string) =>
  fetch(`${API_BASE}/setup-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, api_id: Number(apiId), api_hash: apiHash }),
  }).then(r => r.json())

export const sendCode = (phone: string) =>
  fetch(`${API_BASE}/send_code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).then(r => r.json())

export const verifyCode = (phone: string, code: string) =>
  fetch(`${API_BASE}/verify_code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  }).then(r => r.json())

export const verifyPassword = (phone: string, password: string) =>
  fetch(`${API_BASE}/verify_password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  }).then(r => r.json())

export const getMe = () => apiFetch('/me')

export const logout = () => apiFetch('/logout', { method: 'POST' })

export const deleteData = () => apiFetch('/delete_data', { method: 'POST' })

export const getAdminHealth = () => apiFetch('/admin/health')

// ── Folders ──────────────────────────────────────────────────────────────────

export const listFolders = () => apiFetch('/folders')

export const getFolderCounts = () => apiFetch('/folders/counts')

export const createFolder = (folderName: string) =>
  post('/folders', { folder_name: folderName })

export const renameFolder = (oldName: string, newName: string) =>
  put(`/folders/${encodeURIComponent(oldName)}`, { new_name: newName })

export const deleteFolder = (name: string) =>
  del(`/folders/${encodeURIComponent(name)}`)

export const listFilesInFolder = (name: string) =>
  apiFetch(`/folders/${encodeURIComponent(name)}/files`)

// ── Files ────────────────────────────────────────────────────────────────────

export const listFiles = (params: { offset?: number; limit?: number; category?: string; refresh?: boolean } = {}, signal?: AbortSignal) => {
  const q = new URLSearchParams()
  if (params.offset !== undefined) q.set('offset', String(params.offset))
  if (params.limit !== undefined) q.set('limit', String(params.limit))
  if (params.category) q.set('category', params.category)
  if (params.refresh) q.set('refresh', '1')
  return apiFetch(`/files?${q}`, {}, signal)
}

export const getFileStats = () => apiFetch('/files/stats')

export const syncFiles = () => apiFetch('/files/sync', { method: 'POST' })

export const searchFiles = (q: string) =>
  apiFetch(`/files/search?q=${encodeURIComponent(q)}`)

export const fileUrl = (id: string, download = false) => {
  const token = getToken()
  const params = new URLSearchParams({ token })
  if (download) params.set('download', 'true')
  return `${API_BASE}/file/${id}?${params}`
}

export const thumbnailUrl = (id: string) =>
  `${API_BASE}/thumbnail/${id}?token=${encodeURIComponent(getToken())}`

export const moveFiles = (folder: string, fileIds: string[]) =>
  post('/files/move', { folder, file_ids: fileIds })

export const deleteFiles = (fileIds: string[]) =>
  del('/files', { file_ids: fileIds })

// ── Chunked upload (files too large for a single Telegram document) ──────────

export interface UploadSessionInfo {
  status: string
  chunked: boolean
  chunk_size: number
  session_id?: string
  session_status?: string
  next_part_number?: number
  total_chunks?: number
  bytes_uploaded?: number
  total_size?: number
}

export const createUploadSession = (filename: string, totalSize: number, mimeType: string, folderName: string) =>
  post('/uploads', { filename, total_size: totalSize, mime_type: mimeType, folder_name: folderName })

export const getUploadSession = (sessionId: string) => apiFetch(`/uploads/${sessionId}`)

export interface ActiveUploadSession {
  session_id: string
  filename: string
  folder_name: string | null
  next_part_number: number
  total_chunks: number
  chunk_size: number
  bytes_uploaded: number
  total_size: number
}

export const listUploadSessions = () => apiFetch('/uploads')

export const completeUploadSession = (sessionId: string) => post(`/uploads/${sessionId}/complete`, {})

export const abortUploadSession = (sessionId: string) => del(`/uploads/${sessionId}`)

export type UploadProgressFn = (pct: number, loaded: number, total: number) => void

/** Smoothed browser→server upload speed from XHR progress events. Returns bytes/second
 * (0 until there are two samples to compare). */
export function makeSpeedTracker(): (loaded: number) => number {
  let lastTime = 0
  let lastLoaded = 0
  let speed = 0
  return (loaded: number): number => {
    const now = performance.now()
    if (lastTime && now > lastTime) {
      const inst = ((loaded - lastLoaded) / (now - lastTime)) * 1000
      speed = speed ? 0.2 * inst + 0.8 * speed : inst
    }
    lastTime = now
    lastLoaded = loaded
    return speed
  }
}

export const uploadPart = (
  sessionId: string, partNumber: number, blob: Blob, onProgress?: UploadProgressFn,
): Promise<Response> => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${API_BASE}/uploads/${sessionId}/parts/${partNumber}`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total)
      }
    }

    xhr.onload = () => resolve(new Response(xhr.responseText, { status: xhr.status }))
    xhr.onerror = () => reject(new Error(`Part ${partNumber} upload failed`))
    xhr.send(blob)
  })
}

/** Thrown only on a true transport failure (xhr.onerror — connection dropped, DNS blip,
 * etc.), never on a completed HTTP response. That distinction is what makes retrying safe:
 * an actual server response (even a 4xx/5xx) means the request was processed, so retrying
 * it could re-upload — a transport failure means it never got there. */
class UploadNetworkError extends Error {}

function uploadFilesOnce(folder: string, files: File[], onProgress?: UploadProgressFn): Promise<Response> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('folderName', folder)
    files.forEach(f => form.append('file', f))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/upload`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total)
      }
    }

    xhr.onload = () => resolve(new Response(xhr.responseText, { status: xhr.status }))
    xhr.onerror = () => reject(new UploadNetworkError('Upload failed — network error'))
    xhr.send(form)
  })
}

const UPLOAD_RETRY_ATTEMPTS = 3

/** A brief network blip (1-2s of dropped connectivity mid-upload) shouldn't fail the whole
 * request — retry a couple of times with backoff before giving up. Only fires for files
 * small enough to still be on this single-shot path (see RESUMABLE_THRESHOLD in
 * UploadZone.tsx); anything larger goes through the resumable session flow instead, which
 * retries per-part rather than re-sending the whole file. */
export async function uploadFiles(folder: string, files: File[], onProgress?: UploadProgressFn): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadFilesOnce(folder, files, onProgress)
    } catch (err) {
      if (err instanceof UploadNetworkError && attempt < UPLOAD_RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, attempt * 800))
        continue
      }
      throw err
    }
  }
}
