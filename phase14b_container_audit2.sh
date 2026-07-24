#!/usr/bin/env bash
# Phase 14b — follow-up audit, fixing two bugs in phase14b_container_audit.sh:
# the Go-template Tmpfs field crashed docker inspect entirely (never got
# SecurityOpt/CapAdd/CapDrop), and the nginx log-symlink readlink call was
# malformed for busybox. Also adds a direct PID 1 Uid/Gid check (previously
# only inferred from capabilities, not confirmed directly). Read-only, no changes.
set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

for c in telecloud-nginx telecloud-app telecloud-postgres; do
  section "docker inspect (jq): $c — security-relevant HostConfig"
  docker inspect "$c" | jq '.[0].HostConfig | {Privileged, ReadonlyRootfs, SecurityOpt, CapAdd, CapDrop, Tmpfs, PidMode, IpcMode, Memory, NanoCpus, PidsLimit}'

  section "$c — PID 1 actual Uid/Gid (direct, not inferred)"
  docker exec "$c" sh -c 'grep -iE "^(Uid|Gid):" /proc/1/status' 2>&1
done

section "nginx — log target check (corrected)"
docker exec telecloud-nginx sh -c '
ls -la /var/log/nginx/
for f in /var/log/nginx/access.log /var/log/nginx/error.log; do
  echo "$f -> $(readlink -f "$f" 2>&1)"
done
'

section "CHECK COMPLETE"
echo "Copy everything above back into the chat."
