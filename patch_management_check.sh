#!/usr/bin/env bash
# patch_management_check.sh — Phase 14e reusable patch-management check.
#
# NOT a one-off phase artifact -- run this on the defined cadence
# (docs/PATCH_MANAGEMENT_POLICY.md): monthly for the base-image/Trivy
# sections, quarterly for the dependency-audit sections, and always before
# any release that touches a Dockerfile/requirements.txt/package.json.
#
# Read-only: reports findings, makes no changes. Every base-image bump,
# dependency bump, or Docker Engine action this surfaces is a manual
# decision per the documented policy -- this script never applies anything
# itself, matching deploy.sh's "no unattended pipeline" principle.
set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

section "1. Ubuntu OS security updates (should be automatic -- confirming, not fixing)"
echo "--- pending upgrades ---"
apt list --upgradable 2>/dev/null | grep -v '^Listing'
echo "--- reboot required? ---"
[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo "(no reboot pending)"
echo "--- last unattended-upgrades run ---"
sudo tail -n 5 /var/log/unattended-upgrades/unattended-upgrades.log 2>&1

section "2. Docker Engine (added to unattended-upgrades Allowed-Origins, Phase 14e)"
apt-cache policy docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  | grep -E "^[a-z0-9.-]+:$|Installed:|Candidate:"

section "3. Pinned base image staleness (manual review required before any bump)"
for f in "$REPO_DIR/docker/backend/Dockerfile" "$REPO_DIR/docker/nginx/Dockerfile" "$REPO_DIR/compose.yml"; do
  grep -E "^\s*(FROM|image:)\s+\S+@sha256:[0-9a-f]+" "$f" 2>/dev/null | while read -r line; do
    ref=$(echo "$line" | grep -oE '[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]+')
    tag="${ref%%@*}"
    pinned_digest="${ref##*@}"
    live_digest=$(docker buildx imagetools inspect "$tag" 2>/dev/null | grep -m1 '^Digest:' | awk '{print $2}')
    echo "--- $tag ---"
    echo "  pinned: $pinned_digest"
    echo "  live:   ${live_digest:-<could not resolve>}"
    if [ -n "$live_digest" ] && [ "$pinned_digest" != "$live_digest" ]; then
      echo "  >>> STALE -- newer image available for this tag, review before bumping <<<"
    else
      echo "  up to date (or live digest unresolved -- check manually)"
    fi
  done
done

section "4. Trivy vulnerability scan (CRITICAL/HIGH) -- pinned + built images"
docker pull aquasec/trivy:latest >/dev/null 2>&1
for img in nginx:1.27-alpine postgres:18-alpine python:3.13-slim node:22-slim \
           telecloud-telecloud-app:latest telecloud-nginx:latest; do
  echo "--- $img ---"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image \
    --severity CRITICAL,HIGH --scanners vuln --quiet --format table "$img" 2>&1 | grep -E "^Total:|CRITICAL|not found"
done

section "5. Python dependency audit (requirements.txt)"
docker exec telecloud-app pip list --format=freeze 2>/dev/null | grep -v "^WARNING"
echo "--- pip-audit (run from host or a throwaway venv against requirements.txt) ---"
echo "Reminder: run 'python -m pip_audit -r requirements.txt' where pip-audit is available."

section "6. Frontend dependency audit"
if command -v npm >/dev/null 2>&1; then
  (cd "$REPO_DIR/frontend" && npm audit) 2>&1
else
  echo "(npm not available on this host -- run from the Windows dev host: cd frontend && npm audit)"
fi

section "CHECK COMPLETE"
echo "Review any STALE base images, Trivy CRITICAL/HIGH findings, or audit results above."
echo "Every action here is a manual decision per docs/PATCH_MANAGEMENT_POLICY.md -- nothing was changed."
