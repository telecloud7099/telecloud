# Backup Policy

Established Phase 15, 2026-07-25, as part of Internet Exposure Checklist remediation
(`SECURITY_ARCHITECTURE.md` §4). This is the operational policy governing TeleCloud's
database backups — distinct from `docs/DISASTER_RECOVERY_RUNBOOK.md` (the step-by-step
recovery procedure) and from `SECURITY_NOTES.md` (individual investigation records).
Mirrors `PATCH_MANAGEMENT_POLICY.md`'s structure.

## What this protects, and what it doesn't

TeleCloud's actual file *bytes* live durably on Telegram's own infrastructure — this
backup exists to protect the **Postgres metadata**: file→Telegram-message pointers,
folders, upload sessions, user settings, sync state. A total loss of this database
without a backup would not lose any file content, but would lose the organization and
indexing of it, recoverable only partially via `syncFiles()`'s re-scan capability.

## Recovery targets

| Target | Value | Rationale |
|---|---|---|
| **RPO** (max acceptable data loss) | 24 hours | Daily automated backups. Actual file bytes are never at risk (already on Telegram); losing up to a day of folder/session metadata in a true disaster is an acceptable bound for a single-operator, low-churn system. |
| **RTO** (time to restore service) | Under 2 hours | The DB restore itself takes minutes (dump is ~130KB, procedure proven in Phase 13/15). Most of the budget is realistically provisioning a fresh host — Phase 15 item 10 already proved a clean `git clone` + `docker compose build` works from scratch. |

**Revisit trigger:** if TeleCloud becomes a multi-user service with materially higher
metadata write volume, both targets should be reassessed — daily backups and a
130KB-dump-sized RTO budget assume the current low-churn, single-operator usage
pattern.

## Retention policy

| Tier | Kept |
|---|---|
| Daily | 14 days |
| Weekly | 8 weeks |
| Monthly | 12 months |

Enforced automatically every backup run via `restic forget --prune` (see
`docker/backup/backup_restic.sh`) — not a manual cleanup step.

## Architecture

- **Tool:** `restic` — client-side encryption before anything leaves the machine,
  mature snapshot/retention/integrity tooling, chosen over hand-rolled
  GPG+upload scripting per the project's "use mature tooling, not home-rolled crypto"
  principle (`SECURITY_ARCHITECTURE.md` §3).
- **Backend:** Backblaze B2, accessed via restic's **S3-compatible backend**
  (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`RESTIC_REPOSITORY` pointing at B2's S3
  endpoint) rather than restic's native B2 backend — deliberately provider-agnostic,
  so switching to a different S3-compatible provider later is a credential/endpoint
  swap, not a backend-syntax change.
- **Independence from Telegram:** deliberate design choice. TeleCloud's primary data
  already depends on Telegram; storing the metadata backup there too would mean a
  single Telegram-side incident threatens production data and its only backup
  simultaneously. B2 is operationally unrelated infrastructure.
- **Credentials:** `.env.backup` (repo root, `chmod 600`, never committed) — B2
  application key is bucket-scoped (least privilege), not the account master key.

## Cadence and automation

| Job | Schedule | Mechanism | What it does |
|---|---|---|---|
| Backup | Daily, 03:00 | `telecloud-backup.timer` → `docker/backup/backup_restic.sh` | `pg_dump` → `restic backup` → `restic forget --prune` → `restic check` |
| Restore verification | Weekly, Sundays 04:00 | `telecloud-restore-verify.timer` → `docker/backup/restore_verify.sh` | Full isolated restore + schema/row-count checks + app startup + health check + authenticated API call against restored data |

Both timers use `Persistent=true` — a missed run (VM off at the scheduled time) fires
as soon as the VM is back, rather than silently skipping, since this host isn't
guaranteed 24/7 yet.

**Failure handling:** both scripts stop immediately on any failed stage (`set -euo
pipefail` + explicit per-stage failure handling) and emit a structured JSON failure
line identifying exactly which stage failed, rather than continuing past a problem or
reporting a generic error. Neither script ever logs secret values.

## Logs

Both jobs run under systemd and log structured JSON to `journald`:
```
journalctl -u telecloud-backup.service --since today
journalctl -u telecloud-restore-verify.service --since "1 week ago"
```
Each backup run's JSON includes: start/end timestamps, duration, success/failure
(and which stage on failure), snapshot ID, dump size, integrity-check result,
retention-prune result. Each restore-verification run's JSON includes: start/end,
duration, success/failure (and stage), tables verified, user count, health-check
result, authenticated-API-call result.

## Isolation guarantee

`restore_verify.sh` never touches the live `telecloud-postgres`/`telecloud-app`
containers or their data. It restores into a throwaway scratch Postgres container and
runs a throwaway scratch app container, both on their own private Docker network with
no ports published to the host, torn down unconditionally (`trap teardown EXIT`) at
the end regardless of success or failure.

## Verification history

- 2026-07-25: first live backup run — success, 130,954-byte dump, snapshot
  independently confirmed present in B2 via `restic snapshots`.
- 2026-07-25: first live restore-verification run — success, all 9 tables verified,
  correct user count, scratch app health check passed, authenticated API call against
  restored data passed. 22 seconds end to end.
