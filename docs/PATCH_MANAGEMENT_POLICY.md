# Patch Management Policy

Established Phase 14e, 2026-07-24. This is the operational policy governing how
TeleCloud's OS, container runtime, base images, and dependencies stay current —
distinct from `SECURITY_ARCHITECTURE.md` (the governing threat model/design doc) and
from any single phase's closing writeup. Update this document itself whenever the
policy changes, not just when a phase closes.

## Cadence and automation level

| Category | Cadence | Automatic or manual? | Mechanism |
|---|---|---|---|
| Ubuntu OS security updates | Daily | **Automatic** | `unattended-upgrades` + `apt-daily-upgrade.timer` — already active, proven working via real log history since 2026-07-18 |
| Docker Engine (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`) | Daily | **Automatic** (added Phase 14e) | Same `unattended-upgrades` mechanism, `Allowed-Origins` extended to include `"Docker:resolute"` — verified via `apt-cache policy`'s security-relevant scope only (same `-security`-equivalent behavior as Ubuntu's own packages, not the general `-updates` pocket) |
| Pinned base images (`nginx`, `postgres`, `python`, `node`) | Monthly check via `patch_management_check.sh` | **Always manually reviewed**, never automatic | Phase 13's PostgreSQL 18 mount-path breaking change is the standing reason — a base image bump can change behavior, not just patch CVEs |
| Python dependencies (`requirements.txt`) | Quarterly | Manual review (`pip-audit`) | Same evidence-first process as Phase 14c: check actual usage before bumping anything touching security-critical code paths |
| Frontend dependencies (`frontend/package.json`) | Quarterly | Manual review (`npm audit`) | Run from the Windows dev host — Node isn't installed on the VM itself, only inside the Docker build stage |
| Trivy vulnerability scan | Before any Dockerfile/dependency-touching release, **and** standalone monthly regardless of code changes | Manual-triggered | `patch_management_check.sh` section 4 — monthly cadence exists because CVE databases update independent of our code; the same pinned image can accumulate new disclosed CVEs with zero local changes |

**Explicitly not implemented, by design**: no unattended rebuild-and-deploy pipeline for
base image bumps, dependency bumps, or anything else in this policy. `deploy.sh`
already states the reasoning for app deploys ("unattended auto-deploy would remove the
human review step this project has relied on") — the same logic applies more strongly
here, since base-image/dependency bumps carry higher breaking-change risk than app code
changes.

## Why Ubuntu OS updates only cover `-security`, not general `-updates`

Confirmed via live evidence during the Phase 14e audit: `Allowed-Origins` intentionally
excludes the `resolute-updates` pocket (only `resolute`/`resolute-security`/ESM
variants + now `Docker:resolute` are included). Running `patch_management_check.sh`
will always show a list of pending `-updates`-pocket packages — **this is the policy
working as intended**, not a gap. General `-updates` packages are feature/bugfix
releases, not security fixes, and auto-installing them carries more behavior-change
risk than this project wants unattended. If a package in that list is later confirmed
security-relevant via its own CVE, apply it manually and document why.

## Verification and rollback process for any change made under this policy

Identical to the process proven across Phases 14a–14c, not a new process invented for
14e:
1. Snapshot before applying (for VM-level or compose-level changes).
2. `docker compose build --no-cache` for anything touching a Dockerfile or dependency
   file — no-cache removes any doubt about stale layer reuse for a security-relevant
   change.
3. Full functional pass (login, upload, download) at minimum.
4. Category-specific regression check where relevant — e.g. the Fernet-decryption
   check against real Neon data when `cryptography` changes, or a full functional
   matrix pass when a base image's runtime behavior could plausibly shift (matches the
   Phase 13 PostgreSQL 18 precedent).
5. Rollback: `git revert` the specific commit(s), rebuild `--no-cache`, redeploy,
   re-verify. For VM-level config (like the `unattended-upgrades` origin addition),
   revert the specific file edit and re-run the equivalent verification (e.g. the
   dry-run check).

## Documented exception: `deploy.sh`'s floating `nginx:1.27-alpine` reference

`deploy.sh` uses a plain (non-digest-pinned) `nginx:1.27-alpine` tag to spin up a
disposable container solely for `nginx -t` config-syntax validation — never deployed,
never retained. Deliberately left unpinned: digest-pinning a throwaway validation
container provides negligible security benefit (it's not part of the shipped supply
chain) while adding maintenance overhead (would need updating every time the real
Dockerfile's pin changes, for zero actual benefit). Documented here explicitly so this
reads as an intentional decision, not an oversight missed by Phase 14c's pinning pass.

## Reusable tooling

`patch_management_check.sh` (repo root) — read-only, run on the cadences above. Verified
working end-to-end on first real run (2026-07-24): correctly parses pinned digests
directly from the Dockerfiles/`compose.yml` rather than hardcoding them, so it stays
accurate as pins get updated; correctly distinguishes `-security`-pocket updates from
the (intentionally unapplied) general `-updates` pocket; Trivy findings matched the
Phase 14c baseline exactly on a same-week re-run, as expected.
