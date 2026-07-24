# Phase 14d — SSH Hardening

Audited 2026-07-24. Repo at commit `9ec3746`. **Status: not currently applicable —
verified, not assumed.** No implementation performed; this phase is intentionally
deferred until the home-server stage introduces an actual SSH workflow.

## Objective

Determine, with evidence rather than assumption, whether this VM has any active SSH
attack surface right now — and if not, formally document that rather than silently
skipping a planned phase.

## Audit findings (verified, live evidence)

Two independent layers, both confirming zero SSH exposure:

**Guest side** (`phase14d_ssh_audit.sh`, read-only):
- `openssh-server` is not installed (`dpkg -l` shows nothing).
- No `ssh.service`/`sshd.service` systemd unit exists at all.
- Nothing listens on `:22`.
- No UFW rule references port 22 or SSH — moot regardless, since there's nothing to
  protect, but confirms no stale rule either.
- `/etc/ssh/sshd_config` doesn't exist — confirms the package truly isn't installed,
  not just stopped.

**Host side** (`VBoxManage showvminfo ubuntu --machinereadable`):
- Only two NAT port-forward rules exist on this VM: `backend-dev` (host `8001` →
  guest `8000`) and `http` (host `8080` → guest `80`). No rule targets guest port 22.
  Under VirtualBox NAT, a guest port is unreachable from outside without an explicit
  forward rule — so even if SSH were somehow running, it would still be unreachable
  from the host or beyond.

**One minor, non-security-relevant note**: Fail2Ban has an `sshd` jail configured and
listed as active (`fail2ban-client status` shows 1 jail: `sshd`), but since no `sshd`
log exists to monitor, the jail is inert — dormant, not a risk, just worth naming for
completeness rather than acting on.

## Conclusion

This is a **verified-inapplicable** status, not a skipped phase. Matches what was
anticipated when Phase 14 was originally split (2026-07-22): 14d was flagged then as
"currently dormant since VM has no SSH workflow" — now confirmed with live evidence
rather than carried forward as an assumption.

## Revisit trigger

Re-run this audit (or a successor) when either of these becomes true:
- The VM (or its home-server successor) gains an actual SSH-based workflow (e.g. remote
  administration replacing the current copy-paste-relayed-command process).
- The stack moves to the home server, where SSH is likely to become the actual
  management channel — at that point, implement key-only auth, disable password auth,
  and activate the (already-configured but currently inert) Fail2Ban `sshd` jail for
  real.

No snapshot taken for this phase — no runtime state changed, only the audit script was
added to the repo. The `phase14c-complete` snapshot remains the most recent state
checkpoint.
