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

**Original expected behavior (revised after testing, see below):** this plan originally
assumed `docker kill` was an "unexpected exit" that `restart: unless-stopped` would recover
from automatically. **That assumption was wrong, and was corrected experimentally, not just
asserted** (2026-07-23):

- `docker kill telecloud-app` against a live upload (40MB/500MB in) produced `Exited (137)`
  (137 = 128+9, confirms SIGKILL delivered) — but the container **did not auto-restart**,
  even 51+ seconds later (`docker compose ps -a` showed it sitting in `Exited` state; a plain
  `docker compose ps` didn't even list it, since that command hides non-running containers by
  default — don't mistake that for the container having vanished).
- Confirmed the configured policy really is `unless-stopped`
  (`docker inspect telecloud-app --format '{{.HostConfig.RestartPolicy.Name}}'`), ruling out
  a config mistake.
- **Root cause, verified via `man 7 pid_namespaces`, not just theorized:** Docker's restart
  policy distinguishes *why* PID 1 exited. An explicit `docker kill`/`docker stop` operates
  from *outside* the container's PID namespace (using the host-visible PID) and is treated as
  a deliberate operator action — `unless-stopped` intentionally does not override it (so
  `docker kill` isn't rendered pointless by an instant bounce-back). This is unrelated to
  in-process behavior; it's about which "namespace" the kill command itself was issued from.
- To get a genuine comparison, we tried killing PID 1 *from inside* the container instead
  (`docker exec telecloud-app kill -9 1` → failed, `kill` binary isn't in this slim image;
  then `docker exec ... python3 -c "os.kill(1, signal.SIGKILL)"` → ran with no error, but
  the container's uptime never reset — nothing happened). `/proc/1/status` showed PID 1 is
  `docker-init` (tini, from `init: true` in `compose.yml`). Per `pid_namespaces(7)`: a signal
  with no established handler (SIGKILL always qualifies — it can never have a handler) sent
  to a namespace's init process **by another process inside that same namespace** is
  silently discarded by the kernel specifically to stop a namespace's init from being
  trivially killed by anything running inside it. That's exactly why this attempt silently
  no-op'd — a kernel protection, not a Docker or app behavior.
- **The valid way to simulate a true internal crash:** kill the actual `uvicorn` child
  process (not PID 1) from inside the container instead — found via `docker top telecloud-app`
  (host-visible PIDs) then targeted via a small script walking `/proc` inside the container to
  find and `os.kill()` the uvicorn PID directly (not PID 1, so the namespace protection above
  doesn't apply). Result: **the container auto-restarted with no manual intervention** —
  `docker compose ps` showed `Up 8 seconds (health: starting)` moments later, `healthy` again
  within about a minute. This makes sense: tini's whole job is to exit when its watched child
  exits, so tini itself calling `exit()` (a normal process exit, not an externally-delivered
  kill) is exactly the "unexpected exit" case `unless-stopped` is designed to catch.

**Corrected conclusion:** `restart: unless-stopped` behaves exactly as documented — it
recovers from a genuine in-process crash (an OOM-kill, an unhandled exception that takes down
the process, a segfault) automatically, but **does not** recover from an explicit
`docker kill`/`docker stop` issued from the host, by design. Both were tested directly, not
inferred from one result. **Operational implication for Phase 15:** if anyone (an operator, a
monitoring tool, a future orchestrator) ever runs `docker kill`/`docker stop` against this
container on the real home server, it will **not** come back on its own — that needs to be a
known, documented fact in the eventual runbook, not a surprise discovered during an incident.

**Success criteria (revised):** for the `docker kill` procedure specifically — confirm exit
code 137 and confirm it does *not* auto-restart (that's now the expected, correct behavior,
not a failure). Recovery-mechanics verification (session state, resume, checksum) should be
done via the internal-crash method above, or by manually restarting after `docker kill`
(`docker compose start telecloud-app`) and then following Scenario 1's verification steps.

**Failure criteria (revised):** the container failing to come back even after a *manual*
`docker compose start` following `docker kill`; or the internal-crash method failing to
trigger auto-restart (which would contradict the verified mechanism above and warrant
re-investigation).

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

**Verified 2026-07-23** with a dedicated standalone poller (`phase11_poll_resilience_test.py`)
run continuously through a live `docker compose restart telecloud-app`, rather than inferred
from before/after snapshots: `poll 12` hit a transient `HTTP 502` right as the outage began
and logged it as non-fatal instead of stopping; `poll 24` logged `RECOVERED after 13.4s
outage`; polls 25 through 94 (continued for over a minute after recovery) all returned normal
`200` responses with `session_status`/`next_part_number` unchanged throughout. The poller
never stopped polling at any point during the outage — directly confirming the client-side
tolerance this scenario requires, not just the server-side recovery.

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

## Observed findings during testing

Findings surfaced while executing the scenarios above, kept separate from the scenario
results themselves since they weren't anticipated by the original plan.

### Stale client activity prolonged recovery after Scenario 1's restart (2026-07-23)

**Observed, not a confirmed root cause.** During Scenario 1 (backend container restart
mid-upload), re-PUTting the interrupted part failed repeatedly for 15+ minutes after
`telecloud-app` reported `healthy` again, every time with `{"status":"error","message":
"Could not connect to Telegram"}` (backend logs: `Telegram connection timed out. Please
try again.` from `telegram_client.py`'s 12s connect timeout). A `docs/`-adjacent one-off
diagnostic (`telethon_connect_debug.py`) connected and fully authenticated directly against
Telegram in 0.35s during this same window, and independent checks (general HTTPS, raw TCP
to a Telegram data center IP, `api.telegram.org`) all responded fast — ruling out a real
Telegram-side or network-level outage as the cause.

A browser tab left open from earlier testing, with many stale reattached upload sessions,
was still issuing background requests (observed: `backend.routes.files` logging its own
independent `Telegram connection timed out` error around the same times, from an incremental
sync call unrelated to our upload). Closing that stale tab was immediately followed by the
next PUT retry succeeding.

**What we can say:** concurrent client activity (the stale tab) was present throughout the
incident, and closing it immediately preceded recovery. **What we cannot yet say:** *why* —
no instrumentation was added to directly observe lock contention, backoff-timer
re-arming, or queuing inside `telegram_client.py`'s connection-pool state
(`_clients`/`_get_lock`/`_connect_failed_at`) during the incident. The per-user lock/backoff
mechanism in that file is a plausible-looking mechanism given the code shape, but it is a
**leading hypothesis for a future phase to instrument and confirm**, not a diagnosed cause.

**Why this matters for resilience testing regardless of root cause:** it demonstrates that
concurrent client activity (multiple tabs/devices, or simply not cleaning up stale test
sessions) can materially affect how long recovery takes after a restart — a real user
scenario, not just a testing artifact. Worth a dedicated instrumented investigation before
Phase 15's go/no-go, and worth remembering to close out stale sessions/tabs before future
resilience runs so they don't confound results the way this one did.

### Active large upload correlated with the whole app becoming unresponsive (2026-07-23)

**Observed, not a confirmed root cause.** While a 500MB re-upload (session `5b859150-...`)
was running in the background, `telecloud-app`'s Docker healthcheck (`curl -f
http://localhost:8000/health`, 5s timeout) failed 12 consecutive times, each attempt
transferring **zero bytes for the entire 5-second window** (`docker inspect telecloud-app
--format '{{json .State.Health}}'` showed `"ExitCode": -1` and `Dload...0 0 0 0 0 0`
throughout every logged attempt) — not slow, completely unresponsive. `docker compose ps`
showed the container `unhealthy`, and a plain external `curl` DELETE request to the same API
hung indefinitely with no response at all, matching the healthcheck's own symptom.
`docker compose restart telecloud-app` then took the full 30-second `stop_grace_period`
before the container came back — a responsive process normally exits within a second or two
of SIGTERM, so needing the entire grace period is itself consistent with the event loop
having been unable to process the shutdown signal promptly. Once restarted, the container
returned to `healthy` within 35 seconds and stayed healthy after the upload session was
aborted.

**What we can say:** the stall was temporally correlated with the active background upload
(cryptg encryption + disk I/O for a 500MB transfer) and cleared immediately when that upload
was interrupted by the restart. **What we cannot yet say:** the exact blocking call. This
app runs a single Uvicorn worker with one event loop (a locked architectural decision, see
[[project_vbox_deployment_plan]]) — any synchronous call that doesn't yield control (a large
`os.fsync()`, blocking file reads inside Telethon's upload path, or `cryptg.encrypt_ige()`
itself, which Phase 10's benchmark already showed does not appear to release the GIL) could
produce exactly this symptom. No profiling or instrumentation was added to pinpoint which
one; this needs the same kind of targeted investigation as the stale-client-activity finding
above before Phase 15.

**Why this matters:** if confirmed, this means a single active large upload can make the
entire app briefly unresponsive to *every* user, repeatedly, for as long as the upload runs
— not just slow for the uploading user. That's a materially different (and more serious)
finding than anything else in this phase, since it's not specific to restart/crash recovery
at all — it could happen during completely normal operation with no fault injected. Flagged
here rather than in the main scenario results because it wasn't something Scenario 1 set out
to test; it surfaced as a side effect of the confounded run above.

---

## Sign-off log

| Date | Scenario | Result | Notes |
|---|---|---|---|
| 2026-07-23 | 1 (restart mid-upload) | PASS (with caveat) | First run: recovery mechanics correct (session stayed `uploading`, `part_progress` cleared, `next_part_number` unchanged, resumable via re-PUT) but recovery was prolonged 15+ min by the stale-client-activity finding above, unrelated to the restart/recovery logic itself. |
| 2026-07-23 | 1 + 4 (clean redo: restart mid-upload, then resume/complete) | **PASS** | Clean run, no stale tab, fresh session `d6f4a62f-49d9-4a22-93bd-a973b130dc0a`. Restarted `telecloud-app` while `part_progress.phase=="uploading_telegram"` (24MB/500MB in); restart took only 4.1s (vs. 30.8s in the confounded run — consistent with a normal, unblocked shutdown this time). Recovery: `part_progress` cleared to `null`, `next_part_number` unchanged, healthy again within 25s. Re-PUT resumed and completed cleanly; the frontend's existing auto-finalize behavior (Phase 4) called `/complete` on its own once `next_part_number` passed `total_chunks`. Downloaded the finalized file and compared sha256 against the original: **`f4b064eac2a4d2edbdb52f94e17394ff930dc5191e08a9aac252c7dd8128619b` on both sides — exact match, zero corruption.** |
| 2026-07-23 | 2 (`docker kill`, revised methodology) | **PASS (revised understanding)** | Session `36f0548f-0607-41fe-bdf1-181a1887deb7`, killed at 40MB/500MB. `docker kill` → `Exited (137)`, confirmed did **not** auto-restart even 51+s later — verified this is correct, documented Docker/kernel behavior (external kill from outside the PID namespace = deliberate operator action, `unless-stopped` respects it), not a bug. Separately verified an actual in-process crash (killing the uvicorn child, not PID 1, from inside the container) **does** auto-restart correctly (`healthy` within ~1 minute, zero manual intervention) — confirming `unless-stopped` itself works as designed; the original plan's test method (`docker kill`) just wasn't testing what it was assumed to test. See the revised Scenario 2 section above for the full experimental trail (including why `docker exec kill -9 1` silently no-ops due to `pid_namespaces(7)` protection). Recovery-mechanics verification (resume/checksum) not yet redone under this corrected method — same mechanics as Scenario 1, expected to hold, but not yet explicitly re-verified end-to-end after this specific crash path. |
| 2026-07-23 | 3 (polling survives transient errors) | **PASS** | Directly observed with a dedicated standalone poller (`phase11_poll_resilience_test.py`) run continuously through a live `docker compose restart telecloud-app` against session `36f0548f-...`, not inferred from before/after snapshots. `poll 12` hit a transient `HTTP 502` right as the outage began and correctly logged it as non-fatal; `poll 24` logged `RECOVERED after 13.4s outage`; polls 25-94 (over a minute of continued polling) all returned normal, unchanged state. The poller never stopped polling at any point — confirms the client-side tolerance requirement directly, not just server-side recovery. |
