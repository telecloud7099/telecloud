# Phase 15 — Go/No-Go Test Plan (VM validation stage)

Drafted 2026-07-24, not yet executed. Written and reviewed before execution begins, per
this project's established process (matches `RESILIENCE_TEST_PLAN.md`'s Phase 11
precedent).

## Scope and boundary (explicit, per 2026-07-24 discussion)

This phase answers **"is TeleCloud ready to migrate to the i3-2120 as a temporary,
24/7, LAN-only test server?"** — not "is it ready for production or the internet."
The i3-2120 itself is explicitly temporary: a real-hardware validation rig whose
performance data will inform a *later* purchase decision for permanent production
hardware. The production/internet-facing gate (`SECURITY_ARCHITECTURE.md`'s Internet
Exposure Checklist — TLS, stored-XSS fix, CSP enforcing, LAN-CIDR-then-Tunnel firewall
scoping, offsite backups, full test suite against final architecture) remains separate
and out of scope here.

The DOCKER-USER LAN-CIDR scoping decided for the i3-2120 deployment (Bridged
networking, narrow the still-unscoped Phase 14a rule to the home LAN CIDR) is
implemented **at that deployment**, not tested in the VM first — the VM stays NAT-only
throughout this phase, deliberately avoiding a network-mode change (with its own
threat-model shift — JWT-in-localStorage becomes plaintext on a real LAN) just to test
a rule that only matters once something is actually bridged.

## Test areas

### 1. Functional test matrix (full re-run)
Re-run `docs/FUNCTIONAL_TEST_MATRIX.md`'s full procedure: setup/OTP, 2FA, folders,
single-shot upload, chunked/resumable upload, download, search. **Pass**: all items
pass exactly as they did in Phase 9, no drift.

### 2. Security re-verification (14a–14e, no drift)
Re-run in sequence: `phase14a_network_audit.sh` (confirm DOCKER-USER chain still has
exactly the 5 expected rules), the container `HostConfig` checks from 14b (cap sets,
`read_only`, `tmpfs` still applied), `patch_management_check.sh` from 14e (confirms
digest pins still match, no unreviewed drift). **Pass**: every check matches its
Phase 14 baseline exactly; any difference is investigated before proceeding, not
waved through.

### 3. Frontend production-build ↔ VM backend integration
Resolved 2026-07-24: validates the same build/API contract Vercel would ship, without
any exposure change to the VM (public internet, Cloudflare Tunnel, and TLS stay out of
scope until the later production deployment).

`VITE_API_URL` (`frontend/src/api/client.ts`) is a Vite **build-time** env var, not
runtime — so the production build itself must be built pointed at the VM, not just
previewed that way:
```bash
cd frontend
VITE_API_URL=http://127.0.0.1:8080 npm run build
npm run preview -- --port 5173
```
Port `5173` deliberately chosen over Vite's preview default (`4173`): `backend/main.py`'s
`ALLOWED_ORIGINS` CORS allow-list already defaults to `http://localhost:5173,http://localhost:5001`
(the existing dev-server origin), so this needs zero backend/`.env.app` changes on the VM.
**Pass**: login/upload/download/etc. all function correctly through the real production
build talking to the VM over the NAT-forwarded endpoint, with no CORS errors in the
browser console.

**Result: PASS, 2026-07-24 — root cause of an initial false alarm fully confirmed.**
The first test attempt showed `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` and a
misleading "CORS blocked" browser error on `/verify_code`. Investigated rather than
dismissed: `Cross-Origin-Resource-Policy: same-origin` (nginx, unconditional on every
response, confirmed by reading `nginx.conf`) was the initial suspect but was ruled out
by direct evidence — a clean Incognito reproduction still failed the same way, which a
persistent CORP block wouldn't explain since nothing about CORP is session-scoped.

**Actual root cause, confirmed directly from nginx's logs**: the `auth` rate-limit zone
(`limit_req_zone ... rate=5r/m` shared across `check-phone`/`send_code`/`verify_code`/
`verify_password`) was already exhausted from repeated testing. nginx's `limit_req`
rejects with 429 *inside nginx*, before the request reaches FastAPI's `CORSMiddleware`
— so the 429 response carries no CORS headers, and the browser reports that as a CORS
failure instead of a rate-limit rejection, masking the real cause. This reproduced even
in a fresh Incognito session because VirtualBox NAT collapses all Windows-host traffic
to a single gateway IP (`10.0.2.2`) at nginx — the rate limit is server-side and
IP-keyed, so no client-side session state resets it. Confirmed via
`docker compose logs nginx`: explicit `limiting requests ... by zone "auth"` warnings
immediately preceding each 429, and a clean `200` once the budget recovered.

Not a frontend, CORS, or build bug — the thing this item needed to prove (production
build + real cross-origin API contract against the VM backend) works correctly, shown
by full functionality (login, folders, upload, download) once the rate-limit window
passed. **Carried forward as a non-blocking note for the later production stage**: a
legitimate rate-limited client sees a misleading "CORS blocked" error rather than a
clear rate-limit signal, whenever the request is cross-origin (as it will be for the
real Vercel/Railway or Tunnel-fronted deployment) — worth revisiting then, not a Phase
15 gate.

### 4. Long-duration stability test (24–48h)
Real usage pattern (not synthetic) running against the VM for a sustained period,
monitored via `docs/OPERATIONS_RUNBOOK.md`'s existing tooling (`docker stats`,
`security_event_summary.py`, disk usage tracking). **Pass**: no crashes, no unexplained
container restarts, no memory-growth trend, log rotation still bounding disk usage as
proven in Phase 12.

### 5. Large-file upload/download/resumable transfer
Extend Phase 9's matrix with genuinely large files (proposing multi-GB — exact size TBD
based on realistic real-world usage) through the full chunked/resumable path,
including a deliberate interrupt-and-resume mid-transfer. **Pass**: byte-for-byte
integrity (sha256, matching Phase 11's verification standard), resume works without
corruption.

### 6. Backup and restore verification (fresh run)
Re-run Phase 13's process end-to-end one more time against current live data as a
final pre-migration checkpoint — not relying on the Phase 13 result alone, since real
data has changed since then. **Pass**: same bar as Phase 13 (row counts, content
checksums, ORM-layer read all matching).

**Result: PASS, 2026-07-24.** Followed `docs/DISASTER_RECOVERY_RUNBOOK.md` exactly, no
deviation from the documented procedure. Version parity reconfirmed (both local and
Neon at PostgreSQL 18.4). Backup: ~23s, 129,023 bytes. Restore: exit code 1 with 13
errors, all `ALTER TABLE/DEFAULT PRIVILEGES ... TO neondb_owner/neon_superuser` —
identical class of error to Phase 13, zero `CREATE TABLE`/`COPY` failures. Row counts
matched exactly on all 9 tables (`files=1741`, up from Phase 13's 1737, consistent
with normal usage growth). Content checksum matched exactly
(`334ac2e45d4f1d1735ccdb8755ac3f27`) on both sides. ORM-layer verification
(`phase13_verify_orm.py`): zero exceptions, correct category/status breakdowns. Live
app confirmed functional after the full drill (login/list), with one recurrence of the
already-documented item-3 rate-limit artifact (nginx `auth` zone, same NAT-shared
client IP) — not a new issue, confirmed via the same log-based diagnosis.

**Two real operational findings surfaced by actually running the drill, not assumed:**
1. **`docker cp` silently fails against a `read_only: true` container**, even when the
   destination is a genuinely writable `tmpfs` mount. `docker cp rowcounts.sql
   telecloud-postgres:/tmp/rowcounts.sql` reported "Successfully copied 528B" but the
   file did not actually exist in `/tmp` afterward — `docker cp`'s archive-extraction
   mechanism appears to fail a post-copy step against the read-only rootfs regardless
   of the specific mount's own writability. `docker exec -i <container> sh -c 'cat >
   /path' < localfile` works correctly and was used as the workaround throughout this
   drill. **The runbook should be updated** (tracked as a follow-up, not done in this
   phase) to use this pattern instead of `docker cp` now that Phase 14b's container
   hardening is in place — Phase 13 predates that hardening, so the original runbook's
   `docker cp` commands were correct when written.
2. **`phase13_verify_orm.py` needs `PYTHONPATH=/app`** when run from `/tmp` instead of
   `/app` — the script imports `backend.database`, which resolves via `/app` being on
   the working directory in Phase 13's original (pre-14b, writable-`/app`) execution.
   With `/app` now read-only, the script has to live in `/tmp` (the writable mount) but
   still needs `/app` added to the import path explicitly.

### 7. Resource measurement under real load
CPU/RAM/disk I/O/network measured during actual functional load (upload/download
activity), not the synthetic cryptg-only benchmark from Phase 10 — this is the number
that actually predicts i3-2120 behavior. Documented for direct before/after comparison
once the same measurement is repeated on real hardware.

### 8. Upload-unresponsiveness reproduction attempt
Deliberately attempt to reproduce Phase 11's finding (concurrent upload correlated
with Docker healthcheck failing repeatedly and external `curl` hanging indefinitely).
Use the lock-wait/connect-duration/concurrency instrumentation already added to
`telegram_client.py`'s `get_client()` for this exact purpose, plus targeted profiling
of the other flagged candidates (`os.fsync()`, blocking file reads, `cryptg`'s
GIL-bound behavior per Phase 10). **Pass bar is evidence, not silence**: either a
root cause is identified, or reproduction is attempted rigorously and documented as
not-yet-reproduced-under-VM-conditions (to be retried on real hardware per your
stated objective 3) — not simply "we didn't see it this time."

### 9. Docker restart + VM reboot recovery re-verification
Re-run Phase 11 scenarios (2) `docker kill`/`docker stop` behavior and (5+6) full VM
reboot recovery — worth re-confirming specifically because 14a–14e added substantial
new state (DOCKER-USER rules, container `read_only`/cap-drop settings, digest pins)
since Phase 11 last verified this, and none of it has been exercised through a reboot
cycle together as a whole system.

### 10. Deployment reproducibility check (required before any Go verdict)
Before the report can declare Go, document the exact, pinned state the i3-2120
deployment would clone from source — not just "current `main`":
- The exact `git` commit hash `HEAD` is at when testing concludes.
- The exact digest-pinned base images in effect (`nginx`, `postgres`, `python`, `node`
  — confirm via `patch_management_check.sh` section 3 that pinned == live, so there's
  no last-minute drift between what was tested and what a fresh clone would build).
- Confirmation that a **fresh `git clone` + `docker compose build` from that commit**,
  not the existing built images, is what actually gets validated — since the i3-2120
  deployment is a clone-from-Git, not a copy of the VM's running containers, testing
  only the VM's already-built images wouldn't actually prove the fresh-build path
  works. If practical, do at least one clean rebuild from a fresh clone in a scratch
  directory on the VM as part of this check, rather than assuming `docker compose
  build --no-cache` on the existing checkout is equivalent.

## Deliverable
A written Go/No-Go report (`docs/PHASE15_GO_NO_GO_REPORT.md`) synthesizing all 10
areas with an explicit verdict, produced after execution — not a running commentary
during it. The report must state the exact commit hash and image digests the Go
verdict applies to; a later commit is a new, unvalidated state until re-verified.
