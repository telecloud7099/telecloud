# ☁️ TeleCloud

**Your Telegram "Saved Messages" as a personal cloud drive.**

TeleCloud turns Telegram's unlimited Saved Messages storage into a proper file manager — folders, drag-and-drop uploads, image gallery, video previews with seeking, and search — all running locally on your machine. Your files live in *your* Telegram account; TeleCloud is just a beautiful window into them.

![Stack](https://img.shields.io/badge/backend-FastAPI-009688) ![Stack](https://img.shields.io/badge/frontend-React%2019%20%2B%20TypeScript-61dafb) ![Stack](https://img.shields.io/badge/db-SQLite-003B57) ![Stack](https://img.shields.io/badge/telegram-Telethon-2AABEE)

---

## ✨ Features

- 📁 **Folders** — organize Saved Messages files into named folders (create / rename / delete)
- ⬆️ **Upload** — drag & drop multiple files with per-file progress
- 🖼️ **Gallery** — image grid with cached thumbnails and keyboard navigation
- 🎬 **Streaming previews** — video/audio play with **seeking** (HTTP Range / 206 Partial Content), no full download needed
- 🔍 **Search** — instant client-side filtering, API fallback for cold cache
- 📄 **Previews** — images, video, audio, and PDFs in a modal
- ⚡ **Fast** — file index cached in SQLite, incremental sync from Telegram
- 🔐 **Private by design** — runs on `127.0.0.1`, credentials encrypted at rest, nothing leaves your machine except Telegram API calls

---

## 🏗️ How It Works

```
┌─────────────┐     HTTP      ┌──────────────────┐    MTProto    ┌──────────────┐
│   Browser    │ ───────────► │  FastAPI backend  │ ────────────► │   Telegram    │
│  (React SPA) │ ◄─────────── │  (port 5001)      │ ◄──────────── │ Saved Messages│
└─────────────┘               └──────────────────┘               └──────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ SQLite + caches   │
                              │ telecloud.db      │
                              │ thumbs/ sessions/ │
                              └──────────────────┘
```

- **Files** are stored as media messages in your Telegram **Saved Messages** — nothing is stored on a third-party server.
- **Folders** are implemented as message captions (`folder: <name>`) plus a row in SQLite — moving a file just edits its caption.
- **The file index** (names, sizes, types, dates) is scanned from Telegram once, cached in SQLite, and incrementally synced afterwards.
- **Thumbnails** are downloaded once and cached on disk in `thumbs/`.

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Backend | [FastAPI](https://fastapi.tiangolo.com/) (async) + Uvicorn |
| Telegram client | [Telethon](https://docs.telethon.dev/) (MTProto) |
| Database | SQLite via [SQLModel](https://sqlmodel.tiangolo.com/) |
| Encryption | Fernet (`cryptography`) for API credentials at rest |
| Frontend | React 19 + TypeScript + [Vite](https://vitejs.dev/) |
| State | [Zustand](https://zustand-demo.pmnd.rs/) |
| Routing | React Router 7 |
| Toasts | Sonner |

---

## 📂 Project Structure

```
telecloud/
├── backend/                  # FastAPI application
│   ├── main.py               # App entry: middleware, routers, SPA serving, maintenance loop
│   ├── auth.py               # Session tokens, CSRF (double-submit cookie), auth dependency
│   ├── database.py           # SQLModel tables + all DB operations
│   ├── telegram_client.py    # Telethon client pool (one client per logged-in phone)
│   ├── cache.py              # In-memory TTL cache with periodic sweep
│   ├── security.py           # Rate limiting + input validation
│   └── routes/
│       ├── auth.py           # Setup, login (OTP + 2FA), logout, account deletion
│       ├── files.py          # List, search, stream, upload, move, delete, thumbnails
│       └── folders.py        # Folder CRUD + per-folder file listing + counts
│
├── frontend/                 # React SPA source
│   ├── src/
│   │   ├── api/client.ts     # Typed API layer, CSRF injection, 401 handling
│   │   ├── store/index.ts    # Zustand store (files, folders, selection, view)
│   │   ├── pages/            # Setup, Login, Dashboard, Consent, PrivacyPolicy
│   │   ├── components/       # FileGrid, FolderGrid, Gallery, PreviewModal,
│   │   │                     # UploadZone, SearchBar, ConfirmModal, FileCard
│   │   └── hooks/            # useLazyLoad (IntersectionObserver thumbnails)
│   └── vite.config.ts        # Dev proxy → :5001, build → ../static/app
│
├── static/app/               # Production build output (gitignored, auto-generated)
├── sessions/                 # Telethon session files (gitignored — your TG login!)
├── thumbs/                   # Thumbnail disk cache (gitignored)
├── telecloud.db              # SQLite database (gitignored)
├── start.sh                  # One-command run: build frontend if stale + start server
├── requirements.txt
└── .env.example              # Template for required environment variables
```

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.9+**
- **Node.js 18+** (only needed to build the frontend)
- A **Telegram account**
- **Telegram API credentials** — get them free at [my.telegram.org](https://my.telegram.org) → *API development tools* → create an app → copy `api_id` and `api_hash`

### 1. Clone & install

```bash
git clone https://github.com/revanth4033/telecloud.git
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

Generate the encryption key and put it in `.env`:

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### 3. Run

```bash
./start.sh
```

This builds the frontend (only when source changed) and starts the server. Open:

**http://127.0.0.1:5001**

### 4. First-time setup in the browser

1. **Setup page** — paste your `api_id` and `api_hash` from my.telegram.org
2. **Login** — enter your phone number → Telegram sends you a code → enter it (+ 2FA password if you have one)
3. **Done** — your Saved Messages files appear; create folders and start organizing

---

## 🛠️ Development

Run backend and frontend separately with hot reload:

```bash
# Terminal 1 — backend with auto-reload
python3 -m uvicorn backend.main:app --reload --port 5001

# Terminal 2 — Vite dev server with HMR (proxies API calls to :5001)
cd frontend && npm run dev    # → http://localhost:5173
```

Production build only:

```bash
cd frontend && npm run build   # outputs to static/app/
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | — **(required)** | Fernet key used to encrypt API credentials in SQLite |
| `HOST` | `127.0.0.1` | Server bind address (keep localhost unless you know what you're doing) |
| `PORT` | `5001` | Server port |
| `SECURE_COOKIES` | `false` | Set `true` when serving over HTTPS |
| `MAX_SCAN_MESSAGES` | `2000` | Max Saved Messages scanned when building the file index (`0` = unlimited) |
| `SESSION_TIMEOUT` | `604800` | Web session lifetime in seconds (7 days) |
| `API_SESSION_TTL` | `604800` | How long stored API credentials live before purge (7 days) |
| `DATABASE_URL` | `sqlite:///telecloud.db` | SQLModel database URL |

---

## 🔌 API Reference

All endpoints are JSON over HTTP. Authenticated routes require the session cookie + `X-CSRF-Token` header (double-submit pattern).

### Auth
| Method | Path | Description |
|---|---|---|
| `GET` | `/has-setup` | Whether API credentials are configured for this browser |
| `POST` | `/setup-api` | Store Telegram `api_id`/`api_hash` (encrypted) |
| `POST` | `/send_code` | Send OTP to phone via Telegram |
| `POST` | `/verify_code` | Verify OTP → sets session cookie |
| `POST` | `/verify_password` | 2FA cloud-password verification |
| `GET` | `/me` | Current session's phone + setup state |
| `POST` | `/logout` | Destroy session, disconnect Telegram client |
| `POST` | `/delete_data` | Wipe all local data for the account |

### Files
| Method | Path | Description |
|---|---|---|
| `GET` | `/files?offset=&limit=&category=&refresh=` | Paginated file list (cached) |
| `GET` | `/files/search?q=` | Search by filename |
| `GET` | `/files/stats` | Scan limit / has-more info |
| `POST` | `/files/sync` | Incremental sync of new messages |
| `GET` | `/file/{msg_id}` | **Stream** file — supports HTTP `Range` (`?download=true` for attachment) |
| `GET` | `/thumbnail/{msg_id}` | Cached thumbnail |
| `POST` | `/upload` | Multipart upload → Telegram |
| `POST` | `/files/move` | Move files to a folder (parallel caption edits) |
| `DELETE` | `/files` | Delete files (batched) |

### Folders
| Method | Path | Description |
|---|---|---|
| `GET` | `/folders` | List folders |
| `GET` | `/folders/counts` | File count + size per folder |
| `POST` | `/folders` | Create folder |
| `PUT` | `/folders/{name}` | Rename (rewrites captions in parallel) |
| `DELETE` | `/folders/{name}` | Delete folder label (files stay in Telegram) |
| `GET` | `/folders/{name}/files` | Files in a folder |

---

## 🗄️ Database Schema (SQLite)

| Table | Purpose |
|---|---|
| `apisession` | Encrypted Telegram API credentials, per browser session |
| `appsession` | Web login sessions (token → phone) |
| `userfolder` | Folder names per account (phone is stored as a SHA-256 hash) |
| `cachedfile` | The file index synced from Telegram |
| `syncstate` | Last sync timestamp + newest message id per account |

---

## 🔐 Security Model

- Server binds to **localhost only** by default — not reachable from the network
- Telegram API credentials are **Fernet-encrypted** in SQLite (`SECRET_KEY`)
- Phone numbers are stored as **SHA-256 hashes**, never in plaintext
- **CSRF protection** via double-submit cookie on all mutating requests
- **Rate limiting** on auth endpoints
- Session files, the database, thumbnails, and `.env` are **gitignored** — never committed
- React renders all user/server strings as text (no `innerHTML`) — XSS-safe by construction

> ⚠️ TeleCloud is designed for **personal, local use**. Before exposing it publicly you'd want HTTPS, `SECURE_COOKIES=true`, and a review of `SECURITY_NOTES.md`.

---

## ⚠️ Limitations

- Files larger than **2 GB** can't be uploaded (Telegram limit)
- The initial index scans up to `MAX_SCAN_MESSAGES` (default 2000) most-recent Saved Messages — raise it (or set `0`) if you have more
- One Telegram account per browser session
- Deleting a file in TeleCloud deletes the underlying Saved Message (that's the point — but know it!)

---

## 📚 Project Docs

| File | Contents |
|---|---|
| `IMPLEMENTATION_PLAN.md` | The Flask→FastAPI / vanilla-JS→React migration plan (completed) |
| `TECH_DEBT.md` | Catalogue of issues in the original prototype and how each was fixed |
| `SECURITY_NOTES.md` | Security review notes — items to revisit before public hosting |

---

## 📄 License

Personal project — no license granted yet. All rights reserved.
