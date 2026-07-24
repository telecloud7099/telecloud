#!/usr/bin/env bash
# Phase 14b — Container Hardening: read-only audit.
# Captures current capabilities, security options, filesystem posture, and
# actual write behavior for all three TeleCloud containers, so the
# cap-drop/no-new-privileges/read-only-fs+tmpfs plan is built from evidence
# rather than assumption. Makes NO changes.
set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

section "COMPOSE.YML AS DEPLOYED (full)"
cat /opt/telecloud/app/compose.yml

section "DOCKER DAEMON SECURITY OPTIONS (seccomp/apparmor support)"
docker info 2>&1 | grep -iE "seccomp|apparmor|Security Options" -A3

section "HOST APPARMOR STATUS"
cat /sys/module/apparmor/parameters/enabled 2>&1
sudo apparmor_status 2>&1 | head -10

for c in telecloud-nginx telecloud-app telecloud-postgres; do
  section "docker inspect: $c — security-relevant HostConfig fields"
  docker inspect "$c" --format '
Privileged:      {{.HostConfig.Privileged}}
ReadonlyRootfs:  {{.HostConfig.ReadonlyRootfs}}
SecurityOpt:     {{.HostConfig.SecurityOpt}}
CapAdd:          {{.HostConfig.CapAdd}}
CapDrop:         {{.HostConfig.CapDrop}}
User (config):   {{.Config.User}}
PidMode:         {{.HostConfig.PidMode}}
IpcMode:         {{.HostConfig.IpcMode}}
NetworkMode:     {{.HostConfig.NetworkMode}}
Memory:          {{.HostConfig.Memory}}
NanoCpus:        {{.HostConfig.NanoCpus}}
PidsLimit:       {{.HostConfig.PidsLimit}}
RestartPolicy:   {{.HostConfig.RestartPolicy.Name}}
Tmpfs:           {{.HostConfig.Tmpfs}}
'

  section "$c — actual running user (id)"
  docker exec "$c" id 2>&1

  section "$c — effective Linux capabilities (main PID /proc/1/status)"
  docker exec "$c" sh -c 'grep -i ^Cap /proc/1/status' 2>&1
done

section "nginx — writable-path check (cache/run/log targets)"
docker exec telecloud-nginx sh -c '
echo "--- /var/cache/nginx ---"; ls -la /var/cache/nginx 2>&1
echo "--- /var/run ---"; ls -la /var/run 2>&1
echo "--- log symlink targets ---"; readlink -f /var/log/nginx/access.log /var/log/nginx/error.log 2>&1
echo "--- current mounts ---"; mount 2>&1 | grep -vE "^(proc|sysfs|tmpfs /dev|tmpfs /sys|cgroup|mqueue|devpts|shm)"
'

section "telecloud-app — writable-path check"
docker exec telecloud-app sh -c '
echo "--- /app (owner/perms) ---"; ls -la /app 2>&1
echo "--- /tmp contents ---"; ls -la /tmp 2>&1
echo "--- current mounts ---"; mount 2>&1 | grep -vE "^(proc|sysfs|tmpfs /dev|tmpfs /sys|cgroup|mqueue|devpts|shm)"
'

section "postgres — writable-path check"
docker exec telecloud-postgres sh -c '
echo "--- /var/run/postgresql ---"; ls -la /var/run/postgresql 2>&1
echo "--- /tmp contents ---"; ls -la /tmp 2>&1
echo "--- current mounts ---"; mount 2>&1 | grep -vE "^(proc|sysfs|tmpfs /dev|tmpfs /sys|cgroup|mqueue|devpts|shm)"
'

section "IMAGE REFERENCES (for Phase 14c later, captured now for continuity)"
docker inspect telecloud-nginx telecloud-app telecloud-postgres --format '{{.Name}}: {{.Config.Image}} ({{.Image}})'

section "AUDIT COMPLETE"
echo "Copy everything above (from COMPOSE.YML to here) back into the chat."
