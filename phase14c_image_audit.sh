#!/usr/bin/env bash
# Phase 14c — Docker Image Hardening & Pinning: read-only audit.
# Captures exact installed Python dependency versions (to pin requirements.txt
# to what's actually tested/running, not a fresh untested pull) and runs
# Trivy vulnerability scans against all images in the stack. Trivy runs as a
# one-off container (nothing installed permanently) using the VM's native
# Docker socket -- avoids the Docker-Desktop-Windows npipe friction hit when
# trying this from the host. Makes NO changes.
set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

section "telecloud-app — exact installed dependency versions (pip freeze)"
docker exec telecloud-app pip freeze 2>&1

section "PULLING TRIVY (one-off, not installed permanently)"
docker pull aquasec/trivy:latest 2>&1 | tail -5

for img in nginx:1.27-alpine postgres:18-alpine python:3.13-slim node:22-slim telecloud-telecloud-app:latest telecloud-nginx:latest; do
  section "TRIVY SCAN: $img (CRITICAL/HIGH only)"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest image \
    --severity CRITICAL,HIGH --scanners vuln --quiet "$img" 2>&1
done

section "AUDIT COMPLETE"
echo "Copy everything above back into the chat."
