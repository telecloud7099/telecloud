#!/usr/bin/env bash
# install_docker_user_rules.sh — Phase 14a one-time host setup.
#
# Installs the DOCKER-USER iptables policy as a boot-time systemd oneshot
# unit (see docker-user-rules.sh and telecloud-docker-user-rules.service
# for the rules themselves and why this exists). This is host-level setup,
# run manually once per host -- not part of deploy.sh's app-level
# git-pull/rebuild cycle, the same way Phase 2/3's package installs were
# manual one-time steps.
#
# Idempotent: safe to re-run (e.g. after editing docker-user-rules.sh).
set -euo pipefail

REPO_DIR="/opt/telecloud/app"
UNIT_NAME="telecloud-docker-user-rules.service"

sudo chmod 755 "$REPO_DIR/docker/network/docker-user-rules.sh"
sudo cp "$REPO_DIR/docker/network/$UNIT_NAME" "/etc/systemd/system/$UNIT_NAME"

sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME"
# `restart`, not `enable --now` / `start`: for an already-active oneshot
# unit, `start` is a no-op and won't re-run ExecStart even if
# docker-user-rules.sh changed underneath it -- found the hard way on
# 2026-07-24 when a script fix silently failed to apply because the unit
# was already "active (exited)" from the prior install. `restart` always
# re-executes ExecStart regardless of current state.
sudo systemctl restart "$UNIT_NAME"

echo "--- unit status ---"
sudo systemctl status "$UNIT_NAME" --no-pager
echo "--- DOCKER-USER chain contents ---"
sudo iptables -L DOCKER-USER -n -v --line-numbers
