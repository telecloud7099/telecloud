# Security Notes — TeleCloud

> Issues to revisit before any public/hosted deployment. This file tracks specific
> known application-level bugs. For the governing long-term security architecture —
> threat model, severity classification, design principles, and the mandatory
> Internet Exposure Checklist these issues feed into — see `SECURITY_ARCHITECTURE.md`.

---

## 1. Stored XSS via innerHTML — `upload.html:281, 326, 359` — **CLOSED, 2026-07-25**
**Original severity: High** (see `SECURITY_ARCHITECTURE.md` §2) — was a hard gate on
the Internet Exposure Checklist.

**Original finding:** file names from Telegram and folder names were injected directly
into `innerHTML` without escaping in the old vanilla-JS/Jinja frontend
(`upload.html`). A crafted filename like `<img src=x onerror=alert(1)>` would execute
JS in the browser.

**Affected (historical, pre-React-migration):**
- `upload.html:326` — file card title (`file.name`)
- `upload.html:359` — folder card title (`f`)
- `upload.html:281` — preview modal header (`name`)

**Closure investigation, 2026-07-25 — treated as a full security verification
exercise, not a code-review assumption:**

`upload.html` no longer exists — the frontend was fully rewritten in React/TypeScript
between the original finding and now. Reconstructing the threat model against the
*current* application, both static and runtime evidence were gathered before
declaring this closed:

1. **Static source review**: zero occurrences of `innerHTML`, `dangerouslySetInnerHTML`,
   `document.write`, `eval(`, `javascript:`, or `srcdoc` anywhere in `frontend/src`.
   Every `file.name`/`folder.name` render site (`FileCard.tsx`, `FolderGrid.tsx`,
   `PreviewModal.tsx`, `Gallery.tsx`) uses JSX text interpolation (`{file.name}`) or a
   standard JSX attribute (`title={file.name}`, `alt={file.name}`) — both auto-escaped
   by React by design. No Markdown-rendering library exists in `package.json` (ruled
   out as an alternate parsing path). The search query (`SearchBar.tsx`) is only ever
   used as a controlled `<input value>` and a numeric result count — never rendered as
   page content, so not a candidate injection point.
2. **Folder-name runtime test**: created a folder named exactly
   `<img src=x onerror=alert('XSS-FOLDER')>` through the live app. No alert fired.
   DOM inspection (DevTools Elements panel) confirmed the payload renders as a literal
   text node inside `<div class="card-title">` — no `<img>` element was created.
3. **File-name runtime test**: uploaded a file via direct `curl` multipart request
   (bypassing OS filename restrictions — Windows NTFS forbids `<`/`>`/`'` in
   filenames, so this also better simulates the realistic attack surface of an
   arbitrary filename string from an API call or Telegram-forwarded file, decoupled
   from any real OS's naming rules) with filename
   `<img src=x onerror=alert(2)>.txt`. Server response confirmed the payload was
   stored completely unmodified — `{"status":"success","files":["<img src=x
   onerror=alert(2)>.txt"]}` — so the test exercised the real, unsanitized value. No
   alert fired. DOM inspection confirmed the same result as the folder-name test: a
   literal text node inside `<div class="file-name">`, not a real `<img>` element.
4. **Related investigation surfaced during this review — PDF-preview MIME
   confusion** (a distinct, newly-identified *potential* attack surface, not part of
   the original finding): `PreviewModal.tsx` renders PDF previews via an unsandboxed
   `<iframe src={fileUrl(file.id)}>`, and the file's `mime_type` is fully
   client-supplied at upload time (`upload.py`, no server-side content validation).
   Tested directly: uploaded a file containing raw
   `<html><body><script>alert(3)</script></body></html>` content, named `evil.pdf`,
   declared as `application/pdf`. The upload succeeded and was correctly recognized
   as a PDF by the preview UI (`file-type-icon: picture_as_pdf`), confirming the
   iframe code path was genuinely exercised, not skipped. Result: Chrome's native PDF
   viewer attempted to parse the content, failed, and displayed "Failed to load PDF
   document" — it did **not** fall back to interpreting the mismatched content as
   HTML. No alert fired. `nginx.conf`'s `X-Content-Type-Options: nosniff`
   (`nginx.conf:87`) empirically confirmed to prevent this MIME-confusion path from
   being exploitable in the tested browser (Chrome), not just assumed from the spec.
   **Not treated as a confirmed vulnerability** — no execution was reproduced — but
   logged here since it was investigated as part of this closure and future audits
   should be able to see that it was considered, not missed.

**Conclusion:** the original stored-XSS vulnerability does not exist in the current
React implementation — eliminated structurally by the migration to JSX (which
auto-escapes rendered content by default), not by a deliberate targeted fix, which is
exactly why it had never been marked resolved until this investigation. Closed based
on the combination of source review and three independent, DOM-verified runtime
tests — not on the absence of `innerHTML` alone.

**Hardening follow-up (not a vulnerability fix — the PDF-preview MIME-confusion path
was tested and found not exploitable):** add a `sandbox` attribute to
`PreviewModal.tsx`'s PDF-preview `<iframe>` as defense-in-depth, so the app doesn't
rely on `nosniff` alone to prevent this class of issue. Verify it doesn't break the
browser's built-in PDF viewer before merging; fall back to the minimal sandbox
configuration that preserves functionality if the strictest setting breaks rendering.

---

## 2. Content-Disposition Filename Not Sanitized — `main.py:1146`
**Severity: Low** (Werkzeug blocks the main attack)

`message.file.name` from Telegram is embedded raw into the `Content-Disposition` header. CRLF injection is blocked by Werkzeug automatically, but the filename is still unescaped.

**Fix:** Sanitize filename before setting the header, e.g. strip non-printable/special chars.

---

## 3. Plaintext Fallback for Encrypted Credentials — `main.py:63-68`
**Severity: Medium** (requires filesystem access to exploit, but silently degrades an
encryption-at-rest control without alerting anyone — see `SECURITY_ARCHITECTURE.md`
§2 and the "fail securely" principle in §3)

If Fernet decryption of `api_sessions.json` or `user_folders.json` fails, the code silently falls back to reading the file as plaintext JSON.

**Fix:** Remove the plaintext fallback. If decryption fails, log an error and return `{}` — fail hard.

---

## 4. `phone_code_hashes` Not Scoped to Session — `main.py:141`
**Severity: Low** (OTP still required to exploit)

The OTP hash is stored in a global dict keyed only by phone number, not tied to any session or IP. An attacker who obtains the OTP from another source could complete login from any session.

**Fix:** Store the `phone_code_hash` in a short-lived server-side pre-auth token issued at `/send_code` and validated at `/verify_code`.

---

## 5. JWT Exposed in nginx Access Logs via Query-String Media Auth — `docker/nginx/nginx.conf` (`log_format main`), `backend/auth.py:46-61`
**Severity: Medium** (see `SECURITY_ARCHITECTURE.md` §2 — requires read access to the
nginx access log to exploit, but the resulting impact — a live, 30-day bearer token —
is more severe than a typical "requires filesystem access" finding)

`get_media_user` in `backend/auth.py` accepts the JWT via a `?token=` query parameter
as well as the `Authorization` header, since `<video>`/`<img>`/`<audio>` `src`
attributes can't send custom headers — a deliberate and necessary design choice, not a
bug on its own. However, `nginx.conf`'s `log_format main` logs `$request`, which
includes the full request line and therefore the full query string. Every media
request (thumbnail, file stream, video seek) writes the JWT in plaintext to
`/var/log/nginx/access.log`. A JWT is valid for 30 days (`JWT_EXPIRE_DAYS` in
`auth.py`), so anyone who obtains read access to that log file — e.g. via a separate
vulnerability, an insecure log-shipping/backup configuration, or local host access —
gets a live, fully-privileged bearer token for up to a month, not just metadata.

**Found:** 2026-07-22, while scoping Phase 9's Range-request functional test (tracing
the auth path for `/file/{file_id}`).

**Fix (not yet implemented — tracked here per `SECURITY_ARCHITECTURE.md` §7,
deliberately not fixed in Phase 9 to avoid scope creep):** options to evaluate
together rather than pick reflexively:
- Redact the `token` query parameter in nginx's log format for the `/file/` and
  `/thumbnail/` locations specifically (a custom log format for just those two
  locations, or a `map` on `$request` that strips the token before logging).
- Move media auth off the long-lived session JWT entirely, toward a short-lived,
  single-purpose signed URL/token minted just for that media request — more work, but
  removes the underlying exposure rather than just hiding it from logs.
- At minimum, treat `access.log` itself as sensitive (permissions, retention, access
  control) until one of the above lands.

---

## 6a. CVE Exploitability Assessments — Internet Exposure Checklist item 11

**Verification date/environment: 2026-07-25, VM (`roy-VirtualBox`, Ubuntu 26.04),
repo commit `00f0cf0`, digest-pinned images as of `patch_management_check.sh`'s
2026-07-25 run** — `nginx:1.27-alpine@sha256:65645c7b...`,
`postgres:18-alpine@sha256:9a8afca5...`, `python:3.13-slim@sha256:6771159c...`,
`node:22-slim@sha256:6c74791e...`. These are **point-in-time risk assessments, not
permanent exemptions** — each has explicit invalidating conditions below. Re-verify
whenever the affected component's role changes, or at the latest by the next
scheduled monthly pinned-image review (`PATCH_MANAGEMENT_POLICY.md`).

### CVE-2026-31789 — OpenSSL heap buffer overflow (32-bit systems)
- **Advisory:** https://nvd.nist.gov/vuln/detail/CVE-2026-31789
- **Affected component:** `libssl3`/`libcrypto3`, present in `nginx:1.27-alpine`
  (also inherited by the `telecloud-nginx` built image).
- **Installed version:** `3.3.3-r0` (fixed in `3.3.7-r0`).
- **Reason not reachable:** advisory is explicitly scoped to 32-bit systems.
- **Verification:** `docker exec telecloud-app uname -m` and
  `docker exec telecloud-nginx uname -m` both returned `x86_64` — confirmed
  directly on the running containers, not assumed from the base image's published
  platform tag.
- **Residual risk:** none identified at 64-bit. If a 32-bit build of these images
  were ever used (no reason to expect this), this reopens immediately.
- **Invalidating conditions:** deployment moves to a 32-bit host/image (not planned;
  would also be a major, deliberate architecture change).
- **Recommended future action:** no urgency — will resolve naturally whenever
  `nginx:1.27-alpine` is next bumped per the monthly pinned-image review.

### CVE-2025-68121 — Go stdlib `crypto/tls` certificate validation
- **Advisory:** https://nvd.nist.gov/vuln/detail/CVE-2025-68121
- **Affected component:** `gosu` (privilege-drop helper) inside `postgres:18-alpine`.
- **Installed version:** built with `go1.24.6` (`gosu --version` → `1.19 (go1.24.6
  on linux/amd64; gc)`).
- **Reason not reachable:** `gosu`'s only function is `setuid`/`setgid` +
  `execve` of the target command (the official Postgres image's own privilege-drop
  mechanism) — it makes no outbound network connections and has no TLS-client code
  path, regardless of what's statically linked into the Go binary's dependency
  closure.
- **Verification:** confirmed `gosu` is the vulnerable binary via
  `docker exec telecloud-postgres sh -c "which gosu; gosu --version"`; reachability
  conclusion is based on `gosu`'s documented, single-purpose design (source review of
  its known behavior, not a full binary disassembly).
- **Residual risk:** low — depends on `gosu`'s upstream design not changing to add
  networking, which is not expected of a purpose-built privilege-drop tool.
- **Invalidating conditions:** if `gosu` (or its role in the postgres entrypoint) is
  ever used for any network-facing purpose, or replaced with a different Go
  binary that does make TLS client connections, this must be re-assessed.
- **Recommended future action:** resolves naturally on the next `postgres:18-alpine`
  pinned-image bump; no urgency given the reachability finding above.

### CVE-2026-13221 — Perl silently-incorrect behavior
- **Advisory:** https://nvd.nist.gov/vuln/detail/CVE-2026-13221
- **Affected component:** `perl-base`, present in `python:3.13-slim`,
  `node:22-slim`, and inherited by the built `telecloud-app` image.
- **Installed version:** `5.40.1-6` (python/telecloud-app base), `5.36.0-7+deb12u3`
  (node base — different Debian release per image).
- **Reason not reachable:** `perl-base` is inherited OS-package weight from the
  Debian slim base layer (commonly pulled in by `dpkg`/apt tooling), never invoked
  by TeleCloud's own application code.
- **Verification:** grepped the entire `backend/` tree for `perl`, `subprocess`,
  `os.system`, `shell=True` — one substring match, which was a false positive on
  "pro**perl**y" (a comment), not a real Perl invocation. Zero genuine references.
- **Residual risk:** none identified — the interpreter is present on disk but never
  executed by anything in this deployment's request path.
- **Invalidating conditions:** if any future feature shells out to Perl, or a new
  base-image tool/entrypoint script invokes it, this must be re-assessed.
- **Recommended future action:** resolves naturally on the next base-image bump; no
  urgency.

### CVE-2026-59873 — npm `tar` package, DoS via crafted gzip bomb
- **Advisory:** https://nvd.nist.gov/vuln/detail/CVE-2026-59873
- **Affected component:** `tar`, found in the `node:22-slim` image scan.
- **Installed version:** `7.5.11` (fixed in `7.5.19`).
- **Reason not reachable:** not present anywhere in TeleCloud's own
  `frontend/package-lock.json` — this is npm's own internally-bundled `tar` copy,
  baked into the `node:22-slim` base image as part of the npm CLI itself, used only
  by npm during our own controlled, integrity-checked `npm ci` against the public
  npm registry. Never bundled into the shipped `dist/` output; never exposed to
  attacker-controlled archive input in production.
- **Verification:** `npm ls tar` in `frontend/` returned empty (not a resolved
  dependency in our tree at all); grepped `package-lock.json` directly for any
  `tar`-related entry — zero matches.
- **Residual risk:** none identified in current usage. A gzip-bomb DoS requires
  extracting an attacker-controlled archive; nothing in the build or runtime path
  does that.
- **Invalidating conditions:** if the build pipeline or the running application ever
  extracts untrusted/attacker-supplied archives (not the case today), this must be
  re-assessed.
- **Recommended future action:** resolves naturally on the next `node:22-slim`
  pinned-image bump; no urgency.

**Summary:** none of these four packages were upgraded or patched — all four remain
at their currently-pinned (nominally vulnerable) versions. What's documented above is
that the specific vulnerable code path in each case is not reachable given how these
components are actually used in this deployment, verified via a combination of
runtime commands and source review, not assumed. Satisfies Internet Exposure
Checklist item 11 ("no outstanding Critical/High CVEs... or documented evidence that
identified findings are not exploitable in the current deployment") as a documented
risk assessment, not a remediation. `PATCH_MANAGEMENT_POLICY.md`'s monthly
pinned-image review is the mechanism that will naturally resolve all four the next
time each base image is bumped.

---

## 6. Environment File Architecture (Phase 6, 2026-07-22)

Secrets are split by consumer so that compromising one container, or reading one file,
doesn't expose secrets that container has no reason to hold.

```
                      ┌─────────────────────────────┐
                      │   docker compose up -d       │
                      │   (reads compose.yml)        │
                      └───────────────┬───────────────┘
                                      │
                 needs ${VAR} to write compose.yml itself
                 (volume host paths — resolved BEFORE any
                  container exists, no shell/container
                  context available yet)
                                      │
                                      ▼
                      ┌─────────────────────────────┐
                      │   .env  (project root)       │
                      │   TELECLOUD_DATA_DIR only     │
                      │   NOT a secrets file           │
                      └─────────────────────────────┘

        ┌───────────────────────┐       ┌───────────────────────┐
        │  telecloud-app         │       │  postgres              │
        │  container              │       │  container              │
        │                         │       │                         │
        │  env_file: .env.app     │       │  env_file: .env.db      │
        │  ─────────────────────  │       │  ─────────────────────  │
        │  DATABASE_URL           │       │  POSTGRES_USER          │
        │  ENCRYPTION_KEY         │       │  POSTGRES_PASSWORD      │
        │  JWT_SECRET             │       │  POSTGRES_DB            │
        │  ALLOWED_ORIGINS        │       │                         │
        │  MAX_SCAN_MESSAGES      │       │  (POSTGRES_USER also    │
        │  upload-tuning vars     │       │  read by this           │
        │  HOST / PORT            │       │  container's own        │
        │                         │       │  healthcheck shell via  │
        │                         │       │  compose.yml's escaped  │
        │                         │       │  "$$POSTGRES_USER")     │
        └───────────────────────┘       └───────────────────────┘

  Bare-metal dev (Windows / start.sh) is a separate, single-process path:
  backend/main.py calls load_dotenv() with no args, which only ever looks for a
  file literally named `.env`. It never runs the postgres container, so its
  `.env` only needs what's in .env.app.example (cp .env.app.example .env) —
  TELECLOUD_DATA_DIR and the POSTGRES_* vars are irrelevant there and can be
  omitted.
```

**Why no value is duplicated:** `DATABASE_URL`/`ENCRYPTION_KEY`/`JWT_SECRET`/etc. and
`POSTGRES_USER`/`PASSWORD`/`DB` are consumed by disjoint containers with no overlap.
`TELECLOUD_DATA_DIR` looked like it might need to also live in `.env.db` for the
postgres volume path, but volume paths are resolved by Compose itself before any
`env_file:` is applied, so it only ever needs to exist in the project-root `.env`.
`POSTGRES_USER` looked like it would need to exist in both the project-root `.env`
(for the healthcheck's `${POSTGRES_USER}` substitution) and `.env.db` — resolved by
escaping the healthcheck to `$$POSTGRES_USER` so it's read from the postgres
container's own runtime env instead.

### Secret rotation runbook

| Secret | Where it lives | How to rotate | Blast radius if skipped |
|---|---|---|---|
| `JWT_SECRET` | `.env.app` | Generate a new value (see `.env.app.example` comment), update the file, restart `telecloud-app`. | All existing JWTs are invalidated immediately — every logged-in user is signed out and must log in again. No data risk. |
| `POSTGRES_PASSWORD` | `.env.db` | Generate a new value, update `.env.db`, then `ALTER USER telecloud WITH PASSWORD '...'` against the running instance (or recreate the container after updating both the env var and the DB itself — a plain container restart alone does NOT change an already-initialized Postgres user's password). | Low while Postgres is only reachable from the `data` network with no published host port. |
| `ENCRYPTION_KEY` | `.env.app` | **Not a drop-in rotation.** This key encrypts StringSession + API-credential rows already stored in the database. Rotating it requires: (1) decrypt all affected rows with the old key, (2) re-encrypt with the new key, (3) only then update `.env.app` and restart. Rotating the env var alone without migrating existing rows first makes every existing encrypted row unreadable. | High — a naive rotation is a self-inflicted data-loss incident, not just a credential refresh. |

**Incident precedent:** during Phase 4, a Neon DB password was accidentally pasted into
the chat transcript via `docker compose config` output and was rotated immediately via
the Neon dashboard. `ENCRYPTION_KEY`/`JWT_SECRET` were technically exposed the same way
but deliberately left un-rotated at the time, since `ENCRYPTION_KEY` rotation is the
non-trivial migration described above rather than a reflexive fix. Lesson carried
forward: never assume a command's output is safe to paste back into a chat just
because it's "only going to the local terminal" — the transcript is a channel too.

**Second occurrence, Phase 9 (2026-07-22):** a real, live JWT was pasted directly into
the chat transcript while testing the Phase 9 Range-request script. Traced
`verify_jwt`/`logout` (`backend/auth.py:28-30`, `backend/routes/auth.py:270-275`) and
confirmed JWTs are validated statelessly with no revocation list — logging out does
**not** invalidate a leaked token; it remains valid for its full ~30-day lifetime.
`JWT_SECRET` was rotated immediately per the runbook above. Going forward: when a
token/secret needs to be used in a test command, set it as a local shell variable on
the target machine and never paste the value itself back into the conversation — only
pass/fail output should cross that channel.

---

## Notes
- Severities reclassified 2026-07-22 against `SECURITY_ARCHITECTURE.md` §2: issue #1 was
  **High**, issues #3 and #5 are **Medium**, issues #2 and #4 are **Low**.
- **Issue #1 closed 2026-07-25** — see the full evidence trail above. No longer a hard
  gate on the Internet Exposure Checklist. `SECURITY_ARCHITECTURE.md` §4 item 1 and its
  severity table should be updated to reflect this at the next checklist review.
- Per `SECURITY_ARCHITECTURE.md` §4 (Internet Exposure Checklist), issue #5 (JWT in
  access logs) is not currently a hard gate but should be resolved or explicitly
  re-evaluated before the home server's logs are shipped/backed up anywhere off-box.
- Issues #2–#5 don't block internet exposure but should still be addressed per the
  severity guidance in `SECURITY_ARCHITECTURE.md` §2.
