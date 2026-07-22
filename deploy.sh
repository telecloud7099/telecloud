#!/usr/bin/env bash
# deploy.sh — Phase 8 deployment workflow (SECURITY_ARCHITECTURE.md §7 process).
#
# Run this directly — do NOT `git pull` by hand first. The whole point of this
# script is that it does the pull itself and can compare before/after; pulling
# manually beforehand just makes every run look like "nothing to deploy".
#
# Manually invoked on the VM/home-server host. Deliberately NOT triggered by a git
# push or webhook — unattended auto-deploy would remove the human review step this
# project has relied on every phase (reviewing every diff before commit/push). That
# would be a separate, bigger decision with its own Security Review if ever wanted.
#
# Sequence: abort-if-dirty -> pull --ff-only -> validate nginx config (bind-mounted
# from the current file, not the project's possibly-stale built image) -> build+up
# -> health check -> smoke test -> on failure at any of the build/health steps,
# automatic rollback via git reset --hard to the commit recorded before the pull,
# rebuild, and a SECOND health check to confirm the rollback itself actually left a
# healthy system. A failed rollback is its own distinct, loudly-reported state.

set -uo pipefail
cd "$(dirname "$0")"

LOG_FILE="deploy.log"
HEALTH_URL="http://127.0.0.1/health"
# Matches docker/nginx/Dockerfile's FROM line — kept as a plain upstream image here
# specifically so config validation doesn't depend on this project's own build state.
NGINX_BASE_IMAGE="nginx:1.27-alpine"

log_result() {
  # $1=prev $2=attempted $3=rollback(yes/no) $4=final $5=status
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) prev=$1 attempted=$2 rollback=$3 final=$4 status=$5" >> "$LOG_FILE"
}

health_check() {
  # ~30s total, 3s apart — generous enough for uvicorn's startup healthcheck window
  # (compose.yml's own healthcheck uses a 20s start_period) without hanging forever.
  for _ in $(seq 1 10); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

echo "== Checking for uncommitted local changes =="
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: uncommitted local changes present — aborting to avoid discarding them." >&2
  echo "        (This guard exists because of a real incident: an uncommitted chmod" >&2
  echo "        on the VM once blocked a pull and could have been silently lost.)" >&2
  git status --short >&2
  CUR="$(git rev-parse HEAD)"
  log_result "$CUR" "-" "no" "$CUR" "ABORTED_DIRTY_TREE"
  exit 1
fi

PREV_COMMIT="$(git rev-parse HEAD)"
echo "Current commit: $PREV_COMMIT"

echo "== Pulling latest (fast-forward only) =="
if ! git pull --ff-only; then
  echo "ERROR: git pull --ff-only failed (local/remote history diverged?) — aborting, no changes made." >&2
  log_result "$PREV_COMMIT" "-" "no" "$PREV_COMMIT" "ABORTED_NOT_FF"
  exit 1
fi

NEW_COMMIT="$(git rev-parse HEAD)"
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo "Already up to date ($NEW_COMMIT) — nothing to deploy."
  log_result "$PREV_COMMIT" "$NEW_COMMIT" "no" "$NEW_COMMIT" "NOTHING_TO_DEPLOY"
  exit 0
fi

ROLLBACK_NEEDED=0

echo "== Validating nginx config (bind-mounted current file, not a possibly-stale built image) =="
if ! docker run --rm -v "$(pwd)/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" "$NGINX_BASE_IMAGE" nginx -t; then
  echo "ERROR: nginx config invalid at $NEW_COMMIT." >&2
  ROLLBACK_NEEDED=1
else
  echo "== Building and starting =="
  if ! docker compose up -d --build; then
    echo "ERROR: docker compose up failed at $NEW_COMMIT." >&2
    ROLLBACK_NEEDED=1
  else
    echo "== Health check =="
    if health_check; then
      echo "== Post-deploy security smoke test =="
      if [ -x docker/nginx/phase7_security_check.sh ]; then
        if ! ./docker/nginx/phase7_security_check.sh http://127.0.0.1:80; then
          echo "WARNING: post-deploy smoke test reported failures — review before trusting" >&2
          echo "         this deploy. Not rolled back automatically: a headers/rate-limit" >&2
          echo "         regression is a quality issue, not the outage this script guards." >&2
        fi
      fi
      echo "== Deploy successful: $PREV_COMMIT -> $NEW_COMMIT =="
      log_result "$PREV_COMMIT" "$NEW_COMMIT" "no" "$NEW_COMMIT" "SUCCESS"
      exit 0
    else
      echo "ERROR: health check failed after deploying $NEW_COMMIT." >&2
      ROLLBACK_NEEDED=1
    fi
  fi
fi

if [ "$ROLLBACK_NEEDED" = "1" ]; then
  echo "== Rolling back to $PREV_COMMIT =="
  git reset --hard "$PREV_COMMIT"
  docker compose up -d --build

  echo "== Verifying rollback health =="
  if health_check; then
    echo "Rollback successful — system healthy at $PREV_COMMIT."
    log_result "$PREV_COMMIT" "$NEW_COMMIT" "yes" "$PREV_COMMIT" "ROLLED_BACK"
    exit 1
  else
    echo "CRITICAL: rollback to $PREV_COMMIT ALSO failed its health check." >&2
    echo "          System is in an unknown state — manual intervention required now." >&2
    log_result "$PREV_COMMIT" "$NEW_COMMIT" "yes" "$PREV_COMMIT" "ROLLBACK_FAILED_MANUAL_INTERVENTION_REQUIRED"
    exit 2
  fi
fi
