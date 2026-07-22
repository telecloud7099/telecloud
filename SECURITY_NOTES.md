# Security Notes — TeleCloud

> Issues to revisit before any public/hosted deployment.

---

## 1. Stored XSS via innerHTML — `upload.html:281, 326, 359`
**Priority: Fix before going public**

File names from Telegram and folder names are injected directly into `innerHTML` without escaping. A crafted filename like `<img src=x onerror=alert(1)>` would execute JS in the browser.

**Affects:**
- `upload.html:326` — file card title (`file.name`)
- `upload.html:359` — folder card title (`f`)
- `upload.html:281` — preview modal header (`name`)

**Fix:** Replace `innerHTML` with `textContent` for all user/server-supplied strings.

---

## 2. Content-Disposition Filename Not Sanitized — `main.py:1146`
**Priority: Low (Werkzeug blocks the main attack)**

`message.file.name` from Telegram is embedded raw into the `Content-Disposition` header. CRLF injection is blocked by Werkzeug automatically, but the filename is still unescaped.

**Fix:** Sanitize filename before setting the header, e.g. strip non-printable/special chars.

---

## 3. Plaintext Fallback for Encrypted Credentials — `main.py:63-68`
**Priority: Low (requires filesystem access to exploit)**

If Fernet decryption of `api_sessions.json` or `user_folders.json` fails, the code silently falls back to reading the file as plaintext JSON.

**Fix:** Remove the plaintext fallback. If decryption fails, log an error and return `{}` — fail hard.

---

## 4. `phone_code_hashes` Not Scoped to Session — `main.py:141`
**Priority: Low (OTP still required to exploit)**

The OTP hash is stored in a global dict keyed only by phone number, not tied to any session or IP. An attacker who obtains the OTP from another source could complete login from any session.

**Fix:** Store the `phone_code_hash` in a short-lived server-side pre-auth token issued at `/send_code` and validated at `/verify_code`.

---

## 5. Environment File Architecture (Phase 6, 2026-07-22)

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

---

## Notes
- Issues 2, 3, 4 are low risk for local/personal use.
- Issue 1 (XSS) is the only one that matters if the app is ever hosted publicly.
- All four should be addressed before any public deployment.
