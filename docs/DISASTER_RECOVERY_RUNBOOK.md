# Disaster Recovery Runbook — PostgreSQL Backup & Restore

Phase 13 deliverable, extended Phase 15 with automated encrypted offsite backups
(`docs/BACKUP_POLICY.md`) and this document's §6/§7 below. Every step in §0-5 was
actually executed and verified on this VM on 2026-07-23 against the real production
Neon database (not a synthetic stand-in) — this is a proven procedure, not a
theoretical one. Repo commits `28ce356`, `8895256`, `0c41d22` correspond to the
config/tooling changes made along the way; this doc is the narrative.

**RPO/RTO:** see `docs/BACKUP_POLICY.md` — 24h / under 2h.

**✅ verified** marks something directly observed this session. **⚠️ not yet exercised**
marks something this runbook assumes but hasn't been tested end-to-end (e.g., recovering
from a truly *lost* Neon database, as opposed to backing up a healthy one).

---

## 0. Prerequisite: version parity (do this once, not per-backup)

**✅ Verified finding:** the local `postgres` container had been running `postgres:16-alpine`
since Phase 4 as a reasonable default, but was **never actually checked** against Neon's
real server version until Phase 13. Direct query revealed Neon runs **PostgreSQL 18.4**, a
major-version mismatch that would have caused a failed or unreliable restore.

```bash
# Local version:
docker compose exec postgres psql -U telecloud -d telecloud -c "SELECT version();"

# Neon version (reads DATABASE_URL from .env.app into a shell variable -- never echo it):
export DATABASE_URL=$(grep '^DATABASE_URL=' .env.app | cut -d '=' -f2-)
docker compose exec postgres psql "$DATABASE_URL" -c "SELECT version();"
```

If these don't match on major version, fix the local image tag (`compose.yml`'s `postgres:`
service) to match before proceeding — don't attempt a cross-major-version restore and hope.

**✅ Verified gotcha:** upgrading the local image to `postgres:18-alpine` while the old v16
bind-mount data directory still existed caused an immediate crash-loop. Starting at v18, the
official image expects its volume mounted at `/var/lib/postgresql` (one level up from the
old `.../data` convention) — it creates its own version-specific subdirectory inside, per
`docker-library/postgres` PR #1259 / issue #37. Fixed by updating `compose.yml`'s volume
line and renaming (not deleting) the old data directory aside:
```bash
docker compose stop postgres
sudo mv /opt/telecloud/data/postgres /opt/telecloud/data/postgres.v16.bak   # preserved, not deleted
sudo mkdir -p /opt/telecloud/data/postgres
sudo chown 70:70 /opt/telecloud/data/postgres   # Alpine postgres images run as uid 70
docker compose up -d postgres
```

---

## 1. Create the backup

```bash
export DATABASE_URL=$(grep '^DATABASE_URL=' .env.app | cut -d '=' -f2-)
docker compose exec postgres pg_dump "$DATABASE_URL" -Fc -f /tmp/neon_backup.dump
```

**✅ Verified:** exit code 0, produced a 128,490-byte custom-format (`-Fc`) dump (metadata
only — the actual file bytes live on Telegram, not in Postgres, so dump size stays small
regardless of how much has been uploaded through TeleCloud).

Custom format (`-Fc`) is used deliberately over plain SQL: it supports `pg_restore`'s
selective-restore and parallel-restore options, and compresses by default.

**⚠️ Not yet exercised:** copying this dump file off the VM to genuine off-site storage.
This runbook proves the dump/restore *mechanism* works; a real disaster-recovery posture
still needs the dump copied somewhere that survives this VM/host being lost entirely —
tracked as a follow-up, not done as part of this phase.

---

## 2. Restore into a clean database

Restore into a **new, separate database** on the local instance — never directly onto an
existing database you can't afford to lose, even in a drill:

```bash
docker compose exec postgres psql -U telecloud -d telecloud -c "CREATE DATABASE telecloud_restore_test;"
docker compose exec postgres pg_restore -U telecloud -d telecloud_restore_test /tmp/neon_backup.dump
```

**✅ Verified, and an important distinction to document clearly:** this returned exit code
**1**, with 13 errors — but **all 13 were `ALTER TABLE ... OWNER TO neondb_owner` /
`ALTER DEFAULT PRIVILEGES ... TO neon_superuser`** statements. These are Neon-specific
role/ownership metadata that doesn't exist on a self-hosted instance — **not** `CREATE
TABLE` or `COPY` (data-loading) statements, none of which appeared in the error list.

**Don't treat `pg_restore`'s exit code as pass/fail on its own.** Read what actually failed.
A restore from a managed cloud provider into self-hosted Postgres will essentially always
show ownership-related errors like this; the correct response is to verify the actual
schema and data landed correctly (§3 below), not to treat exit code 1 as an automatic
failure. In this case, tables ended up owned by `telecloud` (the connecting user) instead
of the nonexistent `neondb_owner` — which is the correct outcome for a self-hosted
instance, not a lesser one.

---

## 3. Verify restored data matches the original

**Row counts across all tables** (✅ verified — build the query as a file first; a
multi-line heredoc pasted through a relayed terminal can silently break on this
environment, see the note at the end of this doc):

```bash
docker compose exec postgres psql "$DATABASE_URL" -f /tmp/rowcounts.sql
docker compose exec postgres psql -U telecloud -d telecloud_restore_test -f /tmp/rowcounts.sql
```

**✅ Verified result (2026-07-23):** all 9 tables matched exactly between source and
restored copy: `file_chunks=11, files=1737, folders=198, sync_state=2, upload_sessions=22,
user_api_credentials=2, user_sessions=2, user_settings=0, users=2`.

**Content, not just counts** — an md5 checksum over key non-sensitive fields (never
printing the actual row data) of the largest table:

```bash
docker compose exec postgres psql "$DATABASE_URL" -f /tmp/checksum.sql
docker compose exec postgres psql -U telecloud -d telecloud_restore_test -f /tmp/checksum.sql
```

**✅ Verified result:** identical md5 (`729c2f5170440e5126804a0f5ffcc36d`) on both sides
across all 1737 `files` rows' `id`/`telegram_message_id`/`filename`/`mime_type`/`file_size`
fields — proves actual content matches, not just row counts (which alone wouldn't catch,
e.g., swapped or corrupted field values within otherwise-correct row totals).

---

## 4. Verify the application's own ORM layer reads it correctly

Row counts and checksums prove the *data* survived; this step proves the *app* can actually
use it — via the real `SQLModel` models (`backend/database.py`), not just raw SQL, and
**without touching the live app's real configuration**:

```bash
docker cp phase13_verify_orm.py telecloud-app:/app/phase13_verify_orm.py
export PGPASS=$(grep '^POSTGRES_PASSWORD=' .env.db | cut -d '=' -f2-)
docker compose exec -e DATABASE_URL="postgresql://telecloud:$PGPASS@postgres:5432/telecloud_restore_test" \
    telecloud-app python3 /app/phase13_verify_orm.py
```

This overrides `DATABASE_URL` for a single `docker compose exec` invocation only — the
running `telecloud-app` container's actual environment/config is never modified or
restarted, and it keeps talking to the real Neon database throughout.

**✅ Verified result:** every typed SQLModel query (across all 9 models, including
`BigInteger` fields and foreign-key-backed relations) completed with zero exceptions,
row counts matching §3 exactly, plus a sensible category breakdown for `files` (Images:
1367, Videos: 310, Other: 19, Docs: 21, Archives: 7, APK: 7, Audio: 6) and status
breakdown for `upload_sessions` (aborted: 14, completed: 8) — real, meaningful, correctly
typed data, not just row counts that happen to match.

---

## 5. Cleanup after a drill

```bash
docker compose exec postgres psql -U telecloud -d telecloud -c "DROP DATABASE telecloud_restore_test;"
docker compose exec postgres rm -f /tmp/neon_backup.dump /tmp/rowcounts.sql /tmp/checksum.sql
docker exec telecloud-app rm -f /app/phase13_verify_orm.py
unset DATABASE_URL PGPASS   # clear from the shell session
```

The renamed `postgres.v16.bak` directory from §0 can be removed once you're satisfied the
v18 container is stable — it was never real production data, just an idle empty cluster.

---

## Lessons for next time

- **Check version parity empirically before assuming it** — a reasonable default chosen
  months earlier (Phase 4) had silently drifted from reality (Neon upgraded to 18 at some
  point since); nothing would have surfaced this until an actual restore attempt failed.
- **`pg_restore`'s exit code alone is not a verdict** — read what specifically failed.
  Ownership/grant errors against a cloud-provider-specific role are expected and harmless;
  missing tables or data would show up as a different class of error entirely.
- **Terminal reliability caveat:** this VM's relayed terminal has repeatedly mis-handled
  multi-line heredocs and long single lines (silently inserting line breaks that corrupt
  the command). Building multi-line SQL/scripts via a sequence of short single-line `echo
  ... >> file` appends has proven reliable where heredocs and long one-liners have not.
- **Row-count parity and content parity are different checks** — do both. Row counts alone
  would not catch a scenario where the right number of rows exist but with wrong/corrupted
  field values.

---

## 6. Secrets required for a complete recovery

Preserving these (values, not this list — this document intentionally records only
*names* and where they normally live) is what actually determines whether recovery is
possible at all. Losing any of these turns an otherwise-working backup into
unusable data.

| Secret | Normally lives in | Required for | If lost |
|---|---|---|---|
| `RESTIC_PASSWORD` | `.env.backup`, **and a copy outside this VM (password manager, etc.)** | Decrypting any restic snapshot | **Catastrophic and unrecoverable.** Every snapshot in B2 becomes permanently undecryptable. This is the single most important secret in the entire backup system — see `docs/BACKUP_POLICY.md`. |
| B2 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `.env.backup` | Reading/writing the B2 bucket | Recoverable — regenerate a new bucket-scoped application key from the Backblaze dashboard, update `.env.backup`. Doesn't affect existing snapshot data. |
| `ENCRYPTION_KEY` | `.env.app` | Decrypting `StringSession`/API-credential rows in the restored database | **Catastrophic for Telegram connectivity specifically.** Without it, the restored `users`/`user_api_credentials` rows exist but their Telegram sessions can never be decrypted — equivalent to every user needing to re-authenticate via OTP from scratch. File data on Telegram itself is unaffected. |
| `JWT_SECRET` | `.env.app` | Validating/issuing login sessions | Low impact if lost — regenerate a new value; every existing JWT is invalidated and all users must log in again, no data risk (same as the routine rotation procedure in `SECURITY_NOTES.md` §6). |
| `POSTGRES_PASSWORD` | `.env.db` | Local Postgres container auth | Low impact if lost — regenerate, update `.env.db`, recreate the container. Doesn't affect Neon or restic-backed data. |
| Telegram API credentials (`api_id`/`api_hash`, if self-hosted rather than per-user) | Wherever originally configured (see `docs/PHASE2/6` setup) | Establishing new Telegram client connections | Depends on scope — check current app config; this runbook doesn't assume a specific storage location since it may be per-user (`user_api_credentials`, covered by `ENCRYPTION_KEY` above) rather than a single shared app-level credential. |

**Practical implication:** a full recovery is only actually possible if `RESTIC_PASSWORD`
and `ENCRYPTION_KEY` both survive whatever destroyed the VM. Neither should ever exist
in only one place. Verify both have a current copy stored outside this machine whenever
either is rotated.

---

## 7. Total-loss recovery — starting from a bare machine

Unlike §1-5 (a live-VM drill), this procedure assumes the VM itself is gone —
provisioning a genuinely new machine with nothing on it but internet access. Written so
someone unfamiliar with this project's history could follow it end to end.

### 7.1. Prerequisites before starting

You need, from outside the destroyed machine (per §6's inventory):
- `RESTIC_PASSWORD` and the B2 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (to reach
  the offsite backup at all).
- `ENCRYPTION_KEY` (to decrypt restored Telegram sessions — without it, treat this as
  a metadata-only recovery and expect to re-authenticate all users via OTP).
- `JWT_SECRET` and `POSTGRES_PASSWORD` (regenerable if lost, not required to already
  have them).
- Access to this git repository.

### 7.2. Provision the new host

```bash
sudo apt update && sudo apt install -y git docker.io docker-compose-plugin restic
sudo usermod -aG docker $USER   # then re-login/reboot for group membership to apply
git clone <repo-url> /opt/telecloud/app
cd /opt/telecloud/app
```
Confirms cleanly per Phase 15 item 10's reproducibility check — a fresh clone + build
at a known-good commit is proven to work, not assumed.

### 7.3. Recreate the secret files

```bash
cp .env.app.example .env.app      # fill in DATABASE_URL, ENCRYPTION_KEY, JWT_SECRET, etc.
cp .env.db.example .env.db        # fill in POSTGRES_USER/PASSWORD/DB
cp .env.backup.example .env.backup  # fill in AWS_*, RESTIC_REPOSITORY, RESTIC_PASSWORD
chmod 600 .env.app .env.db .env.backup
```
Use the actual preserved values from §6 for `ENCRYPTION_KEY`/`RESTIC_PASSWORD`/B2
credentials — everything else can be freshly generated.

### 7.4. Restore the database from the offsite backup

```bash
docker compose up -d postgres
# wait for healthy:
docker compose ps

set -a; source .env.backup; set +a
restic snapshots                          # confirm the expected snapshot is visible
restic restore latest --target /tmp/recovery
docker cp /tmp/recovery/*.dump telecloud-postgres:/tmp/recovery.dump
docker compose exec postgres pg_restore -U telecloud -d telecloud /tmp/recovery.dump
```
Expect the same harmless ownership-error pattern documented in §2 (`ALTER TABLE ...
OWNER TO neondb_owner`) — not a failure signal on its own. Verify per §3's row-count
and checksum queries before proceeding.

### 7.5. Bring up the full stack

```bash
docker compose build --no-cache
docker compose up -d
docker compose ps            # all three healthy
curl -f http://localhost/health
```

### 7.6. Re-establish automation

```bash
sudo cp docker/backup/telecloud-backup.service docker/backup/telecloud-backup.timer \
        docker/backup/telecloud-restore-verify.service docker/backup/telecloud-restore-verify.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telecloud-backup.timer telecloud-restore-verify.timer
```
If `docker/network/telecloud-docker-user-rules.service` (Phase 14a) also needs
reinstalling on the new host, see `docs/PHASE14A_NETWORK_HARDENING.md`.

### 7.7. Final verification

Run the full functional test matrix (`docs/FUNCTIONAL_TEST_MATRIX.md`) against the
recovered instance before considering recovery complete — a restored database and a
healthy container status are necessary but not sufficient; a real login/upload/download
pass is what actually confirms service is restored.
