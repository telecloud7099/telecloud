#!/usr/bin/env bash
# Populates the DOCKER-USER iptables chain with TeleCloud's explicit ingress
# policy for Docker-published ports.
#
# WHY THIS EXISTS: Docker inserts its own ACCEPT rules for published ports
# directly into the FORWARD chain (via DOCKER-FORWARD/DOCKER-BRIDGE/DOCKER),
# ahead of UFW's own forward-chain rules. Traffic to a published port is
# DNAT'd in PREROUTING and then routed/forwarded -- it never reaches the
# host's INPUT chain, so UFW's `ufw allow <port>` rules never apply to it.
# DOCKER-USER is the one chain Docker guarantees to evaluate first and never
# overwrite -- it's the only place a UFW-independent access policy can
# actually govern Docker-published ports. Verified empirically against this
# VM's live iptables/nftables state on 2026-07-24 (removing the UFW 80/tcp
# INPUT rule did not affect nginx's reachability at all).
#
# This chain is fully OWNED by this script -- nothing else on this box
# should ever add rules to DOCKER-USER. Flush-and-rebuild each run, so it's
# safe to re-run idempotently (used as a systemd ExecStart).
set -euo pipefail

CHAIN="DOCKER-USER"
TAG="telecloud"

iptables -F "$CHAIN"

# Let established/related connections continue without re-matching every
# packet against the port rule below (standard DOCKER-USER pattern).
iptables -A "$CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "$TAG" -j RETURN

# Traffic that already originated from a container -- inter-container
# traffic (nginx->telecloud-app, telecloud-app->postgres) and container
# egress to the internet -- arrives on a Docker bridge interface, never on
# the host's real external NIC, so it can never be genuinely-external
# ingress. Return early so it falls through to Docker's own
# DOCKER-FORWARD/DOCKER-BRIDGE rules, which already handle it correctly.
# Without this, the port-80-only policy below also caught inter-container
# traffic and broke the app (nginx -> telecloud-app 502, found empirically
# 2026-07-24 right after the first real deployment -- this chain sees ALL
# forwarded traffic, not just external ingress, because br_netfilter is
# active). `br-+` wildcards any compose-managed bridge by prefix rather
# than hardcoding today's specific per-network IDs, so this survives
# `docker compose down`/`up` regenerating the networks later.
iptables -A "$CHAIN" -i "br-+" -m comment --comment "$TAG" -j RETURN
iptables -A "$CHAIN" -i docker0 -m comment --comment "$TAG" -j RETURN

# --- nginx (80/tcp), the only Docker-published port in compose.yml ---
# Stage: VM / NAT-only dev (current). Source deliberately left unscoped --
# VirtualBox NAT already bounds real-world reachability to whatever the
# Windows host forwards in (currently just 8080->80), so this rule's job
# right now is purely to make the *shape* of the control correct (explicit
# default-deny-then-allow) rather than to narrow by source.
#
# NEXT STAGE (home server / LAN): add `-s <home-LAN-CIDR>` to this rule so
# only the LAN can reach nginx, never the raw internet (no router
# port-forward -- see SECURITY_ARCHITECTURE.md's Internet Exposure
# Checklist).
#
# STAGE AFTER THAT (Cloudflare Tunnel): narrow further to cloudflared's own
# address/network once the tunnel becomes the sole intended ingress path --
# at that point general LAN reachability of this port may not be needed at
# all. Revisit this rule explicitly at that stage rather than assuming it
# still applies.
iptables -A "$CHAIN" -p tcp --dport 80 -m comment --comment "$TAG" -j RETURN

# Default-deny: anything else reaching a Docker-published port is dropped
# here, before Docker's own permissive rules ever see it.
iptables -A "$CHAIN" -m comment --comment "$TAG" -j DROP
