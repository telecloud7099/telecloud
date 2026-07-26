#!/usr/bin/env bash
# security_alert.sh — runs the existing security_event_summary.py (Phase 12,
# unmodified) against log lines since the last check, and alerts only if it
# emits a literal "FLAG:" line -- routine, below-threshold auth failures
# never generate a notification, since the wrapped script's own clustering
# threshold already decides what counts as suspicious.
#
# Uses a since-last-check window (not a fixed lookback) so the same
# historical cluster isn't re-reported across multiple runs.
set -euo pipefail

APP_DIR="/opt/telecloud/app"
STATE_FILE="/opt/telecloud/monitoring_state/security_alert_last_run"
NOTIFY="/opt/telecloud/app/docker/monitoring/notify.sh"

mkdir -p "$(dirname "$STATE_FILE")"
cd "$APP_DIR"

SINCE=$(cat "$STATE_FILE" 2>/dev/null || date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

OUTPUT=$(docker compose logs telecloud-app --since "$SINCE" 2>&1 | python3 security_event_summary.py)

echo "$NOW" > "$STATE_FILE"

if echo "$OUTPUT" | grep -q "FLAG:"; then
  FLAGS=$(echo "$OUTPUT" | grep "FLAG:")
  "$NOTIFY" WARNING "Security" \
    "Suspicious activity detected since $SINCE:
$FLAGS" \
    "docker compose logs telecloud-app --since 6h | python3 security_event_summary.py"
fi
