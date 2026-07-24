# Phase 14c — Docker Image Hardening & Pinning

Closed 2026-07-24. Repo at commit `7b010ac` (VM pulled clean before snapshotting).

## Objective

Digest-pin base images and remove floating dependency versions across the stack, and
establish a vulnerability-scanning baseline — the next item in `SECURITY_ARCHITECTURE.md`'s
Phase 14 security pass, following 14a (network/firewall) and 14b (container hardening).

Methodology: same evidence-first approach as every prior phase. A key scoping decision,
agreed explicitly before implementation: **separate supply-chain integrity from
vulnerability remediation**. Digest-pinning locks out a surprise/malicious tag repush —
it does not reduce CVE count and was never treated as if it did. Conflating the two
would give a false sense of security.

## Audit findings (verified, live evidence)

Captured via `phase14b_container_audit2.sh`'s `pip freeze` output plus a dedicated
`phase14c_image_audit.sh` (Trivy scans of all 6 images in the stack, run as a one-off
container against the VM's native Docker socket — avoided Docker Desktop's Windows
npipe plumbing, which failed when first attempted from the host):

- **`requirements.txt` pinning was inconsistent**: `python-dotenv`, `Telethon`, and
  `cryptography` were exact-pinned; `fastapi`, `uvicorn[standard]`, `sqlmodel`,
  `psycopg2-binary`, `python-multipart`, `PyJWT`, and `cryptg` were all `>=` (floating,
  unbounded) — a real reproducibility risk, since any rebuild-without-cache could pull a
  different, untested version.
- **Two real, fixable CVEs found**, not just hygiene items:
  - `cryptography==41.0.7` — 4 distinct advisories (PYSEC-2024-225, PYSEC-2026-35,
    PYSEC-2026-1283/1285/2141 as one Trivy source, GHSA-h4gh-qq45-vh27,
    GHSA-537c-gmf6-5ccf — the last being a vulnerable OpenSSL bundled directly in the
    wheel). Security-critical: this is what encrypts StringSession/API-credential rows
    via `Fernet` (`backend/database.py`). Checked actual usage before proposing a fix —
    only the stable high-level `Fernet(key).encrypt/.decrypt` API is used, unchanged
    across the whole 41→48 range, so the jump was low-API-risk, though still verified
    empirically rather than assumed.
  - `python-dotenv==1.0.0` — PYSEC-2026-2270, low-stakes (env-var loading only).
- **Frontend**: `npm audit` found `react-router-dom` (moderate: CSRF/open-redirect/XSS
  advisories) and `vite` (high: two Windows-specific dev-server issues — never shipped
  in the production image since `frontend-builder` is a discarded build stage). Both
  fixable via plain `npm audit fix`, no `--force`/breaking bump needed.
- **Base image OS-package CVEs**: the overwhelming majority of Trivy's findings across
  all 6 images (37 on nginx, 24 on postgres+gosu, 23 on python:3.13-slim, 22+5 on
  node:22-slim, 37 on our own built `telecloud-app`/`telecloud-nginx` images) are
  inherited OS-package CVEs from the Debian/Alpine base layers — many with **no fix
  version available yet at all** from upstream. Some are in vendored binaries we don't
  control (postgres's bundled `gosu`, a Go binary with its own CVE set). **Deliberately
  out of scope for this phase** — see below.

## Policy decision: OS-level CVEs deferred to Phase 14e, not chased here

Digest-pinning an image locks in whatever CVE state that image currently has — it does
not add or remove vulnerabilities. Fixing OS-package CVEs requires either an upstream
fix landing (many hadn't, at audit time) or a periodic rebuild against a newer base
image tag. That's exactly Phase 14e's stated scope (Automatic Updates/Patch
Management — a recurring rebuild pipeline), not a one-time task here. Treating this
phase as "done" once Trivy shows fewer findings would be the wrong signal; the actual
deliverable is the pinning mechanism and the scanning capability itself, with the CVE
baseline explicitly documented and tracked rather than silently dropped.

## Implementation

### 1. Digest-pin all four base images
```
nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91
node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
```
Digests confirmed matching what was already built/running on the VM (`docker buildx
imagetools inspect` from the host, cross-checked against Phase 14b's build log and
image-reference audit) — this changed nothing about actual running behavior, only
pinned it going forward.

### 2. `requirements.txt` — full pin + two CVE fixes
Every dependency pinned to its exact currently-running version (captured via live `pip
freeze` on the VM, not a fresh untested pull). `cryptography` bumped 41.0.7 → 48.0.1,
`python-dotenv` bumped 1.0.0 → 1.2.2.

### 3. `npm audit fix` for the frontend
Resolved `react-router-dom` and `vite` advisories within existing semver ranges —
`package.json` unchanged, only `package-lock.json` regenerated. `npm audit` afterward:
0 vulnerabilities.

## Verification performed

- **Rebuild**: `docker compose build --no-cache telecloud-app nginx` — deliberately
  `--no-cache` for a security-relevant dependency bump, removing any doubt about layer
  cache reuse. Clean build, all four digests resolved and pinned correctly (confirmed
  directly in `docker compose ps`'s `IMAGE` column for postgres).
- **Dependency versions confirmed installed**: `pip show cryptography python-dotenv`
  inside the running container → `48.0.1` / `1.2.2` exactly as pinned.
- **Clean startup**: migrations applied, health check passing, no errors.
- **Fernet decryption regression — the one that actually mattered**: rather than a
  synthetic encrypt/decrypt round-trip, verified against real production data. Logging
  into an existing account requires decrypting that account's Neon-stored
  StringSession/API credentials via the exact `Fernet` cipher that was just upgraded —
  if the bump had broken decryption, login would have failed outright with
  `cryptography.fernet.InvalidToken`, not silently. Login succeeded, along with upload,
  refresh, and download — direct confirmation against real encrypted data, not inferred.

## Rollback

Per-file revert: `git revert` the three commits (digest pins, `requirements.txt`,
`npm audit fix`) individually or together, then `docker compose build --no-cache && docker
compose up -d` to rebuild against the prior state. Digest pins are the safest to revert
in isolation (pure metadata, no behavior change either direction). The `cryptography`
bump is the one requiring care if ever reverted — would need to re-confirm Fernet
decryption still works against whatever data was written under 48.0.1 in the interim
(no known format concern, since Fernet's token format itself is stable across this
library's versions, but not yet exercised as a real rollback scenario).

## Security posture after Phase 14c

- All four base images are now digest-pinned — a compromised or hijacked upstream tag
  can no longer silently change what gets built, only an explicit digest update can.
- `requirements.txt` is now fully deterministic — no dependency can silently change
  version on a cache-less rebuild.
- Two real CVEs in security-relevant/live dependencies (`cryptography`,
  `python-dotenv`) are fixed, verified against real production data, not just a version
  bump taken on faith.
- Frontend dependencies audit clean (0 vulnerabilities via `npm audit`).
- **Explicit, tracked, not-yet-addressed**: the OS-package CVE baseline captured by
  Trivy across all 6 images (raw counts in the audit transcript, not reproduced here
  since they'll shift with each upstream patch cycle) — ownership handed to Phase 14e's
  rebuild/patch-management pipeline, which is the correct mechanism for an
  ever-shifting target, not a one-time fix list.
