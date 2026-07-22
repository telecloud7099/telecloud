# Functional Test Matrix

Phase 9 deliverable — the regression checklist referenced by
`SECURITY_ARCHITECTURE.md` §4's Internet Exposure Checklist ("the full functional test
matrix passes against the exact configuration being exposed"). Run this in full after
any change that could plausibly affect auth, uploads, downloads, or the reverse proxy
— not just at the end of a numbered phase.

Manual checks require a real Telegram OTP login and can't be scripted. Two checks
(Range-request seeking, thumbnail persistence) are automated in
`docker/nginx/phase9_functional_check.sh` since they don't require live OTP
interaction — run that script alongside this checklist, not instead of it.

Adversarial/chaos scenarios (killing a container mid-upload, a full VM reboot) are
deliberately **not** in this matrix — those belong to Phase 11 (Resilience testing).
This matrix only covers normal operation.

---

## Manual checks

### 1. Setup / OTP login
**Procedure:** Open the app fresh (no existing session/localStorage). Enter phone
number, request OTP, enter the code received via Telegram.
**Expected result:** Login succeeds, a JWT is issued, and the dashboard loads. No
error toast, no stuck spinner.

### 2. 2FA / cloud password (if enabled on the test account)
**Procedure:** If the Telegram account has a cloud password set, after OTP entry the
app should prompt for it via `/verify_password`.
**Expected result:** Correct password completes login. Wrong password shows a clear
error and does not issue a JWT. **If the test account has no cloud password set, mark
this row N/A rather than skipping it silently** — note whether that's still the case
each time this matrix is run, since account state can change.

### 3. Folder listing and navigation
**Procedure:** From the dashboard, view the folder list, open a folder with existing
files, navigate back.
**Expected result:** Folders and their file counts load correctly; navigating in and
out doesn't lose state or throw console errors.

### 4. Single-shot upload (file below `RESUMABLE_UPLOAD_THRESHOLD_MB`)
**Procedure:** Upload a small file (e.g. a few MB).
**Expected result:** Upload completes without going through the chunked/session flow;
the file appears in the listing immediately after.

### 5. Chunked / resumable upload (file at or above the threshold)
**Procedure:** Upload a file ≥ `RESUMABLE_UPLOAD_THRESHOLD_MB` (currently 10MB).
**Expected result:** The upload widget shows progress via session polling
(`GET /uploads/{id}`), completes, and the file is listed and downloadable afterward.

### 6. Download
**Procedure:** Download a file that existed before the current test session (not one
just uploaded in step 4/5).
**Expected result:** File downloads with correct filename and content; no 500s, no
truncated content.

---

## Automated checks (`docker/nginx/phase9_functional_check.sh`)

### 7. Range-request video seeking through nginx
**Procedure (automated):** Script sends a `Range: bytes=100-199` request to
`/file/{file_id}?token=...` for a real video file you provide, using a JWT extracted
from a logged-in browser session (DevTools → Application/Storage → the stored token,
or the `Authorization` header on any authenticated network request).
**Expected result:** `206 Partial Content`, a `Content-Range` header matching the
requested range, and a 100-byte body — confirming nginx's `proxy_buffering off` +
passthrough config on the `/file/` location doesn't strip Range support.

### 8. Thumbnail persistence across a normal container restart
**Procedure (automated):** Script fetches a thumbnail, hashes it, restarts the
`telecloud-app` container (`docker compose restart telecloud-app` — a normal restart,
not a kill), then re-fetches the same thumbnail and hashes it again.
**Expected result:** Both hashes match — proves the `${TELECLOUD_DATA_DIR}/thumbs`
bind mount is real persistent storage, not something regenerated fresh per container
lifetime.

---

## Sign-off log

Record each full run here — date, commit hash, pass/fail per numbered item, and any
deviation noted.

| Date | Commit | Items 1–6 (manual) | Items 7–8 (automated) | Notes |
|---|---|---|---|---|
| _(none yet)_ | | | | |
