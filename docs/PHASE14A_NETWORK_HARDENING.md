# Phase 14a — Network & Firewall Hardening

Closed 2026-07-24. Repo at commit `3a5de89` (VM pulled clean before snapshotting).

## Objective

Resolve the Docker-vs-UFW iptables gotcha flagged (but deliberately deferred) back in
Phase 3: Docker manipulates iptables directly for published container ports and
typically inserts its own rules ahead of UFW's own filtering, meaning UFW's `allow`/
`deny` rules can silently fail to govern the traffic they appear to control. Not an
issue for this VM's NAT-only networking (VirtualBox only forwards two specific host
ports in), but a real problem once this stack moves to the home server's LAN, and
worse once it's ever internet-facing — `SECURITY_ARCHITECTURE.md`'s Internet Exposure
Checklist hard-gates on this being resolved first.

Methodology: evidence-first throughout, matching every prior phase — verified
observations, hypotheses, and assumptions were kept explicitly separate at every step,
nothing was fixed before it was proven broken, and the fix's own persistence was
verified empirically (`systemctl restart docker`, then a full reboot) rather than
trusted from documentation.

## Audit findings (verified, live evidence)

Full live audit captured via `phase14a_network_audit.sh` (read-only, no changes):

- **UFW**: active, `deny(incoming)/allow(outgoing)/deny(routed)`, `DEFAULT_FORWARD_POLICY="DROP"`. Only two allow rules: `80/tcp` and `8000/tcp` (both IPv4+IPv6). The `8000/tcp` rule was found to be **stale** — dead since the Phase 4 architecture change moved `telecloud-app` off a published port (confirmed via `ss -tlnp`: nothing listens on the guest's own 8000).
- **Docker networking**: only `nginx` publishes a host port (`80:80`, from `compose.yml`). `telecloud-app` (8000) and `postgres` (5432) are exposed internally only, never published — confirmed via `docker port` returning nothing for both and no corresponding DNAT rule existing in the `nat` table's `DOCKER` chain.
- **iptables/nftables** (Ubuntu's `iptables-nft` backend): `FORWARD` chain order is `DOCKER-USER` → `DOCKER-FORWARD` → `ufw-before-forward` (rule-numbered `-L` output, not just `-S` ordering). `DOCKER-USER` was empty (0 rules, never customized). The `DOCKER` chain contained an unconditional `ACCEPT` for port 80 with no source-IP restriction, and `-j ACCEPT` is a terminating target — meaning traffic to the published port never reaches UFW's forward-chain logic at all.

## OS version discrepancy (resolved, unrelated to this project)

The audit also surfaced that the VM reports Ubuntu 26.04 LTS ("Resolute Raccoon"),
not 24.04 as originally documented. `apt` history proved a genuine `do-release-upgrade`
transaction ran 2026-04-23 — three months before this project's Phase 0 baseline
(2026-07-18). The upgrade predates and is unrelated to any TeleCloud work; documentation
has been corrected (see the `project-vbox-deployment-plan` memory record).

## Why the bypass exists (mechanism)

A Docker-published port's traffic is DNAT'd in `PREROUTING`, then **forwarded**, not
delivered to the host — so it never touches UFW's `INPUT` chain, where `ufw allow
80/tcp` actually lives. The real gate is the `FORWARD` chain, and there `DOCKER-USER`/
`DOCKER-FORWARD` run *before* any `ufw-*` chain and terminate with an unconditional
`ACCEPT` for anyone reaching the published port. Deleting the UFW `80/tcp` rule
therefore has **no effect** on real reachability — proven empirically, not just
inferred from rule inspection (see below).

## Empirical verification

**First attempt was invalid** (documented here deliberately, as a process lesson):
`curl http://127.0.0.1:8080` was run from *inside* the guest. That port only exists on
the Windows host side of the VirtualBox NAT forward; nothing listens on the guest's own
8080. A second, more subtle problem: even testing the guest's own `127.0.0.1:80` would
have been invalid too — Docker explicitly excludes `127.0.0.0/8` from its DNAT jump
(`-A OUTPUT ! -d 127.0.0.0/8 ... -j DOCKER`) in favor of a separate `docker-proxy`
loopback listener, and UFW's very first rule unconditionally accepts all loopback
traffic (`-i lo -j ACCEPT`) — neither exercises the actual bypass mechanism.

**Corrected test**: `sudo ufw delete allow 80/tcp` on the guest, immediately followed by
`curl http://127.0.0.1:8080` from the **Windows host** (the real NAT path) —

```
HTTP 200
```

nginx remained fully reachable with the "protecting" UFW rule removed. Rule was
restored and verified (`sudo ufw status verbose`) immediately after. This is direct,
first-hand proof of the bypass, not an inference from rule inspection.

## Policy (agreed before implementation)

| Stage | Port(s) | From |
|---|---|---|
| VM / NAT (current) | 80/tcp only | Unscoped — VirtualBox NAT already bounds real exposure to whatever the host forwards in; the point of this stage is the correct *shape* of the control (explicit default-deny-then-allow), not source narrowing yet |
| Home server / LAN | 80/tcp (+443 once Phase 7's TLS work lands) | Home LAN CIDR only, never the raw internet (no router port-forward) |
| Home server + Cloudflare Tunnel | 80/tcp internal | `cloudflared`'s own address only — LAN-wide reachability may be removed entirely at that point |

`telecloud-app` and `postgres` stay unpublished at every stage — no policy needed since
nothing lists them, and this remains true regardless of firewall config.

## Implementation approach

Considered and rejected `ufw-docker` (well-known third-party script) per explicit
preference to minimize external dependencies and keep every security control fully
understood — the same behavior is achievable natively.

Two native options were weighed:
- A hand-written stanza in `/etc/ufw/after.rules`, hooking into UFW's own boot-time
  rule load. Rejected: real boot-ordering risk if `ufw.service` loads before
  `docker.service` has created the `DOCKER-USER` chain — `-A DOCKER-USER ...` would
  fail against a chain that doesn't exist yet.
- **A dedicated systemd oneshot unit** (chosen): sidesteps the ordering question
  entirely rather than needing to prove it's safe.

Persistence was verified empirically rather than trusted from Docker's documentation:
a marker rule was added to `DOCKER-USER`, `systemctl restart docker` was run, and the
marker survived unchanged — confirming Docker does not flush the chain on daemon
restart, and a **boot-only** trigger (no `docker.service.d` restart hook) is sufficient.

## Two implementation bugs found via empirical testing, not review

1. **`DOCKER-USER` sees all forwarded traffic, not just external ingress.** The first
   version of the rule set only allowed established/related connections and new
   connections to port 80 — it did not account for `br_netfilter` routing
   *inter-container* traffic (nginx→telecloud-app, telecloud-app→postgres, and
   telecloud-app's own egress to Neon) through the exact same chain. This broke the app
   outright (`HTTP 502`, and separately a Neon connection timeout on a post-reboot
   startup race). Fixed by adding an early `RETURN` for any traffic already arriving on
   a Docker bridge interface (`-i br-+` wildcard — survives `docker compose down`/`up`
   regenerating bridge names, rather than hardcoding today's specific IDs), before the
   restrictive external-ingress policy applies.
2. **`systemctl enable --now` is a no-op start on an already-active oneshot unit.**
   After fixing bug 1 and redeploying, the chain still showed the old 3-rule set —
   `start` doesn't re-run `ExecStart` if the unit is already `active (exited)`, even
   though the underlying script changed. Fixed the install script to use `systemctl
   restart`, which always re-executes regardless of current state.

## Final DOCKER-USER rule set

```
1  RETURN  ctstate RELATED,ESTABLISHED
2  RETURN  -i br-+                        # any compose-managed bridge (container-originated traffic)
3  RETURN  -i docker0                     # legacy default bridge, same reasoning
4  RETURN  tcp dpt:80                     # nginx, unscoped source at this stage
5  DROP                                   # default-deny catch-all
```

Source: `docker/network/docker-user-rules.sh`. Fully idempotent (flushes and rebuilds
the chain every run) — nothing else on this box should ever add rules to `DOCKER-USER`.

## Installation

```bash
cd /opt/telecloud/app && git pull
chmod +x docker/network/*.sh
sudo ./docker/network/install_docker_user_rules.sh
```

Installs `telecloud-docker-user-rules.service` (boot-time oneshot, `After=`/
`Requires=docker.service`, `WantedBy=multi-user.target`) and runs it immediately.
Re-running after editing `docker-user-rules.sh` is safe and required to pick up
changes (the script now uses `restart`, not `enable --now`).

## Rollback

```bash
sudo systemctl disable --now telecloud-docker-user-rules.service
sudo iptables -F DOCKER-USER   # chain returns to Docker's own empty default
sudo rm /etc/systemd/system/telecloud-docker-user-rules.service
sudo systemctl daemon-reload
```

Returns to the audited-but-unmitigated state (the original bypass, not a broken state).
Verified empirically mid-phase when the rollback sequence was run accidentally after a
successful install — it reverted cleanly with no errors.

## Verification performed

- **Regression**: `curl http://127.0.0.1:8080` from the Windows host → `HTTP 200`,
  matching pre-change behavior, after the corrected rule set was deployed.
- **`docker restart` persistence**: marker rule survived `systemctl restart docker`
  unchanged (see above).
- **Full reboot persistence**: `sudo reboot`, then confirmed the oneshot unit ran fresh
  (new invocation ID, new PID) and repopulated all rules correctly from cold.
- **End-to-end functional**: `docker compose ps` showed all three containers healthy
  and `curl http://127.0.0.1:8080` returned `HTTP 200` after both bugs were fixed.

## Security posture after Phase 14a

- The Docker-vs-UFW bypass is closed for this VM's current NAT-only stage: reachability
  of the published port is now governed by an explicit, version-controlled
  `DOCKER-USER` policy, not by an accident of VirtualBox's networking mode.
- **Residual/deferred, by design**: the port-80 rule is still source-unscoped — this is
  correct for the current NAT stage but is explicitly *not* the end state. Source
  scoping to the home LAN CIDR, and later to `cloudflared` alone, is tracked as
  required follow-up work before this configuration is ever LAN- or internet-facing,
  per `SECURITY_ARCHITECTURE.md`'s Internet Exposure Checklist.
- IPv6 was not given equivalent `DOCKER-USER` rules — not currently needed, since
  `telecloud_edge`/`telecloud_data` both have IPv6 disabled and no `ip6 nat` DNAT rule
  exists (confirmed in the original audit), so there is no IPv6 published-port path to
  protect yet. Revisit if IPv6 is ever enabled on the Docker networks.
- The stale UFW `8000/tcp` rule was identified but **not yet removed** — left for a
  future cleanup pass since it protects nothing either way (nothing listens there) and
  removing it wasn't part of this phase's core objective.
