#!/usr/bin/env bash
# Phase 14a — Network & Firewall Hardening: read-only audit.
# Collects UFW config, Docker networking, and live iptables/nftables state
# so the Docker-vs-UFW bypass question can be answered from evidence, not assumption.
# Makes NO changes. Safe to run as-is; some sections need sudo for full detail.

set -uo pipefail

section() { printf '\n===== %s =====\n' "$1"; }

section "SYSTEM"
lsb_release -ds 2>/dev/null || cat /etc/os-release
uname -r

section "UFW STATUS (verbose)"
sudo ufw status verbose

section "UFW STATUS (numbered)"
sudo ufw status numbered

section "UFW APP LIST"
sudo ufw app list

section "/etc/default/ufw (look at DEFAULT_FORWARD_POLICY)"
grep -v '^\s*#' /etc/default/ufw | grep -v '^\s*$'

section "/etc/ufw/after.rules (Docker-related additions, if any)"
grep -n -i docker /etc/ufw/after.rules

section "/etc/ufw/before.rules (Docker-related additions, if any)"
grep -n -i docker /etc/ufw/before.rules

section "docker.service / DOCKER_OPTS iptables setting"
sudo cat /etc/docker/daemon.json 2>/dev/null || echo "(no /etc/docker/daemon.json)"

section "DOCKER COMPOSE PS"
cd /opt/telecloud/app && docker compose ps

section "DOCKER PS (with ports)"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

section "DOCKER PORT MAPPINGS (per container)"
for c in telecloud-nginx telecloud-app telecloud-postgres; do
  echo "--- $c ---"
  docker port "$c" 2>&1
done

section "DOCKER NETWORK LS"
docker network ls

section "DOCKER NETWORK INSPECT: bridge (default)"
docker network inspect bridge --format '{{json .IPAM.Config}}'

section "DOCKER NETWORK INSPECT: telecloud_edge"
docker network inspect telecloud_edge 2>&1

section "DOCKER NETWORK INSPECT: telecloud_data"
docker network inspect telecloud_data 2>&1

section "HOST LISTENING SOCKETS (ss -tlnp)"
sudo ss -tlnp

section "COMPOSE.YML AS DEPLOYED ON VM (ports: lines)"
grep -n -B2 'ports:' /opt/telecloud/app/compose.yml

section "IPTABLES BACKEND (legacy vs nf_tables)"
sudo iptables --version
readlink -f "$(command -v iptables)"

section "IPTABLES -S (filter table, full rule specs, ordering preserved)"
sudo iptables -S

section "IPTABLES -L -n -v --line-numbers (filter table, all chains)"
sudo iptables -L -n -v --line-numbers

section "IPTABLES NAT TABLE -S"
sudo iptables -t nat -S

section "IPTABLES NAT TABLE -L -n -v --line-numbers"
sudo iptables -t nat -L -n -v --line-numbers

section "DOCKER-USER CHAIN SPECIFICALLY"
sudo iptables -L DOCKER-USER -n -v --line-numbers 2>&1

section "NFT RULESET (if nftables backend/native rules in use)"
sudo nft list ruleset 2>&1

section "IP FORWARDING SYSCTL"
sysctl net.ipv4.ip_forward

section "AUDIT COMPLETE"
echo "Copy everything above (from SYSTEM to here) back into the chat."
