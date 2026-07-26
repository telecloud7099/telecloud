#!/usr/bin/env bash
# notify.sh <SEVERITY> <component> <message> [see-command]
# Sends a standardized alert to ntfy.sh. SEVERITY is one of
# CRITICAL/WARNING/RECOVERY/INFO. Every notification follows the same
# format so alerts are consistently actionable, per docs/MONITORING.md.
#
# Never enable xtrace (set -x) -- .env.monitoring is sourced for the ntfy
# topic (an effectively-shared-secret, since ntfy.sh's public server has no
# access control beyond knowing the topic name) and xtrace would echo it.
set -euo pipefail

SEVERITY="${1:?severity required (CRITICAL/WARNING/RECOVERY/INFO)}"
COMPONENT="${2:?component required}"
MESSAGE="${3:?message required}"
SEE_CMD="${4:-}"

set -a
source /opt/telecloud/app/.env.monitoring
set +a

HOST=$(hostname)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

case "$SEVERITY" in
  CRITICAL) PRIORITY=urgent;  TAGS="rotating_light" ;;
  WARNING)  PRIORITY=high;    TAGS="warning" ;;
  RECOVERY) PRIORITY=default; TAGS="white_check_mark" ;;
  INFO)     PRIORITY=default; TAGS="information_source" ;;
  *)        PRIORITY=default; TAGS="" ;;
esac

BODY="Severity: $SEVERITY
Component: $COMPONENT
Host: $HOST
Time: $TS

$MESSAGE"

if [ -n "$SEE_CMD" ]; then
  BODY="$BODY
See:
$SEE_CMD"
fi

curl -s \
  -H "Title: [$SEVERITY] TeleCloud: $COMPONENT" \
  -H "Priority: $PRIORITY" \
  -H "Tags: $TAGS" \
  -d "$BODY" \
  "https://ntfy.sh/$NTFY_TOPIC" > /dev/null
