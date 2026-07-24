# Phase 14e — Automatic Updates & Patch Management

Closed 2026-07-24. Repo at commit `26ac74c` (VM pulled clean before snapshotting).

## Objective

Define and implement the long-term operational policy for keeping the OS, container
runtime, base images, and dependencies current — the final sub-phase of the Phase 14
security pass, following 14a (network), 14b (containers), 14c (image pinning), and
14d (SSH — verified not applicable).

## Audit findings (verified, live evidence)

Captured via `phase14e_patch_mgmt_audit.sh`:

- **Ubuntu OS security updates were already automatic and demonstrably working**, not
  just configured — `unattended-upgrades` enabled, `apt-daily-upgrade.timer` active
  with real scheduled runs, and the log showed four actual successful runs across the
  audit period (2026-07-18 through 2026-07-24, the last upgrading `openssh-client`,
  `snapd`, `tar`, and a dozen libs).
- **Real gap found: Docker Engine was not covered.** `Allowed-Origins` only included
  Ubuntu's own origins — confirmed directly in the unattended-upgrades log output,
  which listed no Docker origin. Docker Engine (`29.6.2`, from Docker's own apt repo)
  would never receive automatic security patches, even critical ones, without this.
- **No automation existed for anything Docker-image-related** — no cron/timer for
  image pulls, rebuilds, or scans (confirmed via empty crontabs and a full systemd
  timer listing).
- **Concrete proof of the pin-vs-freshness tension**: `docker images` showed
  `nginx:1.27-alpine` — the exact image digest-pinned in Phase 14c — was **15 months
  old**, directly explaining the 37 findings (2 critical) Trivy found in it. This
  wasn't a mistake in 14c (pinning "whatever's currently verified-running" was the
  correct call for supply-chain integrity), but it's the concrete evidence for why this
  phase's cadence matters.
- No `.github/dependabot.yml` or equivalent — all dependency updates to date have been
  manual, phase-driven (matches this project's established preference).

## Policy decision, agreed before implementation

Explicit separation maintained throughout, consistent with 14c's own scoping
principle: **automatic where the risk is already proven manageable, manual review
everywhere a bump could change behavior, not just patch a CVE.**

- Ubuntu OS + Docker Engine → automatic (security-relevant scope only), because
  Phase 11 already empirically proved full-reboot and container-restart resilience —
  the disruption risk this would normally carry is already tested and covered.
- Pinned base images → always manual, because Phase 13's PostgreSQL 18 mount-path
  breaking change is the standing precedent for why a version bump needs review, not
  just a CVE count check.
- Dependencies (Python/frontend) → quarterly manual audit, reusing the exact
  evidence-first process from 14c (check actual usage before bumping anything
  security-critical).
- No unattended rebuild-and-deploy pipeline, matching `deploy.sh`'s own stated
  reasoning for app deploys, applied here with even more weight given the higher
  breaking-change risk of image/dependency bumps.

Full cadence table and reasoning: `docs/PATCH_MANAGEMENT_POLICY.md`.

## Implementation

### 1. Extended `unattended-upgrades` to cover Docker Engine
Retrieved the exact `Origin`/`Suite` values Docker's apt repo publishes directly from
its `InRelease` file (`Origin: Docker`, `Suite: resolute`) rather than guessing —
initial attempts to get this from `apt-cache policy`'s default output and a guessed
`_Release` filename both failed and were corrected in sequence (`InRelease`, not
`_Release`; the origin metadata needed the raw Release file, not `apt-cache policy`'s
default formatting). Added `"Docker:resolute";` to
`/etc/apt/apt.conf.d/50unattended-upgrades`'s `Allowed-Origins` block.

**Verified, not just configured**: `sudo unattended-upgrade --dry-run --debug` showed
`o=Docker,a=resolute` in the live "Allowed origins are:" list — direct proof the config
change took effect. One honest limitation documented rather than glossed over: Docker
Engine was already at its latest available version at audit time (`Installed ==
Candidate` for all 5 packages), so there was nothing pending to actually apply — a real
"did an update get auto-installed" test has to wait for Docker's next release and the
next scheduled timer run, via the same mechanism already proven for Ubuntu's own
packages.

### 2. `patch_management_check.sh` — reusable, not a one-off phase artifact
Six sections: Ubuntu update status (pending + last-run), Docker Engine version check,
pinned-vs-live base image digest comparison (parses the actual `FROM`/`image:` lines
from the Dockerfiles/`compose.yml` rather than hardcoding digests, so it stays correct
as pins change), Trivy CRITICAL/HIGH scan of all 6 images, Python dependency listing,
and frontend audit (with a correct fallback message when Node isn't available on the
VM host).

**Verified working on first real run**, no bugs found (unlike the Phase 14a/14b audit
scripts, which both needed a follow-up fix after their first run): pending
`resolute-updates`-pocket packages correctly listed but not auto-applied (confirms the
Allowed-Origins scoping is working as designed, not a gap); all four base images
correctly showed pinned-digest == live-digest; Trivy findings matched the Phase 14c
baseline exactly, as expected for a same-week re-run.

### 3. `docs/PATCH_MANAGEMENT_POLICY.md` — the standing policy document
Cadence table, the reasoning behind excluding the general `-updates` pocket, the
verification/rollback process (reused from 14a–14c, not reinvented), and the
`deploy.sh` floating-`nginx:1.27-alpine`-tag exception documented explicitly as
intentional (a disposable `nginx -t` validation container, never deployed — pinning it
would add maintenance overhead for no real security benefit).

## Success criteria (all met)

- [x] Documented patch management policy — `docs/PATCH_MANAGEMENT_POLICY.md`.
- [x] Automated OS security updates where appropriate — Ubuntu already was; Docker
  Engine now is too, verified via dry-run.
- [x] Documented rebuild schedule for Docker images — monthly manual review via
  `patch_management_check.sh`, never automatic.
- [x] Documented vulnerability scanning schedule — before any relevant release, plus
  standalone monthly.
- [x] Clear rollback and verification procedures — reused the proven 14a–14c process,
  documented in the policy doc rather than left implicit.

## Rollback

`unattended-upgrades` change: revert the single added line in
`/etc/apt/apt.conf.d/50unattended-upgrades`, re-run the dry-run check to confirm
Docker's origin is no longer listed. `patch_management_check.sh` and the policy doc:
`git revert` the relevant commits — pure documentation/tooling, no runtime behavior
depends on either file existing.
