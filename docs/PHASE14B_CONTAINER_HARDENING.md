# Phase 14b — Container Hardening

Closed 2026-07-24. Repo at commit `fd14b07` (VM pulled clean before snapshotting).

## Objective

Apply capability dropping, `no-new-privileges`, and `read_only` root filesystems (with
targeted `tmpfs` mounts for genuine write needs) to all three TeleCloud containers —
the next item in `SECURITY_ARCHITECTURE.md`'s Phase 14 security pass, following
Phase 14a's network/firewall hardening.

Methodology: same evidence-first approach as every prior phase — live audit before any
change, per-service incremental rollout (lowest risk first), verification after each
step, stop-and-fix on any failure rather than pushing through.

## Audit findings (verified, live evidence)

Captured via `phase14b_container_audit.sh` + a follow-up fixing two bugs in the first
version (a Go-template crash on `docker inspect` that silently ate the `SecurityOpt`/
`CapAdd`/`CapDrop` output, and a malformed `readlink` call):

- **Baseline confirmed empty**: all three containers had `SecurityOpt: null`,
  `CapAdd: null`, `CapDrop: null`, `ReadonlyRootfs: false`, `Tmpfs: null` — no hardening
  applied yet, as expected from `compose.yml` never having set these keys.
- **telecloud-app** already ran with **zero effective Linux capabilities**
  (`CapEff=0000000000000000` in `/proc/1/status`) despite Docker granting the default
  ~14-capability bounding set — non-root `appuser` (confirmed uid 1000 directly via
  `/proc/1/status`, not just inferred) never actually holds any of them.
- **nginx** PID 1 confirmed running as root (uid 0), needed for binding port 80 (a
  privileged port) and forking unprivileged worker processes.
- **postgres** PID 1 confirmed running as **uid 70** directly (not inferred from
  capabilities) — the official image's entrypoint starts as root briefly to fix
  ownership/permissions, then drops to the `postgres` user for the actual server
  process.
- **Filesystem**: nginx's `/var/cache/nginx/*_temp` dirs and postgres's
  `/var/run/postgresql` socket dir were both part of the writable overlay rootfs, not
  separate mounts — real candidates needing `tmpfs` before `read_only` could work.
  telecloud-app's only known writes (`uploads`/`thumbs`) were already bind-mounted
  outside the rootfs; `/tmp` was empty across all three.
- **One real surprise**: `nginx.conf` routed CSP violation reports
  (`/csp-report` → `access_log /var/log/nginx/csp_report.log`) to a genuine writable
  file — the only non-symlinked log target nginx had (`access.log`/`error.log` were
  confirmed symlinked to `/dev/stdout`/`/dev/stderr`). This would have blocked a clean
  `read_only` rootfs for nginx if left as-is.
- **Docker daemon**: `apparmor` + `seccomp` (builtin profile) + `cgroupns` confirmed
  active as security options.

## Policy decision: csp_report.log

Fixed before touching nginx's `HostConfig` at all: changed
`access_log /var/log/nginx/csp_report.log main;` to `access_log /dev/stdout main;`.
Not referenced by `phase7_security_check.sh` or any other tooling — almost certainly
only ever read manually during Phase 7's validation. Matches the stdout-only logging
design already established in Phase 4 rather than introducing a second convention just
for this one endpoint.

## Implementation, per service (lowest risk first)

### 1. telecloud-app
```yaml
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
read_only: true
tmpfs: [/tmp]
```
`cap_drop` is defense-in-depth here, not a functional change (it already held zero
effective capabilities) — but it shrinks the bounding set too, and makes the guarantee
explicit rather than incidental. Lowest-risk starting point given the audit evidence.

### 2. nginx
```yaml
cap_drop: [ALL]
cap_add: [NET_BIND_SERVICE, SETUID, SETGID, CHOWN]
security_opt: [no-new-privileges:true]
read_only: true
tmpfs: [/var/cache/nginx, /run]
```
Master process stays root (needed for the privileged-port bind and worker forking) but
loses everything else. This is nginx's documented minimal set for this exact pattern,
not a guess — still verified empirically rather than trusted from documentation, per
this project's standing practice. `CHOWN` was kept even though the audit showed
`/var/cache/nginx`'s temp dirs already correctly owned at image-build time (so it may
prove unneeded) — removing it wasn't proven safe either, left as a possible future
narrowing.

### 3. postgres
```yaml
cap_drop: [ALL]
cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]
security_opt: [no-new-privileges:true]
read_only: true
tmpfs: [/var/run/postgresql, /tmp]
```
Covers the entrypoint's brief root-phase permission-fixing before it drops to uid 70 —
confirmed via the audit that PID 1 already runs as `postgres` (uid 70) once actually
serving. The data directory (`/var/lib/postgresql`) is a bind mount, unaffected by
`read_only` regardless of any of this.

## Verification performed

Each step: apply → redeploy only that service → verify → only then move on, exactly as
planned. All three passed cleanly on the first attempt (no bugs found this phase, unlike
Phase 14a's two real implementation bugs):

- **telecloud-app**: started healthy, reached Neon, applied migrations, `HostConfig`
  matched exactly. Manual pass: login, list, upload, download all passed.
- **nginx**: rebuilt (config change required it), started with `Configuration
  complete; ready for start up` and no fatal errors — the one `info`-level line about
  `/etc/nginx/conf.d/default.conf` being unwritable is benign (a stock convenience
  script touching a file our custom `nginx.conf` doesn't use; ports 80 on both IPv4 and
  IPv6 came up fine regardless). CSP-report logging to stdout confirmed directly
  (`curl -X POST /csp-report` → `204`, request line visible in `docker compose logs
  nginx`). Host-side regression: `HTTP 200` via the real NAT path. Manual pass: login,
  list, upload, download all passed.
- **postgres**: restarted against the existing data directory (`Skipping
  initialization`, not a fresh `initdb`), reached `database system is ready to accept
  connections` with no permission errors, settled to `healthy`. Final full pass: login,
  2FA, upload, download all passed against the complete hardened stack.

## Persistence note (contrast with Phase 14a)

Unlike Phase 14a's iptables rules — which needed a dedicated systemd unit because raw
`iptables` state isn't persisted across a host reboot — these settings live in
`compose.yml` and are baked into each container's own config at creation time via
`docker compose up`. Docker persists container configuration itself (that's how
`restart: unless-stopped` survives a reboot at all), so no additional persistence
mechanism was needed here. Not re-tested via a full VM reboot this phase since the
mechanism is fundamentally different from — and lower-risk than — Phase 14a's.

## Rollback

Per-service: remove the added `cap_drop`/`cap_add`/`security_opt`/`read_only`/`tmpfs`
keys from `compose.yml` for the affected service, then `docker compose up -d <service>`
(add `--build` if `nginx` — `nginx.conf`'s stdout change would also need reverting if
going all the way back to the original file-based CSP log). Whole-phase rollback: revert
to the `phase14b-pre` state via `git revert`/`git reset` on `compose.yml` and
`nginx.conf`, or restore the `phase14a-complete` snapshot.

## Security posture after Phase 14b

- All three containers now run with an explicit, minimal capability set instead of
  Docker's permissive default — nginx and postgres keep only what's documented and
  verified necessary for their actual startup/runtime behavior; telecloud-app holds
  none at all.
- `no-new-privileges:true` on all three prevents any of them from gaining new
  privileges via setuid binaries or file capabilities, even within their already-
  reduced capability sets.
- `read_only: true` on all three means an attacker who compromises the application
  layer inside any container cannot persist a modified binary or script to that
  container's own filesystem — only to the specific bind-mounted or `tmpfs` paths each
  needs, none of which are on the code-execution path.
- **Deferred to Phase 14c** (Docker Image Hardening + Pinning): the image references
  captured during this phase's audit (`nginx:1.27-alpine`, `postgres:18-alpine`,
  locally-built `telecloud-telecloud-app`) are not yet digest-pinned or vulnerability-
  scanned — that's explicitly the next sub-phase's scope, not this one's.
