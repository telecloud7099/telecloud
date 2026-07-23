# Resilience Test Plan (Phase 11)

Phase 11 deliverable. Follows `SECURITY_ARCHITECTURE.md` §7's Security Review / Validation
Summary process (same process Phase 7 was delivered against). Executed one scenario at a
time — validate, then proceed — not as one bundled run.

---

## Security Review (before implementation)

- **Section(s) affected:** `SECURITY_ARCHITECTURE.md` §5 Infrastructure/Deployment domain
  (crash recovery, restart policy). No change to the threat model, severity classification,
  or design principles — this phase is fault injection against containers we already
  operate, not a new feature.
- **Net effect on security posture:** neutral-to-improving. No code changes are planned
  going in; if a scenario surfaces a real bug, it gets fixed and re-verified under this same
  process before the phase closes.
- **New attack surface:** none. Every action (`docker kill`, `docker compose restart`,
  `sudo reboot`) is operator-initiated from the host/guest shell — not reachable through any
  externally-facing input path.
- **New secrets, trust boundaries, or assumptions:** none introduced. This phase tests
  whether *existing* assumptions (restart policy, DNS re-resolution, the confirmed-chunk
  durability invariant) actually hold.
- **Rollback/recovery considerations:** `phase10-complete` (current VM state, nothing
  infra-level has changed since) is the rollback point — nothing about these tests modifies
  VM configuration, so no new pre-test snapshot is needed. A `phase11-complete` snapshot is
  taken only once all scenarios pass.
- **Internet Exposure Checklist (§4):** unaffected — VM stays NAT-only, no TLS/tunnel touched.
- **Additional testing required before the next snapshot:** the 8 scenarios below, executed
  sequentially with validation between each.

---

## Groundwork already in place (why most of this is expected to pass)

- `compose.yml`: all three services are `restart: unless-stopped`; `telecloud-app` has
  `stop_grace_period: 30s` and a healthcheck (`curl -f http://localhost:8000/health`, 30s
  interval, 3 retries, 20s start_period). `nginx` has `depends_on: telecloud-app: condition:
  service_healthy`, so nginx won't consider itself up until the backend passes its
  healthcheck.
- `docker/nginx/nginx.conf` uses `resolver 127.0.0.11 valid=10s` + `set $backend` instead of
  a static `upstream{}` block specifically so nginx re-resolves `telecloud-app`'s IP after it
  restarts, instead of caching a stale one (a Phase 4 decision made with this exact scenario
  in mind).
- `chunk_upload.py`'s stated recovery invariant: the only durable truth is a **confirmed**
  `FileChunk` row. Temp part files and the in-memory progress registry
  (`upload_progress.py`) are both disposable — if the process dies mid-part, the part is
  simply unconfirmed and the client re-sends it from byte 0.
- `GET /uploads` lists every session with `status="uploading"` (`database.py:667`)
  regardless of in-memory progress state — this is what lets a session survive a backend
  crash and still be reattachable afterward.
- Part temp files live at `uploads/_parts`, which is *inside* the bind-mounted volume
  (`${TELECLOUD_DATA_DIR}/uploads:/app/uploads`), so they physically survive a container
  restart/recreate — but `receive_part` always reopens them in truncate (`"wb"`) mode, so a
  stale partial file from an interrupted PUT is safely overwritten on retry, not corrupted.
- `POST /uploads/{id}/complete` hard-requires `len(confirmed chunks) == total_chunks` (409
  otherwise) — structurally prevents a premature or partial finalize.

## Known risk this plan specifically tests for (not assumed safe in advance)

- **Possible orphaned Telegram message.** In `_upload_part_to_telegram`
  (`chunk_upload.py:154-158`), `client.send_file()` completing successfully and
  `record_file_chunk()` writing the DB row are two separate steps. If the container is
  killed in the (short but real) window between them, a Telegram message exists for that
  part but no `FileChunk` row does. `session.next_part_number` never advanced, so the client
  will re-PUT and re-send that part number on retry — meaning the *first* message becomes
  permanently orphaned (unreferenced, but harmless: no corruption, no duplicate app-visible
  data, just a small amount of wasted Telegram storage). Scenario 2 (the abrupt `docker
  kill`) is the one most likely to catch this window; Scenario 8's integrity check is
  designed explicitly to detect it, not assume it away.
- **`/health` is a trivial liveness check** (`backend/main.py:113-115`, returns
  `{"status": "ok"}` unconditionally) — it does not verify Neon DB reachability or Telegram
  client-pool state. Docker (and `docker compose ps`) can report `healthy` before the app can
  actually serve a real upload. Every scenario below therefore requires an actual functional
  re-verification (a real PUT/GET against the session), not just a healthy container status.
- **Grace period vs. transfer time.** A graceful `docker compose restart` sends SIGTERM and
  waits up to `stop_grace_period` (30s) before SIGKILL. Whether that's long enough for an
  in-flight Telegram part-upload to finish depends on part size vs. network speed. At the
  network conditions measured in Phase 10 (~180-280 KB/s), a 500MB part takes many minutes —
  comfortably longer than 30s — so Scenario 1 should genuinely interrupt the transfer rather
  than the restart racing a near-instant completion. This is why the test file below is
  chosen deliberately, not reused out of laziness.

## Test file

Reuse `/tmp/phase10_testfile.bin` (500MB, already on the VM from Phase 10) for the same
reason noted above — large enough that both restart and kill genuinely interrupt an
in-flight transfer at current network speeds.

---

## Scenario 1 — Backend container restart during active chunk upload

**Procedure:** Start a chunked upload of the test file (`phase10_upload_benchmark.py`, reused
from Phase 10, or the browser UI). Once `GET /uploads/{id}` shows
`part_progress.phase == "uploading_telegram"`, run `docker compose restart telecloud-app`.

**Expected behavior:** SIGTERM sent, up to 30s grace period, then SIGKILL if still running;
the in-flight background upload task is interrupted; container restarts; nginx re-resolves
DNS to the new container automatically (no nginx restart needed).

**Success criteria:**
- `docker compose ps` shows `telecloud-app` healthy again within a reasonable window
  (start_period 20s + up to 3×30s retries).
- `GET /uploads` (list) still shows the session as `status="uploading"`.
- `GET /uploads/{id}` shows `part_progress: null` and `next_part_number` unchanged from
  before the restart.
- Re-PUTting the same part number succeeds; the upload can be driven to completion.
- No duplicate `FileChunk` rows; the finalized file downloads and checksum-matches the
  original.

**Failure criteria:** session status silently changed to something other than `uploading`;
`next_part_number` advanced without a matching confirmed chunk; `GET /uploads` stops listing
the session; the finalized file fails a checksum comparison.

**Risk:** the orphaned-Telegram-message case above (low probability on a graceful restart
specifically, since SIGTERM gives the in-flight task a chance to reach a natural boundary,
but not impossible if it lands mid-`send_file`) — check for it, not fatal if found alone.

---

## Scenario 2 — Backend container kill (`docker kill`) during active chunk upload

**Procedure:** Same setup as Scenario 1, but `docker kill telecloud-app` instead of
`restart` — no SIGTERM, no grace period, immediate SIGKILL.

**Expected behavior:** strictly harsher than Scenario 1 — guarantees the background upload
task is killed mid-transfer with zero chance to reach a clean boundary. Since this is an
unexpected exit (not an operator `docker compose stop`), the `restart: unless-stopped`
policy should bring the container back **automatically**, with no manual
`docker compose up` needed.

**Success criteria:** everything from Scenario 1, plus explicit confirmation that the
container restarted on its own (checked via `docker compose ps` / `docker events`) without
any manual intervention.

**Failure criteria:** same as Scenario 1, plus: container does not auto-restart and requires
manual `docker compose up -d`.

**Risk:** highest-probability scenario for the orphaned-Telegram-message case — explicitly
check for it in Scenario 8's integrity pass.

---

## Scenario 3 — Upload polling recovers correctly after the backend returns

This is a cross-cutting check embedded in Scenarios 1 and 2, called out separately because
it has its own pass/fail condition independent of the upload's eventual outcome.

**Procedure:** While the backend is down (between the crash and the healthcheck passing),
poll `GET /uploads/{id}` through nginx.

**Expected behavior:** nginx returns a transient error (502/504) while its upstream is
unreachable — per the existing lesson from Phase 3 testing ("client polling must only treat
404 as fatal; transient 500s/network blips must not abort"), the polling client (frontend or
benchmark script) must keep retrying rather than aborting the session client-side.

**Success criteria:** polling resumes cleanly to a normal 200 response once the container is
healthy again, with `part_progress: null` and `next_part_number` unchanged.

**Failure criteria:** the client treats a transient 502/504 as fatal and gives up before the
backend recovers.

---

## Scenario 4 — Resume/completion without metadata corruption or orphaned chunks

**Procedure:** After either Scenario 1 or 2, re-PUT the interrupted part (via widget
reattachment or the benchmark script) through to `POST /uploads/{id}/complete`, then download
the finalized file.

**Success criteria:**
- Downloaded file's sha256 matches `/tmp/phase10_testfile.bin` exactly.
- `FileChunk` row count for the session equals `total_chunks`, no duplicate
  `(session_id, part_number)` pairs.
- Cross-check Telegram Saved Messages for that session's `group_id` (from the chunk
  caption, `__tc_chunk__:<group_id>:...`) against recorded `FileChunk` rows — any Telegram
  message in that group not matched by a `FileChunk` row is the orphaned-message case flagged
  above; note it if found, don't treat it as a blocking failure on its own.

**Failure criteria:** checksum mismatch (real corruption — blocking), or a **missing**
message that a `FileChunk` row points to (broken reference — blocking; different from an
*extra* unreferenced message, which is the known low-risk case).

---

## Scenario 5 — Full VM reboot with `restart: unless-stopped` validation

**Procedure:** `sudo reboot` from the VM guest terminal. Wait for the desktop session to come
back, then check container state.

**Expected behavior:** Docker daemon starts on boot (systemd-enabled since Phase 2's
install), and all three containers come back automatically — no manual
`docker compose up` needed.

**Success criteria:** `docker compose ps` shows all three containers running/healthy within
a reasonable window after login.

**Failure criteria:** any container not running, requiring manual intervention to bring back.

---

## Scenario 6 — nginx, telecloud-app, and PostgreSQL all recover automatically after reboot

Folded into Scenario 5's success check, but verified per-service rather than just "3 rows in
`docker compose ps`":
- `telecloud-postgres`: healthcheck passing (`pg_isready`).
- `telecloud-app`: healthcheck passing, **and** a real `GET /health` plus a real API call
  (e.g. list files) succeeds — per the `/health`-is-trivial caveat above.
- `telecloud-nginx`: reachable on port 80, serving the frontend.

---

## Scenario 7 — In-flight uploads fail gracefully across a full reboot and can be resumed/restarted

**Procedure:** Start an upload, get it into `uploading_telegram` phase, then reboot the VM
(Scenario 5), rather than just restarting the container.

**Expected behavior:** same recovery semantics as Scenario 1 (session stays `uploading`, part
unconfirmed, safe to re-PUT) but now also proving the full boot sequence — Docker daemon
start, `depends_on: service_healthy` ordering (nginx shouldn't come up ahead of a healthy
backend), `init_db()` re-running harmlessly on `telecloud-app` startup — introduces no new
failure mode beyond a plain container restart.

**Success/failure criteria:** identical to Scenario 1 and 4, plus confirming the
dependency-ordering behavior held (nginx wasn't serving requests to a not-yet-healthy
backend during boot).

---

## Scenario 8 — Post-test integrity checks

- **Database consistency:** for every session touched during testing, `FileChunk` row count
  == `total_chunks` after completion; no duplicate `(session_id, part_number)` pairs;
  `UploadSession.status` progression is sane (`uploading` → `completed`, never jumping to
  `completed` without a matching chunk count).
- **Telegram message consistency:** for each test session's caption `group_id`, enumerate
  Saved Messages and cross-check against `FileChunk` rows — flag (not fail) any orphaned
  extra message per the known risk above; a **missing** referenced message is a real failure.
- **Uploaded file verification:** sha256 of every finalized test download vs. the original
  `/tmp/phase10_testfile.bin`.
- **Health endpoints:** `/health` on `telecloud-app`, nginx reachability, `docker compose ps`
  healthy for all three.
- **Logs:** grep `telecloud-app` container logs across the full test window for unexpected
  tracebacks beyond the expected connection-reset noise from the kill/restart itself.
- **Cleanup:** delete/abort test upload sessions and files created purely for this test
  (including any orphaned Telegram messages found), let or force `chunk_upload_sweep()`
  clear any lingering part temp files, don't leave test artifacts in the real file listing.

---

## Rollback plan and snapshot strategy

- **Rollback point:** `phase10-complete` — no infra/config changes happen between Phase 10's
  end and the start of this testing, so it's already a valid clean state to revert to.
- **If a scenario reveals a real bug** (not the accepted orphaned-message case): stop:
  don't proceed to the next scenario. Fix the bug, re-verify the *fixed* scenario from
  scratch under this same process, then continue.
- **No intermediate per-scenario snapshots** — these are sub-tests of one phase, not phase
  boundaries; VBox snapshots are reserved for phase completion per established practice.
- **`phase11-complete` snapshot** taken only once all 8 scenarios have passed and the
  post-test integrity checks are clean.

---

## Sign-off log

| Date | Scenario | Result | Notes |
|---|---|---|---|
| _(none yet)_ | | | |
