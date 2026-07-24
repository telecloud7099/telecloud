#!/usr/bin/env bash
# phase15_stability_snapshot.sh — one monitoring snapshot for the Phase 15
# item 4 24-48h stability test. Appends to a persistent log (NOT /tmp --
# this VM's /tmp is tmpfs and gets wiped on reboot, a known Phase 11
# gotcha), run on an interval via a systemd timer so it survives the
# terminal window closing.
set -uo pipefail

LOG="/opt/telecloud/app/phase15_stability.log"

{
  echo "===== $(date -Iseconds) ====="
  echo "--- docker compose ps ---"
  cd /opt/telecloud/app && docker compose ps --format 'table {{.Name}}\t{{.Status}}'
  echo "--- docker stats (no-stream) ---"
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'
  echo "--- disk usage ---"
  df -h / /opt/telecloud/data 2>/dev/null
  echo "--- container restart counts ---"
  docker inspect telecloud-app telecloud-nginx telecloud-postgres --format '{{.Name}}: RestartCount={{.RestartCount}}'
  echo "--- recent errors/crashes since last snapshot (app + nginx) ---"
  docker compose logs telecloud-app nginx --since 16m 2>&1 | grep -iE "error|traceback|exception|crash" | tail -20
} >> "$LOG" 2>&1
