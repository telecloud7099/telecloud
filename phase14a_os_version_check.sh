#!/usr/bin/env bash
# Phase 14a follow-up — read-only check to resolve the Ubuntu 24.04 (memory) vs
# 26.04 (live `lsb_release`) discrepancy found during the network/firewall audit.
# Makes NO changes.

set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

section "/etc/os-release (full)"
cat /etc/os-release

section "/etc/lsb-release"
cat /etc/lsb-release 2>&1

section "ACTIVE APT SUITE (sources.list + sources.list.d)"
grep -RhE '^\s*deb ' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null
grep -RhE '^\s*Suites:' /etc/apt/sources.list.d/*.sources 2>/dev/null

section "release-upgrades POLICY (Prompt= setting)"
cat /etc/update-manager/release-upgrades 2>&1

section "unattended-upgrades CONFIG (does it allow release upgrades?)"
grep -i -E "Allow-release-upgrades|Origins-Pattern|allowed-origins" /etc/apt/apt.conf.d/50unattended-upgrades 2>&1

section "dist-upgrade LOG DIRECTORY (created only by do-release-upgrade)"
ls -la /var/log/dist-upgrade/ 2>&1

section "APT HISTORY: any dist-upgrade / release-upgrader transaction"
zgrep -h -i -B2 -A6 "dist-upgrade\|release-upgrader\|do-release-upgrade" /var/log/apt/history.log* 2>/dev/null

section "INSTALLED KERNEL PACKAGES"
dpkg -l | grep -E '^ii\s+linux-image-[0-9]'

section "/proc/version"
cat /proc/version

section "BOOT HISTORY (journalctl --list-boots)"
journalctl --list-boots 2>&1

section "last -x (reboot/shutdown history from wtmp)"
last -x 2>&1 | head -40

section "CHECK COMPLETE"
echo "Copy everything above (from /etc/os-release to here) back into the chat."
