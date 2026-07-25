#!/usr/bin/env bash
# restore_verify.sh — weekly proof that the latest backup is actually
# restorable AND that TeleCloud can run against it, not just that
# `pg_restore` exits 0. Fully isolated from production: a throwaway scratch
# Postgres + scratch app container on their own private Docker network, no
# ports published to the host, torn down unconditionally at the end. Never
# touches the live telecloud-postgres/telecloud-app containers or their data.
#
# Never enable xtrace (set -x) -- .env.app/.env.backup are sourced/read for
# credentials, and xtrace would echo their values to the log.
set -euo pipefail

APP_DIR="/opt/telecloud/app"
SCRATCH_DIR="/opt/telecloud/restore_verify_scratch"
LOCK_FILE="/opt/telecloud/restore_verify_scratch/.restore_verify.lock"
NET="telecloud-restore-verify-net"
PG_CONTAINER="telecloud-restore-verify-pg"
APP_CONTAINER="telecloud-restore-verify-app"
SCRATCH_PG_PASSWORD=$(openssl rand -hex 24)

mkdir -p "$SCRATCH_DIR"
exec 200>"$LOCK_FILE"
flock -n 200 || { echo '{"status":"skipped","reason":"previous restore verification still running"}'; exit 0; }

cd "$APP_DIR"

DATABASE_URL_LIVE=$(grep '^DATABASE_URL=' "$APP_DIR/.env.app" | cut -d '=' -f2-)
ENCRYPTION_KEY=$(grep '^ENCRYPTION_KEY=' "$APP_DIR/.env.app" | cut -d '=' -f2-)
JWT_SECRET=$(grep '^JWT_SECRET=' "$APP_DIR/.env.app" | cut -d '=' -f2-)
PG_DIGEST_IMAGE=$(grep -o 'postgres:18-alpine@sha256:[a-f0-9]*' "$APP_DIR/compose.yml" | head -1)
set -a
source "$APP_DIR/.env.backup"
set +a

START_TS=$(date -Iseconds)
START_EPOCH=$(date +%s)

teardown() {
  docker rm -f "$APP_CONTAINER" "$PG_CONTAINER" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  rm -rf "${SCRATCH_DIR:?}"/restore_* 2>/dev/null || true
}
trap teardown EXIT

fail() {
  local stage="$1"
  local end_ts end_epoch duration
  end_ts=$(date -Iseconds)
  end_epoch=$(date +%s)
  duration=$((end_epoch - START_EPOCH))
  printf '{"status":"failure","stage":"%s","start":"%s","end":"%s","duration_seconds":%d}\n' \
    "$stage" "$START_TS" "$end_ts" "$duration" >&2
  exit 1
}
trap 'fail "unexpected_error"' ERR

# 1. Restore the latest snapshot from B2 to a scratch dir on the host.
RESTORE_TARGET="$SCRATCH_DIR/restore_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESTORE_TARGET"
restic restore latest --target "$RESTORE_TARGET" > /dev/null || fail "restic_restore"
DUMP_FILE=$(find "$RESTORE_TARGET" -name '*.dump' | head -1)
[ -n "$DUMP_FILE" ] || fail "restored_dump_not_found"

# 2. Isolated network + scratch Postgres (same pinned digest as production,
# parsed from compose.yml rather than hardcoded a second time).
docker network create "$NET" > /dev/null || fail "network_create"
docker run -d --name "$PG_CONTAINER" --network "$NET" \
  -e POSTGRES_USER=telecloud -e POSTGRES_PASSWORD="$SCRATCH_PG_PASSWORD" -e POSTGRES_DB=telecloud \
  "$PG_DIGEST_IMAGE" > /dev/null || fail "scratch_postgres_start"

for i in $(seq 1 30); do
  docker exec "$PG_CONTAINER" pg_isready -U telecloud > /dev/null 2>&1 && break
  [ "$i" -eq 30 ] && fail "scratch_postgres_not_ready"
  sleep 1
done

# 3. Restore into the scratch instance (never touches the live DB).
docker cp "$DUMP_FILE" "$PG_CONTAINER:/tmp/restore.dump" > /dev/null || fail "docker_cp_dump"
docker exec "$PG_CONTAINER" pg_restore -U telecloud -d telecloud /tmp/restore.dump > /dev/null 2>&1 || true
# pg_restore against a fresh DB commonly exits non-zero on harmless
# ownership/grant errors from the source (Neon-specific roles) -- verified
# in docs/DISASTER_RECOVERY_RUNBOOK.md, not treated as fatal on its own.
# The checks below are what actually determine pass/fail.

# 4. Schema + row-count sanity checks.
EXPECTED_TABLES="file_chunks files folders sync_state upload_sessions user_api_credentials user_sessions user_settings users"
for t in $EXPECTED_TABLES; do
  docker exec "$PG_CONTAINER" psql -U telecloud -d telecloud -tAc \
    "SELECT to_regclass('public.$t') IS NOT NULL;" | grep -q '^t$' || fail "missing_table_$t"
done
USER_COUNT=$(docker exec "$PG_CONTAINER" psql -U telecloud -d telecloud -tAc "SELECT count(*) FROM users;")
[ "$USER_COUNT" -gt 0 ] || fail "users_table_empty"
FIRST_USER_ID=$(docker exec "$PG_CONTAINER" psql -U telecloud -d telecloud -tAc "SELECT telegram_user_id FROM users LIMIT 1;" | tr -d ' ')

# 5. Scratch app instance, isolated network, no published ports at all --
# reached only via `docker exec ... curl localhost:8000` from inside itself.
docker run -d --name "$APP_CONTAINER" --network "$NET" \
  -e DATABASE_URL="postgresql://telecloud:$SCRATCH_PG_PASSWORD@$PG_CONTAINER:5432/telecloud" \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" -e JWT_SECRET="$JWT_SECRET" \
  telecloud-telecloud-app:latest > /dev/null || fail "scratch_app_start"

for i in $(seq 1 30); do
  docker exec "$APP_CONTAINER" curl -sf http://localhost:8000/health > /dev/null 2>&1 && break
  [ "$i" -eq 30 ] && fail "scratch_app_not_healthy"
  sleep 1
done

# 6. A real, authenticated API call against the restored data -- proves the
# app can actually use it, not just that SQL loaded. Token minted inside the
# scratch container using its own JWT_SECRET; never printed or logged.
FOLDERS_STATUS=$(docker exec "$APP_CONTAINER" python3 -c "
import jwt, os, datetime, urllib.request
now = datetime.datetime.now(datetime.timezone.utc)
token = jwt.encode(
    {'sub': '$FIRST_USER_ID',
     'exp': now + datetime.timedelta(hours=1),
     'iat': now},
    os.environ['JWT_SECRET'], algorithm='HS256')
req = urllib.request.Request('http://localhost:8000/folders', headers={'Authorization': f'Bearer {token}'})
import json
with urllib.request.urlopen(req, timeout=10) as resp:
    print(json.loads(resp.read())['status'])
") || fail "authenticated_api_call"
[ "$FOLDERS_STATUS" = "success" ] || fail "api_call_unexpected_status"

END_TS=$(date -Iseconds)
END_EPOCH=$(date +%s)
DURATION=$((END_EPOCH - START_EPOCH))

printf '{"status":"success","start":"%s","end":"%s","duration_seconds":%d,"tables_verified":%d,"user_count":%d,"health_check":"passed","authenticated_api_call":"passed"}\n' \
  "$START_TS" "$END_TS" "$DURATION" "$(echo $EXPECTED_TABLES | wc -w)" "$USER_COUNT"
