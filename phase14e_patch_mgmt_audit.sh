#!/usr/bin/env bash
# Phase 14e — Automatic Updates & Patch Management: read-only audit.
# Covers current unattended-upgrades config/scheduling, whether Docker's own
# apt repo is actually covered by it, and Docker image update practices.
# Makes NO changes.
set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

section "/etc/apt/apt.conf.d/20auto-upgrades (enable flags)"
cat /etc/apt/apt.conf.d/20auto-upgrades 2>&1

section "/etc/apt/apt.conf.d/50unattended-upgrades (full, minus comments)"
grep -v '^\s*//' /etc/apt/apt.conf.d/50unattended-upgrades | grep -v '^\s*$'

section "Configured apt sources (to cross-check against Allowed-Origins above)"
grep -RhE '^\s*deb ' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null
grep -RhE '^\s*(URIs|Suites):' /etc/apt/sources.list.d/*.sources 2>/dev/null

section "unattended-upgrades / apt-daily timers: enabled + last/next run"
systemctl list-timers --all | grep -i "apt\|unattended" 2>&1
echo "--- apt-daily-upgrade.service last run ---"
systemctl status apt-daily-upgrade.timer --no-pager 2>&1

section "Most recent unattended-upgrades log activity"
sudo tail -n 40 /var/log/unattended-upgrades/unattended-upgrades.log 2>&1

section "Docker Engine version + install source"
docker version --format 'Client: {{.Client.Version}}, Server: {{.Server.Version}}' 2>&1
apt-cache policy docker-ce 2>&1 | head -5

section "Any existing cron/systemd timer for docker pull / image refresh / rebuild?"
crontab -l 2>&1
sudo crontab -l 2>&1
systemctl list-timers --all 2>&1 | grep -vi "apt\|unattended\|logrotate\|fstrim\|man-db\|motd\|snap\|ua-timer\|update-notifier\|systemd-tmpfiles"

section "Current image ages (how stale are the pinned digests already?)"
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}'

section "AUDIT COMPLETE"
echo "Copy everything above back into the chat."
