#!/usr/bin/env bash
# Phase 14d — SSH Hardening: read-only audit to determine whether this VM
# has any active SSH attack surface right now, or whether the phase should
# be documented as intentionally deferred until the home-server stage.
# Makes NO changes.
set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

section "openssh-server package installed?"
dpkg -l | grep -i openssh-server 2>&1 || echo "(not installed)"

section "sshd service status"
systemctl status ssh --no-pager 2>&1 || systemctl status sshd --no-pager 2>&1 || echo "(no ssh/sshd unit found)"

section "sshd enabled at boot?"
systemctl is-enabled ssh 2>&1 || systemctl is-enabled sshd 2>&1 || echo "(n/a)"

section "Anything listening on :22 (any process, not just sshd)?"
sudo ss -tlnp | grep ':22 ' || echo "(nothing listening on 22)"

section "UFW rules referencing port 22 or SSH"
sudo ufw status verbose | grep -i "22\|ssh" || echo "(no UFW rule for 22/ssh)"

section "Fail2Ban jails (sshd jail active? matters even if dormant)"
sudo fail2ban-client status 2>&1

section "sshd_config present at all?"
ls -la /etc/ssh/sshd_config 2>&1

section "AUDIT COMPLETE"
echo "Copy everything above back into the chat."
