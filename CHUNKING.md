# Large-File Chunking — TeleCloud

> How TeleCloud supports files larger than Telegram's per-document cap (2 GiB free / 4 GiB
> Premium) by splitting them into multiple Telegram documents ("parts") while the UI shows
> a single file. Written after implementing and live-testing the feature end-to-end against
> a real Telegram account.

---

## 1. Concept

A large upload is split into parts of ~1900 MiB (free accounts) or ~3900 MiB (Premium),
each sent as its own Telegram document. Metadata linking the parts back together lives in
Postgres (`FileChunk`, `UploadSession`), with a self-describing message caption on each part
so the grouping can be reconstructed from Telegram alone if Postgres is ever wiped. Files
below the threshold are completely unaffected — they still go through the original
single-message `/upload` endpoint.

## 2. File identity changed to UUID

Every file — chunked or not — is now addressed by `TelegramFile.id` (a UUID), not the
Telegram `message_id`. This was a breaking API change, done because a chunked file has no
single message to identify it by:

- `GET /files`, `GET /folders/{name}/files`, `GET /files/search` now return `"id"` as a UUID string.
- `GET /file/{file_id}` and `GET /thumbnail/{file_id}` take a UUID path param.
- `POST /files/move` and `DELETE /files` take `file_ids: string[]` (previously `msg_ids: number[]`).

Non-chunked files are otherwise handled exactly as before — same Telegram calls, same
thumbnail caching, same everything — just addressed by a different key.

## 3. New database models (`backend/database.py`)

**`TelegramFile`** (existing table, new columns):
- `is_chunked: bool` (default `False`)
- `chunk_count: int` (default `1`)
- `content_signature: Optional[str]` — sha256 of the concatenation of each part's sha256.
  Cheap whole-file integrity check without re-hashing gigabytes on every access.
- `telegram_message_id` is now nullable (null for chunked files, which have no single message).

**`FileChunk`** (new table): one row per part.
- `session_id` — FK to `UploadSession.id`. Non-null; this is the durable grouping key even
  before the file exists.
- `file_id` — FK to `TelegramFile.id`. Null until the session completes.
- `part_number`, `telegram_message_id`, `size`, `sha256`.
- Unique on `(session_id, part_number)` — enforced at the session level because `file_id`
  is null for most of a part's life.

**`UploadSession`** (new table): tracks one in-progress or completed large upload.
- `chunk_size`, `total_chunks`, `next_part_number`, `bytes_uploaded`.
- `status`: `uploading | completed | aborted`.
- `file_id` — set once the session completes.

Migration is additive and idempotent (`_apply_migrations()` in `database.py`) — safe to run
against a live database with existing data.

## 4. Endpoints (`backend/routes/upload.py`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/uploads` | Create a session. If the file fits in one Telegram document, returns `{"chunked": false}` and no session is created — caller should use `/upload` instead. |
| GET | `/uploads/{session_id}` | Status: `next_part_number`, `bytes_uploaded`, `total_chunks`, `session_status`. Used to resume after a reload. |
| PUT | `/uploads/{session_id}/parts/{part_number}` | Streams one part's body to Telegram. Idempotent — re-uploading an already-confirmed part is a no-op. |
| POST | `/uploads/{session_id}/complete` | Finalizes the `TelegramFile` row once all parts are confirmed. Idempotent. |
| DELETE | `/uploads/{session_id}` | Aborts a session, deleting any Telegram parts already sent. |

All require the same JWT auth as the rest of the API (`get_current_user`), and every session
lookup checks `telegram_user_id` ownership before returning anything.

## 5. Upload flow

1. Frontend (`frontend/src/api/chunkedUpload.ts`) checks the file size against
   `CHUNK_PROBE_THRESHOLD` (1900 MiB, the smaller of the two possible caps) in
   `UploadZone.tsx`. Below it, the file goes through the existing single-shot `/upload` path
   unchanged.
2. At or above it, `POST /uploads` asks the backend. The backend detects Premium status via
   `client.get_me()` (cached per user) to pick the real chunk size. If the file actually fits
   (e.g. a Premium account's 3.9 GiB cap), the backend says `chunked: false` and the frontend
   falls back to the plain endpoint (`NotChunkedError` in `chunkedUpload.ts`).
3. Otherwise, the frontend slices the `File` with `.slice()` and `PUT`s each part in sequence
   (`backend/chunk_upload.py: receive_part`), which streams the request body to a bounded
   temp file, hashes it incrementally, uploads it to Telegram, and records a `FileChunk` —
   never buffering a whole part in memory.
4. After the last part, `POST /uploads/{id}/complete` creates the `TelegramFile` row and
   marks the session completed.

**Resumability** is part-level, not byte-level: if a part's single HTTP request fails or the
page reloads mid-upload, the frontend caches `session_id` in `localStorage` (keyed by
filename + size + `lastModified`) and re-queries `GET /uploads/{id}` on the next attempt to
learn `next_part_number`, resuming from there rather than restarting the whole file. A part
that fails mid-transfer is retried from byte 0, not resumed mid-part — this was an explicit
scope decision (see §8).

## 6. Download flow (`backend/chunk_download.py`)

`GET /file/{file_id}` branches on `TelegramFile.is_chunked`:

- **Not chunked** — identical to the original code path.
- **Chunked** — loads ordered `FileChunk` rows and computes cumulative byte offsets
  (`ChunkPlan`). A request with no `Range` header chains each part's `iter_download` into one
  streaming response — no temp file, no merge step. A `Range` request maps the byte window
  across chunk boundaries, partially downloading the first/last part and streaming any
  fully-covered middle parts whole, so video scrubbing works exactly like it does for
  non-chunked files.

Telethon's `iter_download(..., limit=...)` counts **chunks, not bytes** — this was a real gap
found while building `_iter_exact` in `chunk_download.py`. Byte-exact ranges are enforced by
manually stopping consumption once enough bytes are yielded, not by relying on `limit`.

## 7. Scan-based disaster recovery (`_full_scan` / `_incremental_sync` in `routes/files.py`)

Each part's Telegram message carries a caption (not filename — see below) of the form:

```
__tc_chunk__:<group_id>:<part_number>:<total_chunks>:<original_filename>
```

`group_id` is the `UploadSession.id`. During a scan, messages with this caption are pulled
out of the normal file list and grouped by `group_id`. If Postgres already knows the session
(`get_user_session_ids`), the messages are skipped — they're already properly tracked. If the
session is unknown (a fresh device or a DB wipe) and **all** of its parts are present in the
scanned window, `recover_chunked_file` reconstructs the `TelegramFile` + `FileChunk` rows
from scratch, synthesizing a `completed` `UploadSession` to satisfy the FK. An incomplete
group (not all parts seen yet) is left alone rather than partially reconstructed — it's
picked up whenever a scan happens to see all of its parts together.

**Why the caption, not the filename:** the first implementation embedded this metadata in
the uploaded document's filename. Live testing against the real account found that Telegram
silently rewrites filenames containing certain patterns — a `.bin.` middle segment caused
every dot and hyphen in the whole name to be replaced with `_` (looks like anti "double
extension" spoofing protection), while e.g. `.mkv.` did not trigger it. Since this depends on
the original filename's content in an unpredictable way, it isn't a safe channel for
metadata that must round-trip exactly. Captions are plain message text and are never
rewritten — verified empirically — so they're the only reliable channel. This also resolves
a design conflict: captions are already used to encode folder name for non-chunked files
during scan-based folder assignment; chunked files simply don't participate in that
convention, which is fine since a chunked file's folder assignment is always a Postgres-side
decision made at upload time, never inferred from a scan.

## 8. Recovery invariants and maintenance sweeps

**The only durable truth is a confirmed `FileChunk` row.** Everything else — a part's temp
file, an in-progress `UploadSession` — is disposable and safely regenerable:

- Temp files (`uploads/_parts/{session_id}_{part_number}.tmp`) are always opened in truncate
  (`wb`) mode, so a crash mid-write just leaves garbage that a retried PUT overwrites from
  byte 0. Verified live: planting garbage bytes at the exact temp path before a real PUT
  produced the correct final upload, untouched by the pre-existing content.
- `chunk_upload_sweep()` (in `chunk_upload.py`) deletes any temp file untouched for over an
  hour, catching anything orphaned by a hard crash.
- `session_sweep()` (in `upload_sessions.py`) expires sessions with no activity for 7 days
  (`UPLOAD_SESSION_EXPIRE_SECONDS`), cleaning up any Telegram parts they already sent. The
  long default window means a legitimately slow/paused upload is never killed prematurely.

Both sweeps run from `main.py`'s existing 900-second maintenance loop, alongside the
pre-existing cache and rate-limit sweeps.

## 9. Known v1 limitations

- **Part-level resumability only.** A part that fails mid-transfer restarts from byte 0, not
  from the byte it failed at. Deliberate scope decision to keep the client-side upload logic
  simple; the part size (~1.9–3.9 GiB) makes a full retry costly on a bad connection, but not
  broken.
- **Sequential uploads only.** No parallel part-upload workers in v1.
- **No encryption or deduplication.** Deferred; the modular split (separate session/upload/
  download/hashing modules) was chosen specifically so these can slot in later without
  touching unrelated code.
- **Best-effort thumbnails for chunked files.** `/thumbnail/{file_id}` for a chunked file
  tries part 1's Telegram-generated thumbnail and falls back to a generic icon if Telegram
  didn't produce one — since part 1 is an arbitrary byte slice, not necessarily a decodable
  media header (e.g. mp4's `moov` atom can be at the end of the file). Playback/scrubbing
  itself is unaffected; only the static preview image is best-effort.
- **Scan reconciliation is scoped to what's seen in one scan pass.** If a chunk group's parts
  are split across multiple `_incremental_sync` windows (200 messages each), it may not be
  reconstructed until a full re-scan sees all of them together. In practice this only matters
  after a Postgres wipe — a normal in-flight upload is already fully tracked in Postgres by
  the API itself and never needs scan reconciliation.
- **No cleanup for orphaned parts from an incomplete disaster-recovery group.** If Postgres
  is wiped mid-upload and only some parts survive in Telegram, those messages sit there
  untracked indefinitely (harmless, but not surfaced anywhere for manual cleanup).
