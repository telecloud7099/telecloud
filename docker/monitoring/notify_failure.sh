#!/usr/bin/env bash
# notify_failure.sh <failed-unit-name>
# Triggered via systemd's OnFailure= on telecloud-backup.service and
# telecloud-restore-verify.service. Pulls the {"status":"failure",...} JSON
# line that unit's script already prints on any failed stage and sends a
# CRITICAL alert naming exactly which stage failed.
set -euo pipefail

UNIT="${1:?unit name required}"
NOTIFY="/opt/telecloud/app/docker/monitoring/notify.sh"

# journald may not have indexed the just-failed service's own output yet --
# OnFailure= fires essentially the instant the main process exits, a real
# race observed live during testing, not a theoretical one. Every step here
# tolerates finding nothing rather than aborting under set -e.
LAST_JSON=$(journalctl -u "$UNIT" --since "10 minutes ago" -o cat 2>/dev/null | grep -o '{"status":"failure"[^}]*}' | tail -1) || true
STAGE=$(echo "$LAST_JSON" | grep -o '"stage":"[^"]*"' | cut -d'"' -f4) || true
STAGE="${STAGE:-unknown}"

case "$UNIT" in
  telecloud-backup.service)         COMPONENT="Backup" ;;
  telecloud-restore-verify.service) COMPONENT="Restore Verification" ;;
  *)                                 COMPONENT="$UNIT" ;;
esac

"$NOTIFY" CRITICAL "$COMPONENT" \
  "$COMPONENT failed at stage: $STAGE" \
  "journalctl -u $UNIT --since today"
