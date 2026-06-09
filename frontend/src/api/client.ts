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
  id: number
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

  const res = await fetch(url, { ...options, headers, signal })

  if (res.status === 401) {
    clearToken()
    if (!['/login', '/setup'].includes(window.location.pathname)) {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }
  return res
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
  fetch('/check-phone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).then(r => r.json()) as Promise<{ status: string; needs_setup: boolean }>

export const setupApi = (phone: string, apiId: string, apiHash: string) =>
  fetch('/setup-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, api_id: Number(apiId), api_hash: apiHash }),
  }).then(r => r.json())

export const sendCode = (phone: string) =>
  fetch('/send_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).then(r => r.json())

export const verifyCode = (phone: string, code: string) =>
  fetch('/verify_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  }).then(r => r.json())

export const verifyPassword = (phone: string, password: string) =>
  fetch('/verify_password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  }).then(r => r.json())

export const getMe = () => apiFetch('/me')

export const logout = () => apiFetch('/logout', { method: 'POST' })

export const deleteData = () => apiFetch('/delete_data', { method: 'POST' })

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

export const fileUrl = (id: number, download = false) => {
  const token = getToken()
  const params = new URLSearchParams({ token })
  if (download) params.set('download', 'true')
  return `/file/${id}?${params}`
}

export const thumbnailUrl = (id: number) =>
  `/thumbnail/${id}?token=${encodeURIComponent(getToken())}`

export const moveFiles = (folder: string, msgIds: number[]) =>
  post('/files/move', { folder, msg_ids: msgIds })

export const deleteFiles = (msgIds: number[]) =>
  del('/files', { msg_ids: msgIds })

export const uploadFiles = (folder: string, files: File[], onProgress?: (pct: number) => void): Promise<Response> => {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('folderName', folder)
    files.forEach(f => form.append('file', f))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/upload')
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => resolve(new Response(xhr.responseText, { status: xhr.status }))
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.send(form)
  })
}
