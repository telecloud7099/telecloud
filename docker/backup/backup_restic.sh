#!/usr/bin/env bash
# backup_restic.sh — daily encrypted, offsite backup of the Postgres metadata.
# pg_dump -> restic backup -> restic forget --prune (retention) -> restic check
# (integrity). Structured JSON logged to stdout, which systemd routes to
# journald when this runs as telecloud-backup.service.
#
# Never enable xtrace (set -x) in this script -- .env.backup/.env.app are
# sourced for credentials, and xtrace would echo their values to the log.
set -euo pipefail

APP_DIR="/opt/telecloud/app"
SCRATCH_DIR="/opt/telecloud/backup_scratch"
LOCK_FILE="/opt/telecloud/backup_scratch/.backup.lock"

mkdir -p "$SCRATCH_DIR"
exec 200>"$LOCK_FILE"
flock -n 200 || { echo '{"status":"skipped","reason":"previous backup still running"}'; exit 0; }

cd "$APP_DIR"

# DATABASE_URL extracted via grep/cut, not `source .env.app` -- matches the
# proven pattern from docs/DISASTER_RECOVERY_RUNBOOK.md (a plain `source` of
# the full file doesn't reliably export it, likely due to characters in the
# connection string). .env.backup's simpler KEY=value pairs source cleanly.
DATABASE_URL=$(grep '^DATABASE_URL=' "$APP_DIR/.env.app" | cut -d '=' -f2-)
set -a
source "$APP_DIR/.env.backup"
set +a

START_TS=$(date -Iseconds)
START_EPOCH=$(date +%s)
DUMP_FILE="$SCRATCH_DIR/telecloud_$(date +%Y%m%d_%H%M%S).dump"

fail() {
  local stage="$1"
  local end_ts end_epoch duration
  end_ts=$(date -Iseconds)
  end_epoch=$(date +%s)
  duration=$((end_epoch - START_EPOCH))
  printf '{"status":"failure","stage":"%s","start":"%s","end":"%s","duration_seconds":%d}\n' \
    "$stage" "$START_TS" "$end_ts" "$duration" >&2
  rm -f "$DUMP_FILE"
  exit 1
}

trap 'fail "unexpected_error"' ERR

# pg_dump straight to a host-side file via stdout -- avoids `docker cp`
# against a read_only container (known broken since Phase 14b hardening,
# see docs/PHASE15_GO_NO_GO_TEST_PLAN.md item 6).
docker compose exec -T postgres pg_dump "$DATABASE_URL" -Fc -f - > "$DUMP_FILE" \
  || fail "pg_dump"

DUMP_SIZE=$(stat -c%s "$DUMP_FILE")

BACKUP_JSON=$(restic backup "$DUMP_FILE" --tag telecloud-daily --json 2>/dev/null | tail -1) \
  || fail "restic_backup"
SNAPSHOT_ID=$(echo "$BACKUP_JSON" | grep -o '"snapshot_id":"[^"]*"' | cut -d'"' -f4)

restic forget --tag telecloud-daily \
  --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune \
  > /dev/null || fail "retention_prune"

restic check > /dev/null || fail "integrity_check"

rm -f "$DUMP_FILE"

END_TS=$(date -Iseconds)
END_EPOCH=$(date +%s)
DURATION=$((END_EPOCH - START_EPOCH))

printf '{"status":"success","start":"%s","end":"%s","duration_seconds":%d,"snapshot_id":"%s","dump_bytes":%d,"integrity_check":"passed","retention_prune":"completed"}\n' \
  "$START_TS" "$END_TS" "$DURATION" "$SNAPSHOT_ID" "$DUMP_SIZE"
