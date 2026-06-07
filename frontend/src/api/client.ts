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
  caption?: string
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
  phone: string
  has_api_credentials: boolean
}

// ── Core fetch ───────────────────────────────────────────────────────────────

function getCsrf(): string {
  return document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('csrf_token='))?.split('=')[1] ?? ''
}

async function apiFetch(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('X-CSRF-Token', getCsrf())

  const res = await fetch(url, { ...options, headers, signal })

  if (res.status === 401) {
    // Don't redirect if already on an auth page — avoids an infinite reload loop
    // (Login calls /me to check auth; a 401 there is the expected answer, not an error)
    if (!['/login', '/setup'].includes(window.location.pathname)) {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }
  if (res.status === 403) {
    window.location.reload()
    throw new Error('CSRF mismatch')
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

export const checkSetup = () => fetch('/has-setup').then(r => r.json()) as Promise<{ configured: boolean }>

export const setupApi = (apiId: string, apiHash: string) =>
  post('/setup-api', { api_id: apiId, api_hash: apiHash })

export const sendCode = (phone: string) =>
  post('/send_code', { phone })

export const verifyCode = (phone: string, code: string, phoneCodeHash: string) =>
  post('/verify_code', { phone, code, phone_code_hash: phoneCodeHash })

export const verifyPassword = (phone: string, password: string) =>
  post('/verify_password', { phone, password })

export const getMe = () => apiFetch('/me')

export const logout = () => post('/logout', {})

export const deleteData = () => del('/delete_data')

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

export const syncFiles = () => post('/files/sync', {})

export const searchFiles = (q: string) =>
  apiFetch(`/files/search?q=${encodeURIComponent(q)}`)

export const fileUrl = (id: number, download = false) =>
  `/file/${id}${download ? '?download=true' : ''}`

export const thumbnailUrl = (id: number) => `/thumbnail/${id}`

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
    xhr.setRequestHeader('X-CSRF-Token', getCsrf())

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
