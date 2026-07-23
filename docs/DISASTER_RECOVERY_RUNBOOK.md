# Disaster Recovery Runbook — PostgreSQL Backup & Restore

Phase 13 deliverable. Every step below was actually executed and verified on this VM on
2026-07-23 against the real production Neon database (not a synthetic stand-in) — this is
a proven procedure, not a theoretical one. Repo commits `28ce356`, `8895256`, `0c41d22`
correspond to the config/tooling changes made along the way; this doc is the narrative.

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
