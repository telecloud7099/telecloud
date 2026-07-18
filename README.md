# ☁️ TeleCloud

**Your Telegram "Saved Messages" as a personal cloud drive.**

TeleCloud turns Telegram's unlimited Saved Messages storage into a proper file manager — folders, drag-and-drop uploads, image gallery, video/audio previews with seeking, and search — all running on your machine. Your files live in *your* Telegram account; TeleCloud is just a beautiful window into them.

![Backend](https://img.shields.io/badge/backend-FastAPI-009688)
![Frontend](https://img.shields.io/badge/frontend-React%2019%20%2B%20TypeScript-61dafb)
![Database](https://img.shields.io/badge/db-PostgreSQL%20(Neon)-336791)
![Telegram](https://img.shields.io/badge/telegram-Telethon%20StringSession-2AABEE)
![Auth](https://img.shields.io/badge/auth-JWT%20HS256-orange)

---

## ✨ Features

- 📁 **Folders** — organize files into named folders (create / rename / delete)
- ⬆️ **Upload** — drag & drop multiple files with per-file progress
- 📦 **Large file upload** — files past Telegram's per-document cap are split into chunks, each uploaded as its own Saved Messages document and reassembled on download; uploads ≥10 MB use a durable, resumable session that survives a page refresh and retries only the failed part instead of the whole file
- 🖼️ **Image gallery** — grid thumbnails with keyboard navigation and full-res click-through
- 🎬 **Streaming previews** — video & audio play with **seeking** (HTTP Range / 206 Partial Content)
- 📄 **PDF preview** — inline iframe viewer on desktop, open-in-tab on mobile
- 🔍 **Search** — instant client-side filtering across all files
- ⚡ **Fast** — file index cached in memory (1-hour TTL), single JOIN query on DB miss
- 🔐 **Secure** — JWT auth, Fernet-encrypted credentials at rest, rate limiting

---

## 🏗️ How It Works

```
┌─────────────┐     HTTP/JWT    ┌──────────────────┐    MTProto    ┌──────────────┐
│   Browser    │ ─────────────► │  FastAPI backend  │ ────────────► │   Telegram    │
│  (React SPA) │ ◄───────────── │  (port 5001)      │ ◄──────────── │ Saved Messages│
└─────────────┘                 └──────────────────┘               └──────────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │  Neon PostgreSQL  │
                                │  (users, files,   │
                                │   folders, etc.)  │
                                └──────────────────┘
```

- **Files** are stored as media messages in your Telegram **Saved Messages** — nothing is stored on a third-party server.
- **Folders** are implemented as message captions + a row in PostgreSQL. Moving a file just updates its `folder_id`.
- **The file index** (names, sizes, types, dates) is scanned from Telegram once, cached in memory, and synced on demand.
- **Thumbnails** are downloaded from Telegram and cached on disk in `thumbs/`.
- **Auth** uses JWT HS256 tokens (30-day expiry) stored in `localStorage`. Media endpoints (`/file/`, `/thumbnail/`) also accept the token via `?token=` query param so `<img>` / `<video>` / `<audio>` src attributes work natively.

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Backend | [FastAPI](https://fastapi.tiangolo.com/) (async) + Uvicorn |
| Telegram client | [Telethon](https://docs.telethon.dev/) StringSession (MTProto) |
| Database | PostgreSQL via [SQLModel](https://sqlmodel.tiangolo.com/) / SQLAlchemy |
| Hosted DB | [Neon](https://neon.tech/) (serverless PostgreSQL) |
| Encryption | Fernet (`cryptography`) for API credentials + StringSession at rest |
| Auth | JWT HS256 — `python-jose` / `PyJWT` |
| Frontend | React 19 + TypeScript + [Vite](https://vitejs.dev/) |
| State | [Zustand](https://zustand-demo.pmnd.rs/) |
| Routing | React Router 7 |
| Toasts | Sonner |

---

## 📂 Project Structure

```
telecloud/
├── backend/
│   ├── main.py               # App entry: CORS, routers, SPA serving, maintenance loop
│   ├── auth.py               # JWT creation/verification; get_current_user + get_media_user deps
│   ├── database.py           # SQLModel tables, all DB helpers, in-memory credential cache
│   ├── telegram_client.py    # Telethon client pool, backoff, asyncio timeout guard
│   ├── cache.py              # In-memory TTL cache (1 hour) with periodic sweep
│   ├── security.py           # Rate limiting, file validation, input sanitization
│   └── routes/
│       ├── auth.py           # Setup, OTP login, 2FA, logout, account deletion
│       ├── files.py          # List, search, stream, upload, move, delete, thumbnails
│       └── folders.py        # Folder CRUD + per-folder file listing + counts
│
├── frontend/
│   └── src/
│       ├── api/client.ts     # Typed API layer, JWT injection, 401 redirect
│       ├── store/index.ts    # Zustand store (files, folders, selection, view state)
│       ├── pages/            # Setup, Login, Dashboard, Consent, PrivacyPolicy
│       ├── components/       # FileGrid, FolderGrid, Gallery, PreviewModal,
│       │                     # UploadZone, SearchBar, ConfirmModal, FileCard
│       └── hooks/            # useLazyLoad (IntersectionObserver for lazy thumbnails)
│
├── static/app/               # Production build output (gitignored — run npm run build)
├── thumbs/                   # Thumbnail disk cache (gitignored)
├── uploads/                  # Temp upload staging area (gitignored)
├── start.sh                  # One-command run: build frontend if stale + start server
├── requirements.txt
└── .env.example              # Template for all required environment variables
```

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.10+**
- **Node.js 18+** (to build the frontend)
- A **Telegram account**
- **Telegram API credentials** — get them free at [my.telegram.org](https://my.telegram.org) → *API development tools* → create an app → copy `api_id` and `api_hash`
- A **PostgreSQL database** — [Neon](https://neon.tech/) has a free tier that works out of the box

### 1. Clone & install

```bash
git clone https://github.com/telecloud7099/telecloud.git
cd telecloud

# Python dependencies
pip install -r requirements.txt

# Frontend dependencies
cd frontend && npm install && cd ..
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```bash
# PostgreSQL connection string (Neon or any PostgreSQL)
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require

# JWT signing secret — generate one:
# python3 -c "import secrets; print(secrets.token_hex(32))"
JWT_SECRET=your_jwt_secret_here

# Fernet key for encrypting API credentials + sessions at rest — generate one:
# python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
ENCRYPTION_KEY=your_fernet_key_here
```

### 3. Build frontend & run

```bash
# Build the React app into static/app/
cd frontend && npm run build && cd ..

# Start the server
python -m uvicorn backend.main:app --host 0.0.0.0 --port 5001
```

Or use the convenience script:

```bash
./start.sh
```

Open **http://localhost:5001**

### 4. First-time setup in the browser

1. **Setup page** — paste your `api_id` and `api_hash` from my.telegram.org
2. **Login** — enter your phone number → Telegram sends a code → enter it (+ 2FA password if enabled)
3. **Done** — your Saved Messages files appear; create folders and start organizing

---

## 🛠️ Development

Run backend and frontend separately with hot reload:

```bash
# Terminal 1 — backend with auto-reload
python -m uvicorn backend.main:app --reload --port 5001

# Terminal 2 — Vite dev server with HMR (proxies /api calls to :5001)
cd frontend && npm run dev    # → http://localhost:5173
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | Secret for signing JWT tokens (use a long random hex string) |
| `ENCRYPTION_KEY` | ✅ | Fernet key for encrypting Telegram credentials at rest |
| `ALLOWED_ORIGINS` | | Comma-separated CORS origins (default: `http://localhost:5173,http://localhost:5001`) |
| `MAX_SCAN_MESSAGES` | | Max Saved Messages to scan on first sync (default: `2000`, `0` = unlimited) |
| `MAX_UPLOAD_SIZE_MB` | | Cap for single-shot `/upload` before a file must go through chunked sessions (default: `500`) |
| `RESUMABLE_UPLOAD_THRESHOLD_MB` | | File size at/above which uploads use the durable, resumable session flow (default: `10`) |
| `UPLOAD_SESSION_EXPIRE_SECONDS` | | How long an abandoned upload session is kept before being reaped (default: `604800`, 7 days) |

---

## 🔌 API Reference

All endpoints require `Authorization: Bearer <token>` except login/setup routes.
Media endpoints (`/file/`, `/thumbnail/`) also accept `?token=<jwt>` for browser `<img>`/`<video>` compatibility.

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/check-phone` | Check if API credentials exist for a phone |
| `POST` | `/setup-api` | Store Telegram `api_id`/`api_hash` (encrypted) |
| `POST` | `/send_code` | Send OTP to phone via Telegram |
| `POST` | `/verify_code` | Verify OTP → returns JWT |
| `POST` | `/verify_password` | 2FA cloud-password verification → returns JWT |
| `GET` | `/me` | Current user info |
| `POST` | `/logout` | Disconnect Telegram client |
| `POST` | `/delete_data` | Wipe all data for the account |

### Files
| Method | Path | Description |
|---|---|---|
| `GET` | `/files` | Paginated file list (`offset`, `limit`, `category`, `refresh`) |
| `GET` | `/files/search?q=` | Search by filename |
| `GET` | `/files/stats` | Cache/scan status |
| `POST` | `/files/sync` | Incremental sync of new Telegram messages |
| `GET` | `/file/{msg_id}` | Stream file — supports HTTP `Range` for video seeking |
| `GET` | `/thumbnail/{msg_id}` | Disk-cached thumbnail (JPEG) |
| `POST` | `/upload` | Multipart upload → sends to Telegram Saved Messages (single-shot, for files under the resumable threshold) |
| `POST` | `/files/move` | Move files to a folder |
| `DELETE` | `/files` | Delete files (from Telegram + DB) |

### Chunked / resumable uploads
| Method | Path | Description |
|---|---|---|
| `POST` | `/uploads` | Create an upload session for a large file (`{chunked: false}` if under the resumable threshold — use `/upload` instead) |
| `GET` | `/uploads` | List this user's still-uploading sessions — used to reattach the progress widget after a page refresh |
| `GET` | `/uploads/{session_id}` | Session status + live server→Telegram progress for the part in flight |
| `PUT` | `/uploads/{session_id}/parts/{part_number}` | Upload one part |
| `POST` | `/uploads/{session_id}/complete` | Finalize once all parts are confirmed → creates the `files` row |
| `DELETE` | `/uploads/{session_id}` | Abort a session and clean up any Telegram parts already sent |

### Folders
| Method | Path | Description |
|---|---|---|
| `GET` | `/folders` | List all folders |
| `GET` | `/folders/counts` | File count + total size per folder |
| `POST` | `/folders` | Create folder |
| `PUT` | `/folders/{name}` | Rename folder |
| `DELETE` | `/folders/{name}` | Delete folder (files stay in Telegram, unassigned) |
| `GET` | `/folders/{name}/files` | Files in a specific folder |

---

## 🗄️ Database Schema

| Table | Purpose |
|---|---|
| `users` | Telegram user id, username, first name |
| `user_api_credentials` | Encrypted `api_id` + `api_hash` per user |
| `user_sessions` | Encrypted Telethon StringSession per user |
| `folders` | Named folders per user |
| `files` | File index synced from Telegram (name, size, mime, category, folder) |
| `upload_sessions` | In-progress/completed large-file uploads (filename, total size, chunk size, status) |
| `file_chunks` | Confirmed parts of a chunked upload, each its own Telegram document |
| `sync_state` | Last sync timestamp + newest message id per user |
| `user_settings` | Per-user preferences (theme, scan limit, etc.) |

---

## 🔐 Security Model

- JWT tokens (HS256, 30-day expiry) stored in `localStorage`; validated on every request
- Telegram API credentials and StringSession encrypted with **Fernet** (`ENCRYPTION_KEY`)
- Phone numbers stored as **SHA-256 hashes**, never in plaintext
- **Rate limiting** on all mutating endpoints
- **30-second backoff** after Telegram connection failure — prevents cascade timeouts
- Media endpoints accept `?token=` query param (for `<img src>`) but write endpoints are header-only
- `.env`, session data, database dumps, thumbnails, and uploads are **gitignored**

---

## ⚠️ Limitations

- Single-shot uploads (`/upload`) are capped at `MAX_UPLOAD_SIZE_MB` (default 500 MB); larger files automatically use the chunked/resumable session flow instead, split into ≤1.9 GB (free) / ≤3.9 GB (Premium) Telegram documents per part
- Initial scan covers the `MAX_SCAN_MESSAGES` most-recent Saved Messages (raise or set `0` for unlimited)
- One Telegram account per server instance
- Deleting a file in TeleCloud permanently deletes the Saved Message from Telegram

---

## 📄 License

Personal project — no license granted yet. All rights reserved.
