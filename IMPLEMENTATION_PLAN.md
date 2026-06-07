# TeleCloud — Full Implementation Plan
# Stack Migration: Flask + Vanilla JS → FastAPI + React + TypeScript

> Reference this file to track progress phase by phase.
> Each phase is independently shippable — the app works after every phase.

---

## Target Stack

| Layer | Current | Target |
|---|---|---|
| Backend framework | Flask (sync) | FastAPI (async) |
| Async bridge | `run_async()` hack | Gone — FastAPI is natively async |
| Telegram client | Telethon | Telethon (keep) |
| Database | JSON files on disk | SQLite via SQLModel |
| Encryption | Fernet on JSON files | Fernet on DB columns only |
| File streaming | Load full file into RAM | `StreamingResponse` + iter_download |
| Frontend | Vanilla JS inline in HTML | React + TypeScript |
| Build tool | None | Vite |
| State management | Global `let` variables + `window.__afc` | Zustand |
| Styling | Raw CSS file | Keep existing CSS (migrate later) |

---

## File Structure (Target)

```
telecloud/
├── backend/
│   ├── main.py               ← FastAPI app entry point
│   ├── auth.py               ← login, session, CSRF logic
│   ├── telegram_client.py    ← Telethon client pool
│   ├── cache.py              ← in-memory cache
│   ├── database.py           ← SQLModel setup, models
│   ├── routes/
│   │   ├── auth.py           ← /send_code, /verify_code, /logout
│   │   ├── files.py          ← /files, /file/{id}, /thumbnail/{id}
│   │   └── folders.py        ← /folders CRUD
│   └── security.py           ← rate limit, validation (keep)
│
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/
│       │   └── client.ts     ← all fetch calls, typed
│       ├── store/
│       │   └── index.ts      ← Zustand store
│       ├── components/
│       │   ├── FolderGrid.tsx
│       │   ├── FileGrid.tsx
│       │   ├── FileCard.tsx
│       │   ├── UploadZone.tsx
│       │   ├── Gallery.tsx
│       │   ├── PreviewModal.tsx
│       │   ├── SearchBar.tsx
│       │   └── Toast.tsx
│       └── pages/
│           ├── Setup.tsx
│           ├── Login.tsx
│           └── Dashboard.tsx
│
├── static/                   ← served by FastAPI for production
├── sessions/                 ← Telethon session files (keep)
├── thumbs/                   ← thumbnail cache (keep)
├── .env
├── requirements.txt
└── package.json
```

---

## Phase 1 — FastAPI Backend Rewrite
> Goal: Replace Flask with FastAPI. App still works from the existing HTML pages.
> Frontend is untouched in this phase.

### 1.1 — Project setup
- [ ] Create `backend/` folder
- [ ] Install: `fastapi`, `uvicorn[standard]`, `python-multipart`, `sqlmodel`
- [ ] Update `requirements.txt`
- [ ] Move `.env` vars — add `DATABASE_URL=sqlite:///telecloud.db`

### 1.2 — Database (replace JSON files)
- [ ] Create `backend/database.py`
- [ ] Define `ApiSession` model (id, api_id, api_hash_encrypted, created_at, ip, ua)
- [ ] Define `UserFolder` model (id, phone_hash, name, created_at)
- [ ] Run `SQLModel.metadata.create_all(engine)` on startup
- [ ] Write `get_session()` dependency for DB access
- [ ] Migrate existing `api_sessions.json` + `user_folders.json` data into SQLite on first run

### 1.3 — Telegram client pool
- [ ] Move `_clients`, `get_client()`, `remove_client()` → `backend/telegram_client.py`
- [ ] Remove `run_async()` and background thread — FastAPI routes are already async
- [ ] Keep `_loop` only if needed for background tasks
- [ ] Test: `await get_client(phone)` works directly in a FastAPI route

### 1.4 — Auth module
- [ ] Move `_sessions`, `create_session()`, `get_session_data()`, `destroy_session()` → `backend/auth.py`
- [ ] Convert `require_auth` Flask decorator → FastAPI `Depends(get_current_user)`
- [ ] Keep CSRF double-submit logic (same pattern, different syntax)
- [ ] Keep `phone_code_hashes` (same logic, note: scope to pre-auth token in future — see TECH_DEBT.md)

### 1.5 — Routes: Auth (`backend/routes/auth.py`)
- [ ] `POST /setup-api` — store API credentials in SQLite (encrypted)
- [ ] `POST /send_code` — send Telegram OTP
- [ ] `POST /verify_code` — verify OTP, set session cookie
- [ ] `POST /verify_password` — 2FA verify, set session cookie
- [ ] `POST /logout` — destroy session, purge client
- [ ] `POST /delete_data` — wipe all user data
- [ ] `GET /me` — return phone for current session

### 1.6 — Routes: Files (`backend/routes/files.py`)
- [ ] `GET /files` — list all files (paginated, category filter, cached)
  - Query params: `offset`, `limit`, `category`, `refresh`
  - Fix: Use GET not POST for reads
- [ ] `GET /files/search` — search by filename
  - Query params: `q`
- [ ] `GET /file/{msg_id}` — **stream** file using `StreamingResponse` + `iter_download`
  - Fix P1 from TECH_DEBT.md — no more full RAM load
  - Add `Content-Length` header
  - Add HTTP `Range` request support (fix A2 from TECH_DEBT.md)
  - Separate `?download=true` flag → sets `Content-Disposition: attachment`
- [ ] `GET /thumbnail/{msg_id}` — serve cached thumbnail (same logic, keep disk cache)
- [ ] `POST /upload` — multipart file upload → Telegram (fix temp file cleanup)
- [ ] `POST /files/move` — move files to folder (use asyncio.gather)
- [ ] `DELETE /files` — delete files (batched, keep 100-chunk logic)

### 1.7 — Routes: Folders (`backend/routes/folders.py`)
- [ ] `GET /folders` — list folders from SQLite (no Telegram call needed)
- [ ] `POST /folders` — create folder
- [ ] `PUT /folders/{name}` — rename folder (parallel edits with asyncio.gather)
- [ ] `DELETE /folders/{name}` — delete folder label
- [ ] `GET /folders/{name}/files` — list files in folder (use all_files cache)
- [ ] `GET /folders/counts` — file counts per folder (derive from all_files cache)

### 1.8 — App entry point (`backend/main.py`)
- [ ] Mount all routers
- [ ] Serve existing HTML files from root (Setup, Login, Dashboard)
- [ ] Mount `/static` for CSS
- [ ] CORS config (localhost only for now)
- [ ] Startup: init DB, run session cleanup background task
- [ ] Background task: sweep expired sessions every 15 minutes

### 1.9 — Run + verify
- [ ] `uvicorn backend.main:app --reload --port 5001`
- [ ] Test all existing HTML pages still work against new backend
- [ ] Check: file streaming works (video seekable, no RAM spike)
- [ ] Check: upload cleans up temp files even on error

---

## Phase 2 — SQLite Migration Polish
> Goal: Clean up all data layer issues from TECH_DEBT.md.
> Phase 1 gets SQLite working; Phase 2 makes it solid.

### 2.1 — Cache layer
- [ ] Move `_cache` dict → `backend/cache.py`
- [ ] Add background sweep for expired cache entries (every 5 min)
- [ ] Make `list_files_in_folder` use the `all_files` cache (fix P5 / TECH_DEBT.md)
- [ ] Make `folder_counts` derive from `all_files` cache (fix P4 / TECH_DEBT.md)

### 2.2 — Consistent error responses
- [ ] Standardize all error responses: `{"status": "error", "message": "..."}`
- [ ] Fix `security.py` rate limit response to match (fix A4 / TECH_DEBT.md)
- [ ] Return JSON from all 404/500 paths

### 2.3 — Expose scan limit to the user
- [ ] Add `GET /files/stats` endpoint returning `{total_scanned, scan_limit, has_more}`
- [ ] UI can show a warning banner if `has_more` is true

---

## Phase 3 — React + Vite Frontend Scaffold
> Goal: Get the React app running with auth flow (Setup → Login → Dashboard shell).
> No file features yet — just the skeleton.

### 3.1 — Vite setup
- [ ] `npm create vite@latest frontend -- --template react-ts`
- [ ] Install deps: `zustand`, `react-router-dom`
- [ ] Copy existing `static/style.css` into `frontend/src/style.css`
- [ ] Configure Vite proxy: `/api` → `http://localhost:5001` in dev
- [ ] Build output → `../static/` so FastAPI can serve it

### 3.2 — API client (`frontend/src/api/client.ts`)
- [ ] Typed fetch wrapper with automatic CSRF header injection
- [ ] Auto-redirect to `/login` on 401
- [ ] All endpoints typed with TypeScript interfaces
- [ ] Named exports for every endpoint: `listFiles()`, `uploadFiles()`, etc.

### 3.3 — Zustand store (`frontend/src/store/index.ts`)
- [ ] `folders: Folder[]`
- [ ] `files: File[]` (accumulated, replaces `window.__afc`)
- [ ] `selectedIds: Set<number>`
- [ ] `currentFolder: string | null`
- [ ] `currentView: 'folders' | 'all' | 'search'`
- [ ] `isLoading: boolean`
- [ ] Actions: `setFolders`, `appendFiles`, `toggleSelect`, `clearSelection`, `setView`

### 3.4 — Pages
- [ ] `Setup.tsx` — API credentials form (replace `setup.html`)
- [ ] `Login.tsx` — phone/OTP/2FA multi-step (replace `login.html`)
- [ ] `Dashboard.tsx` — shell layout with header, folder grid area, file area

### 3.5 — Routing
- [ ] `/` → redirect to `/login` or `/dashboard` based on auth state
- [ ] `/setup` → `Setup.tsx`
- [ ] `/login` → `Login.tsx`
- [ ] `/dashboard` → `Dashboard.tsx` (protected route)

---

## Phase 4 — React Feature Implementation
> Goal: Full feature parity with the current app, properly implemented.

### 4.1 — Folder grid (`FolderGrid.tsx`)
- [ ] Render folders from Zustand store (not from DOM)
- [ ] Rename inline (click edit → input in place)
- [ ] Delete with confirmation modal (not `window.confirm`)
- [ ] Load folders + counts in parallel (`Promise.all`)
- [ ] No layout shift — counts load in the same render pass

### 4.2 — File card (`FileCard.tsx`)
- [ ] Props: `file`, `selected`, `onToggle`, `onOpen`
- [ ] `textContent` for filename — no `innerHTML` (fixes XSS from SECURITY_NOTES.md)
- [ ] Thumbnail via `/thumbnail/{id}` with `loading="lazy"`
- [ ] Broken image `onError` fallback → show file type icon
- [ ] Download link → `/file/{id}?download=true`

### 4.3 — File grid (`FileGrid.tsx`)
- [ ] Virtualized list (use `react-window` or `react-virtual`) — fixes P3 / TECH_DEBT.md
- [ ] Sort: client-side on loaded data
- [ ] Select all / clear selection
- [ ] Toolbar: move, delete (shown when selection > 0)
- [ ] Request cancellation with `AbortController` on view switch (fixes S1 / TECH_DEBT.md)

### 4.4 — Upload zone (`UploadZone.tsx`)
- [ ] Drag and drop (same as current)
- [ ] Per-file progress (XHR with onprogress)
- [ ] Per-file success/error result (fixes E1 / TECH_DEBT.md)
- [ ] Disable upload button while in-flight

### 4.5 — Gallery (`Gallery.tsx`)
- [ ] Use thumbnail for initial display, full-res on explicit zoom
- [ ] Keyboard navigation (arrow keys, Escape)
- [ ] Broken image fallback

### 4.6 — Preview modal (`PreviewModal.tsx`)
- [ ] Video: uses `/file/{id}` with Range support → seeking works
- [ ] Audio: same
- [ ] PDF: `<iframe>` (same as current)
- [ ] `textContent` for filename in modal header

### 4.7 — Search (`SearchBar.tsx`)
- [ ] 300ms debounce on keyup
- [ ] Filter local store first (instant, free)
- [ ] Fall back to `/files/search` API call only if cache is cold
- [ ] Clear button

### 4.8 — All Files view
- [ ] Category filter — client-side filter on store data (no new API call)
- [ ] Sort — client-side
- [ ] Paginated load more — append to store, re-render only new cards
- [ ] Scan limit warning banner if `has_more` is true

### 4.9 — Loading states + error handling (fixes E5 / TECH_DEBT.md)
- [ ] Every button that triggers an API call: disabled + spinner during request
- [ ] Every list/grid: skeleton placeholder before first load
- [ ] Toast for all errors (not just some)
- [ ] Network error handling on all fetch calls

---

## Phase 5 — Polish + Production Ready
> Goal: Make it feel like a real app.

### 5.1 — Performance
- [ ] `React.memo` on `FileCard` to prevent unnecessary re-renders
- [ ] `useMemo` for sorted/filtered file lists
- [ ] Thumbnail `IntersectionObserver` lazy loading

### 5.2 — Consent + privacy pages
- [ ] Migrate `consent.html` and `privacy_policy.html` to React components

### 5.3 — Production build
- [ ] `vite build` → output to `backend/static/`
- [ ] FastAPI serves React build as SPA (catch-all route → `index.html`)
- [ ] Single `uvicorn backend.main:app --host 0.0.0.0 --port 5001` command runs everything

### 5.4 — Deployment config
- [ ] `Procfile` or `docker-compose.yml` for easy restarts
- [ ] `SECURE_COOKIES=true` env var wired through
- [ ] Log rotation for `app.log`

---

## Notes

- **TECH_DEBT.md** — all the bugs and issues in the current app. Each one has a phase/step above that fixes it.
- **SECURITY_NOTES.md** — 4 security issues. The XSS one (innerHTML → textContent) is fixed in Phase 4.2. The rest are fixed passively by the rewrite.
- Phases 1 and 2 can be done without touching the frontend at all — the current HTML pages keep working.
- Phase 3 onwards replaces the HTML files one by one.
