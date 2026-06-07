# Implementation Notes — TeleCloud

> Technical debt, performance issues, and functional gaps to fix before this feels like a proper app.
> Ordered by priority within each section.

---

## Priority Fix List (Do These First)

| # | Issue | Impact |
|---|---|---|
| 1 | Stream `get_file` — don't load into RAM | Crashes on large files |
| 2 | Enable threading / Gunicorn | Server freezes during scans |
| 3 | Add HTTP Range request support | Video seeking completely broken |
| 4 | Fix download button (`attachment` vs `inline`) | Core feature doesn't work |
| 5 | Add loading states + disable buttons during requests | Biggest "rough prototype" feel |
| 6 | `AbortController` — cancel stale requests | Wrong folder contents shown |
| 7 | Make `list_files_in_folder` use the `all_files` cache | Silent data truncation |
| 8 | Surface the scan message limit to the user | Users don't know their data is incomplete |
| 9 | Move JS out of HTML into `static/app.js` | Foundation for all other frontend fixes |

---

## 1. Performance

### P1 — Entire file loaded into RAM before streaming `main.py:1136` `HIGH`
```python
file_bytes = await message.download_media(bytes)
resp = Response(file_bytes, mimetype=mime)
```
A 1.5 GB video is fully downloaded into Python memory before a single byte reaches the browser. Will OOM-crash the process on large files. Also missing `Content-Length`, so the browser shows no progress bar.

**Fix:** Use Telethon's `iter_download` and yield chunks into a Flask `Response` with `stream_with_context`.

---

### P2 — Full 2000-message scan blocks the entire server `main.py:803` `HIGH`
`run_async().result(timeout=120)` blocks the Flask thread for the entire scan duration. Flask dev server is single-threaded — every other request (clicks, navigation) freezes while the scan runs.

**Fix:** `app.run(threaded=True)` in dev, or switch to Gunicorn in production.

---

### P3 — `renderAllFiles()` wipes and rebuilds all DOM cards on every sort/filter `upload.html:473` `HIGH`
```javascript
container.innerHTML = ''; // wipes everything, rebuilds from scratch
```
Visible jank with 200+ cards. Gets worse with every "Load More" click because `window.__afc` keeps growing and every render iterates the whole array.

**Fix:** Sort the backing array and do an in-place DOM update, or use `DocumentFragment`.

---

### P4 — `folder_counts` ignores `all_files` cache and does a separate Telegram scan `main.py:962` `MEDIUM`
Fires a 500-message scan even when 2000 messages are already cached. Also runs sequentially after `loadFolders()` on init causing a two-stage render with layout shift.

**Fix:** Derive counts from the `all_files` cache. Fire `loadFolders` and `loadFolderCounts` in parallel with `Promise.all`.

---

### P5 — `list_files_in_folder` ignores the `all_files` cache — silent 200-message hard cap `main.py:755` `HIGH`
```python
messages = await client.get_messages("me", limit=200)
```
Fires a fresh Telegram scan, ignoring the existing cache. Any folder whose files fall outside the most recent 200 messages appears empty with zero warning.

**Fix:** Filter the `all_files` cache when available.

---

### P6 — `rename_folder` and `move_files_to_folder` make N sequential Telegram API calls `main.py:1008, 866` `MEDIUM`
50 files = 50 sequential `edit_message` round-trips. Telegram flood-wait limits will be hit on any realistically-sized folder, consuming the entire 120s timeout.

**Fix:** Use `asyncio.gather()` to parallelize the edits.

---

### P7 — Gallery loads full-resolution file, not the thumbnail `upload.html:273` `MEDIUM`
```javascript
galleryImg.src = `/get_file/${f.id}`; // full file, not thumbnail
```
A 12 MB photo triggers a full Telegram download just to display it at 90vw. The thumbnail endpoint already exists.

**Fix:** Use `/get_thumbnail/<id>` in gallery view. Offer full-res via the download button only.

---

### P8 — `load_user_folders` and `load_api_sessions` decrypt from disk on every request `main.py:329, 55` `LOW`
Every endpoint opens + Fernet-decrypts the file on every call. Entirely unnecessary after first load.

**Fix:** Keep an in-process dict (like `_sessions`) and write to disk only on mutations.

---

### P9 — Two separate Google Fonts `<link>` requests `upload.html:9-10` `LOW`
Two DNS lookups + TCP handshakes in the critical render path for what could be one combined URL.

**Fix:** Combine into one URL or self-host the fonts.

---

## 2. Backend Architecture

### B1 — Flask dev server, single-threaded, no production WSGI `main.py:1298` `HIGH`
`app.run(host='127.0.0.1', port=5001)` is a development server. One blocking Telegram call freezes all other requests.

**Fix:** `gunicorn -w 1 --threads 4 main:app` — but read B2 first.

---

### B2 — All state is in-memory dicts — sessions, cache, clients, OTP hashes `main.py:141, 163, 211, 233` `HIGH`
A process restart drops all active sessions and caches. With multiple Gunicorn workers, a session created on worker A is invisible to worker B → random 401s.

**Fix:** Either Redis for shared state, or single worker with `--threads N` (`gunicorn -w 1 --threads 8`).

---

### B3 — No background cleanup for `_cache`, `_clients`, or `thumbs/` `main.py:211, 163` `MEDIUM`
`_cache` entries are only evicted lazily. `_clients` holds open Telegram connections forever. `thumbs/` grows without bound — orphaned thumbnails from files deleted directly in Telegram are never removed.

**Fix:** Schedule a periodic sweep using `asyncio.ensure_future` on the background loop.

---

### B4 — Temp upload files not cleaned up on exception `main.py:649–688` `MEDIUM`
`file.save(path)` runs before the async upload. If the upload throws, the `finally` inside the coroutine never runs — temp file stays on disk. Multi-GB orphans will fill the disk over time.

**Fix:** Move cleanup to the synchronous outer `finally` block, not inside the async closure.

---

### B5 — `cleanup_expired_sessions` only called on startup and inside `send_code` `main.py:501, 1300` `LOW`
Expired sessions accumulate indefinitely unless someone happens to call `/send_code`.

**Fix:** Schedule a periodic sweep every 15 minutes on the background asyncio loop.

---

## 3. API Design

### A1 — All read operations use POST `main.py:693, 737, 777` `MEDIUM`
`/list_folders`, `/list_all_files`, `/search_files` etc. are all `POST`. POST responses are never browser-cached. Breaks HTTP semantics.

---

### A2 — No HTTP Range support on `/get_file` `main.py:1121` `HIGH`
Without Range support, video/audio seeking is broken. Every seek re-downloads the entire file from byte 0. The preview modal is practically unusable for any video file.

**Fix:** Implement `Range` header parsing and return `206 Partial Content` responses.

---

### A3 — `/list_files_in_folder` has no pagination and no `has_more` flag `main.py:773` `HIGH`
200-message hard cap. No signal to the client that results are truncated. Users see incomplete folders silently.

---

### A4 — Error response format is inconsistent `security.py:34` vs `main.py` `LOW`
`security.py` returns `{"error": "Rate limit exceeded"}` but every `main.py` handler returns `{"status": "error", "message": "..."}`. The frontend checks `d.status` — rate-limited responses silently fail since `d.status` is `undefined`.

**Fix:** Standardize all error responses to `{"status": "error", "message": "..."}`.

---

## 4. State Management

### S1 — No request cancellation — stale responses can overwrite the current view `upload.html:384` `HIGH`
Click folder A → wait → click folder B → both requests in-flight → whichever resolves last wins. The user can end up seeing files from the wrong folder. Same issue in search and category switching.

**Fix:** `AbortController` per logical view slot, abort on new request.

---

### S2 — `window.__afc` accumulates all pages without bound `upload.html:448` `MEDIUM`
```javascript
window.__afc = window.__afc.concat(d.files);
```
Every "Load More" appends to a global array on `window`. 10 pages = 500+ objects, all re-rendered on every sort change.

**Fix:** Manage as a proper module-level variable with a max size or virtual list.

---

### S3 — `loadFolderMoveSelect` and `loadFoldersForAllFiles` make redundant `/list_folders` network calls `upload.html:412, 452` `MEDIUM`
`folders[]` is already in local state. Every folder selection and every "All Files" view switch fires a fresh network call just to populate a dropdown, causing a visible empty → populated flash.

**Fix:** Populate dropdowns from the local `folders[]` array directly.

---

## 5. Code Organization

### O1 — ~350 lines of application logic inline in the HTML file `upload.html:186-550` `HIGH`
All state, API calls, render logic, and event handling in one `<script>` block. Completely untestable and unmaintainable.

**Fix:** Move to `static/app.js` with clear sections: state, API layer, render functions, event handlers.

---

### O2 — Code is manually compressed into unreadable one-liners `upload.html` throughout `MEDIUM`
Short variable names (`c`, `d`, `r`, `lm`), logic crammed on single lines. None of the readability of normal code, none of the actual size savings of a real minifier. Gzip handles compression — write readable code.

---

### O3 — `main.py` is 1302 lines — one file for 8 separate concerns `MEDIUM`
Session management, Telegram client pool, cache, file ops, auth flow, folder routes, and file routes all interleaved.

**Fix:** Split into `auth.py`, `telegram_client.py`, `cache.py`, `routes/files.py`, `routes/folders.py`.

---

### O4 — Complex async functions as inline `onclick` HTML attributes `upload.html:49, 109` `MEDIUM`
```html
<button onclick="openModal('New Folder','...','Create',async n=>{const r=await apiPost(...)...})">
```
200-character inline event handlers. Impossible to debug, blocks any meaningful CSP.

**Fix:** Replace with named functions in the JS file.

---

## 6. Error Handling

### E1 — No per-file error feedback in multi-file upload `main.py:667` `MEDIUM`
If 3 files are uploaded and the second fails, file 1 is already in Telegram, files 2–3 are lost, and the user gets a generic "Upload failed." No partial success info.

**Fix:** Collect per-file results and return a partial success response.

---

### E2 — Network errors silently freeze the UI `upload.html:189` `MEDIUM`
`fetch()` throwing (server down, no connection) is unhandled in most callers. Skeleton spinners never get replaced. `loadFolderCounts` swallows all errors silently with `catch(_){}`.

**Fix:** Add a top-level `.catch()` to all async calls with a user-visible error toast.

---

### E3 — `rename_folder` silently partially renames beyond the 500-message cap `main.py:1007` `MEDIUM`
Files beyond the cap keep the old caption. `user_folders.json` is updated to the new name. The folder is left in an inconsistent state with no indication in the UI.

---

### E4 — `get_file` and `get_thumbnail` return plain strings on 404, not JSON `main.py:1143, 1202` `LOW`
```python
return "File not found", 404
```
Every other endpoint returns JSON. Calling `.json()` on this throws a parse error that callers silently swallow.

**Fix:** Return `jsonify({"status": "error", "message": "File not found"})` consistently.

---

### E5 — No loading states on move/delete/rename — buttons not disabled during requests `upload.html` `HIGH`
Double-clicking "Move" submits twice. "Delete" gives no feedback for 2–10 seconds while the Telegram call runs. This is the single biggest reason the app feels like a rough prototype.

**Fix:** Disable the button and show a spinner on every action, re-enable on response.

---

## 7. Functional Gaps

### F1 — Files beyond `MAX_SCAN_MESSAGES` are invisible with no indication `main.py:797` `HIGH`
Default cap is 2000 messages. A user with years of files simply cannot see older ones. No UI indication the list is truncated, no way to load more, no setting exposed in the UI.

---

### F2 — Video/audio seeking is broken — no HTTP Range support `main.py:1121` `HIGH`
Already noted in A2. Every seek re-downloads the whole file from byte 0. The video preview is practically unusable.

---

### F3 — Download button is broken for images, PDFs, and videos `upload.html:328` `MEDIUM`
The backend sets `Content-Disposition: inline`, which tells the browser to display, not download. The `download` attribute on the `<a>` tag is overridden. PDFs and images open in a browser tab instead of saving.

**Fix:** Add a separate `/download_file/<id>` endpoint that sets `Content-Disposition: attachment`.

---

### F4 — No live search or debounce — only triggers on Enter `upload.html:35` `MEDIUM`
Since search filters `window.__afc` locally when the cache is warm, instant client-side filtering is essentially free. Nothing happens until the user explicitly hits Enter.

**Fix:** 300ms debounce on `keyup`, filter `window.__afc` client-side when cache is warm.

---

### F5 — `window.confirm()` used for destructive operations instead of the existing modal `upload.html:426` `MEDIUM`
Looks like a browser system alert, can't be styled, behaves differently across mobile browsers. The `openModal` component is already built.

**Fix:** Replace all `confirm()` calls with `openModal(...)`.

---

### F6 — `sanitize_input` silently strips apostrophes from folder names `security.py:91` `LOW`
`John's Documents` → `Johns Documents` with no error or feedback. Character stripping at storage time is the wrong approach.

**Fix:** Store names as-is. Use `textContent` (not `innerHTML`) at render time — no escaping needed at storage.

---

### F7 — No broken-media fallback in gallery or preview `upload.html:273, 283` `LOW`
If `/get_file` returns 404, the gallery shows a broken image icon and video shows a broken player. No `onerror` handlers on any media elements.

**Fix:** Add `onerror` handlers that show a "File unavailable" message inside the modal.
