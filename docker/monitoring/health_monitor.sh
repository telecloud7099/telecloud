#!/usr/bin/env bash
# health_monitor.sh — runs every 5 minutes. Detects, for each expected
# container: missing entirely, exited, unhealthy (per Docker healthcheck,
# where one is defined), and restart loops (RestartCount jumping since the
# last check). State is tracked per-container so repeated failures don't
# re-alert every cycle (dedup), and a transition back to healthy sends a
# RECOVERY notification instead of just going quiet.
set -euo pipefail

NOTIFY="/opt/telecloud/app/docker/monitoring/notify.sh"
STATE_DIR="/opt/telecloud/monitoring_state"
CONTAINERS="telecloud-app telecloud-nginx telecloud-postgres"
RESTART_LOOP_THRESHOLD=3

mkdir -p "$STATE_DIR"

for NAME in $CONTAINERS; do
  STATE_FILE="$STATE_DIR/${NAME}.state"
  PREV_STATUS="unknown"
  PREV_RESTARTS=0
  PREV_ALERTING="no"
  PREV_LOOP_ALERTING="no"
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi

  if ! docker inspect "$NAME" > /dev/null 2>&1; then
    CURRENT_STATUS="missing"
    RESTARTS=0
  else
    RUNNING=$(docker inspect "$NAME" --format '{{.State.Running}}')
    HEALTH=$(docker inspect "$NAME" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    RESTARTS=$(docker inspect "$NAME" --format '{{.RestartCount}}')

    if [ "$RUNNING" != "true" ]; then
      CURRENT_STATUS="exited"
    elif [ "$HEALTH" = "unhealthy" ]; then
      CURRENT_STATUS="unhealthy"
    else
      CURRENT_STATUS="healthy"
    fi
  fi

  # Health/existence transition -- dedup via PREV_ALERTING.
  if [ "$CURRENT_STATUS" != "healthy" ]; then
    if [ "$PREV_ALERTING" != "yes" ]; then
      "$NOTIFY" CRITICAL "$NAME" \
        "Container is $CURRENT_STATUS." \
        "docker compose ps; docker inspect $NAME --format '{{json .State}}'"
      ALERTING="yes"
    else
      ALERTING="yes"
    fi
  else
    if [ "$PREV_ALERTING" = "yes" ]; then
      "$NOTIFY" RECOVERY "$NAME" "Container is healthy again." ""
    fi
    ALERTING="no"
  fi

  # Restart-loop detection -- separate dedup flag, since a container can be
  # simultaneously "healthy right now" and "was crash-looping a moment ago".
  DELTA=$((RESTARTS - PREV_RESTARTS))
  if [ "$DELTA" -ge "$RESTART_LOOP_THRESHOLD" ]; then
    if [ "$PREV_LOOP_ALERTING" != "yes" ]; then
      "$NOTIFY" CRITICAL "$NAME" \
        "Restart loop detected: RestartCount increased by $DELTA in the last 5 minutes (now $RESTARTS)." \
        "docker compose logs $NAME --since 15m"
    fi
    LOOP_ALERTING="yes"
  else
    if [ "$PREV_LOOP_ALERTING" = "yes" ]; then
      "$NOTIFY" RECOVERY "$NAME" "Restart count has stabilized." ""
    fi
    LOOP_ALERTING="no"
  fi

  cat > "$STATE_FILE" <<EOF
PREV_STATUS=$CURRENT_STATUS
PREV_RESTARTS=$RESTARTS
PREV_ALERTING=$ALERTING
PREV_LOOP_ALERTING=$LOOP_ALERTING
EOF
done
