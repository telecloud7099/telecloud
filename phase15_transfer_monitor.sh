#!/usr/bin/env bash
# phase15_transfer_monitor.sh — tight-interval resource monitoring for
# Phase 15 items 5+7 (large-file transfer + resource measurement under
# real load). Run this in one terminal WHILE the upload/download happens
# in the browser in parallel. Ctrl+C to stop once the transfer completes.
#
# Also watches specifically for the Phase 11 upload-unresponsiveness
# signature (item 8): a healthcheck-style curl to the app that hangs or
# fails during the transfer, logged with its own timing so a hang is
# directly visible in the log rather than inferred after the fact.
set -uo pipefail

LOG="/opt/telecloud/app/phase15_transfer_monitor.log"
echo "===== Monitoring started $(date -Iseconds) =====" >> "$LOG"

trap 'echo "===== Monitoring stopped $(date -Iseconds) =====" >> "$LOG"; exit 0' INT TERM

while true; do
  {
    echo "--- $(date -Iseconds) ---"
    docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}'
    echo -n "host loadavg: "; cat /proc/loadavg
    echo -n "host mem: "; free -h | awk 'NR==2{print $3"/"$2" used"}'
    # External curl via nginx (port 80), replicating Phase 11's exact
    # observed symptom ("even an external curl hung indefinitely") rather
    # than Docker's internal healthcheck, which runs inside the container's
    # own namespace and isn't reachable this way. Timed explicitly so a
    # hang shows up directly in the log, not just inferred afterward.
    echo -n "external curl probe (nginx:80): "
    timeout 15 curl -s -o /dev/null -w "HTTP %{http_code} time=%{time_total}s" http://localhost/health 2>&1 || echo "PROBE TIMED OUT/FAILED"
    echo ""
    # Docker's own healthcheck status directly, matching Phase 11's
    # "healthcheck failed 12 consecutive times" observation.
    echo -n "docker healthcheck status: "
    docker inspect telecloud-app --format='{{.State.Health.Status}} (failing streak: {{.State.Health.FailingStreak}})'
  } >> "$LOG" 2>&1
  sleep 5
done
