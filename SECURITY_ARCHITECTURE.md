# Security Architecture — TeleCloud

> The long-term governing security document for TeleCloud. Every future implementation
> decision — app code, Docker/Compose config, VM/home-server ops — should be evaluated
> against this document before being built, not after. For specific known application
> bugs and their fix status, see `SECURITY_NOTES.md`. For the phased deployment plan
> this document's checklists gate, see the VBox/home-server migration plan (tracked in
> project memory, not in this repo).

---

## 1. Threat Model

### Who we are designing against

- **Opportunistic internet scanners/bots** — mass scanning for open ports, default
  credentials, known CVEs in exposed services. The single most likely category of
  attacker once anything is internet-reachable, regardless of how "uninteresting" the
  target is.
- **Credential-stuffing / brute-force bots** against the login/OTP flow.
- **Someone else on the same home LAN** — a compromised IoT device, a guest-network
  misconfiguration, or (if the VM/server is ever switched from NAT-only to Bridged
  networking) another device on the same network segment.
- **Supply-chain drift** — a Docker base image or a Python/Node dependency picking up a
  known CVE between when it was built and when it's next rebuilt.
- **A holder of a shared link**, if file/folder sharing is ever added as a feature —
  treated as a semi-trusted party who should only ever get access to exactly what was
  shared, nothing else.

### Explicitly out of scope

Naming these isn't fatalism — it's honesty about where effort is well spent for a
personal project, versus where it would be security theater:

- **Nation-state / advanced persistent threats** with targeted, sustained resources.
  Disproportionate to a personal home file store; defending against this class would
  cost far more than the asset being protected is worth.
- **Compromise of Telegram's own infrastructure.** Telegram is the storage backend —
  its infrastructure security is Telegram's responsibility, not ours. We control what
  we send it and how we encrypt before sending, not how Telegram operates its servers.
- **Compromise of Neon's or Cloudflare's infrastructure.** Both are accepted trust
  boundaries (see §5, Design Principles — "explicit trust boundaries"). We choose them
  deliberately and design around their documented guarantees, not around defending
  against their own infrastructure failing.
- **DDoS beyond what Cloudflare's tunnel/edge absorbs for free.** Not a realistic
  threat to specifically defend against for a personal project; Cloudflare Tunnel
  already provides meaningfully more DDoS resilience than a bare home IP would have.
- **Zero-days in the Linux kernel, Docker Engine, or upstream base images at the
  source.** Mitigated by patching promptly once known (§ Design Principles, §4
  Patch Management) — not something a personal deployment can defend against while
  still unknown.
- **Physical theft or coercion of the operator.** Out of scope for the same reason as
  APTs above.
- **Malicious insiders**, until/unless TeleCloud ever supports multiple independent
  user accounts with real trust boundaries between them. Currently single-operator.

---

## 2. Severity Classification

Every security finding — existing or future — gets one of these four labels. The
label determines urgency, not the order findings happen to be discovered in.

| Severity | Definition | When it must be fixed |
|---|---|---|
| **Critical** | Remote, unauthenticated compromise; full account takeover; breach of all stored data; authentication bypass. | Immediately. Blocks any deployment or continued internet exposure until resolved. Treat as a stop-the-line incident, not a backlog item. |
| **High** | Authenticated compromise; privilege escalation; significant exposure of one account's data; a DoS with real, not theoretical, impact. | Before the next production-facing milestone — explicitly, before the **Internet Exposure Checklist (§4)** can be signed off. |
| **Medium** | Exploitable only under unusual conditions or with local/LAN access; limited-scope information disclosure; a hardening gap that raises attacker cost but isn't directly exploitable today. | Within the current development phase; tracked with an explicit target phase, not left indefinitely open. |
| **Low** | Theoretical or defense-in-depth gaps; best-practice deviations with minimal real-world exploitability given the current threat model. | Fixed opportunistically; tracked, but never blocks a milestone by itself. |

**Existing `SECURITY_NOTES.md` issues, reclassified under this scale:**

| Issue | Old label | New severity | Why |
|---|---|---|---|
| #1 Stored XSS (`innerHTML`) | "Fix before going public" | **High** | Requires a crafted filename to already exist somewhere the victim's own account can see (e.g. their own Telegram Saved Messages) — not remotely, unauthenticated exploitable against an arbitrary target, but a real account/token-theft path once reachable by anyone other than the operator. |
| #2 Content-Disposition filename | "Low" | **Low** | CRLF injection already blocked by the framework; residual risk is cosmetic. |
| #3 Plaintext fallback for encrypted credentials | "Low" | **Medium** | Requires filesystem access to exploit today, but silently degrades a real security control (encryption at rest) without alerting anyone — the silence is what pushes this above a pure Low. |
| #4 `phone_code_hash` not scoped to session | "Low" | **Low** | Still requires the OTP itself from another source to exploit. |

---

## 3. Security Design Principles

These principles govern every future implementation decision, not just the items
explicitly listed elsewhere in this document.

- **Defense in depth.** No single control is trusted as the only barrier. Nginx
  headers, app-level validation, container isolation, and network segmentation each
  assume the others might fail.
- **Least privilege.** Every component — container, database user, API scope, secret
  — gets the minimum access it needs to do its job, nothing more. (Already the basis
  for the Phase 6 `.env.app`/`.env.db` split.)
- **Secure by default.** The default configuration is the hardened one; insecure
  options (if they must exist at all, e.g. local dev conveniences) require deliberate
  opt-in, never deliberate opt-out.
- **Fail securely (fail closed).** When a security check errors or a dependency is
  unavailable, the system denies access/fails the operation rather than falling back
  to an open/permissive state. (This is precisely what `SECURITY_NOTES.md` issue #3's
  fix requires — fail hard on decryption failure instead of silently degrading to
  plaintext.)
- **Zero trust between components.** A container on the internal `data` network is not
  trusted merely because of its network position — secrets, auth, and validation still
  apply between telecloud-app and postgres, not just at the edge.
- **Minimize attack surface.** Don't run it, expose it, or install it if it isn't
  needed. Prefer no published port over a firewalled one; prefer a minimal base image
  over a full one; prefer deleting dead code over leaving it reachable.
- **Explicit trust boundaries.** Telegram, Neon, and Cloudflare are named, deliberate
  trust boundaries (see Threat Model §1) — the design accounts for what's on each side
  of that line rather than pretending the boundary doesn't exist.
- **No home-rolled cryptography.** Fernet (via `cryptography`), JWT (via `pyjwt`), and
  TLS (via Let's Encrypt/Cloudflare) are used as-is, through maintained libraries —
  never a custom scheme.
- **Secrets never appear in code, logs, or chat/tool transcripts.** Already a hard
  lesson from the Phase 4 Neon-password-in-transcript incident — extended here as a
  standing principle, not a one-time fix.
- **Assume breach; design for detection, not just prevention.** Monitoring and logging
  exist so that a failure of prevention is at least noticed, not just prevented badly.

---

## 4. Internet Exposure Checklist (mandatory gate)

**TeleCloud may not be made reachable from the public internet — by Cloudflare Tunnel,
port-forward, or any other means — until every item below is checked off.** This is a
hard gate, not a best-effort list. If a future change reopens any item (e.g., a new
dependency, a config regression), exposure must be reconsidered until it's re-closed.

- [ ] All **Critical** and **High** severity findings resolved, including
      `SECURITY_NOTES.md` issue #1 (stored XSS).
- [ ] TLS active end-to-end — Cloudflare Tunnel (edge-terminated) or Let's Encrypt; no
      path serves plaintext HTTP to the public internet.
- [ ] SSH (if enabled at all on the host) is key-only — password authentication
      disabled, Fail2Ban active on the SSH jail.
- [ ] UFW default-deny on inbound, only explicitly required ports allowed; the
      Docker-vs-UFW iptables interaction (flagged Phase 3) resolved so a
      Docker-published port can't bypass UFW rules.
- [ ] No port is directly forwarded on the home router — Cloudflare Tunnel (or
      equivalent outbound-only method) is the sole path in.
- [ ] Login/OTP attempts are rate-limited at the app and/or proxy layer.
- [ ] Nginx rate limiting, security headers, and per-route body-size/timeout limits
      are active (headers and size limits already are — confirm rate limiting is too).
- [ ] Backups are encrypted, stored offsite, and a **restore** (not just a backup) has
      been actually tested and confirmed to work.
- [ ] No secret exists in git history, image layers, or a chat/tool transcript; all
      `.env*` files are `chmod 600` on the host.
- [ ] Container hardening applied: non-root confirmed for every service, capabilities
      dropped, no privileged containers, `no-new-privileges` set.
- [ ] Docker images are digest-pinned and have been scanned, with no outstanding
      Critical/High CVEs.
- [ ] Automatic security updates are configured on the host OS.
- [ ] Monitoring/alerting is active for suspicious login attempts and resource
      anomalies.
- [ ] The full functional test matrix passes against the exact configuration being
      exposed (not an earlier, different config).
- [ ] A complete, dedicated security audit has been performed against this entire
      document immediately before go-live — re-verifying every item above against the
      *actual current state* of the deployment (not the state recalled from an earlier
      phase's validation), and confirming no outstanding Critical or High severity
      finding remains anywhere in `SECURITY_NOTES.md` or the §8 Technical Debt Log.
      Exposure must not be recommended until this audit is complete and every item is
      genuinely satisfied — checking boxes from memory does not count as verification.

**Sign-off log:**

| Date | Signed off by | Notes |
|---|---|---|
| _(none yet)_ | | |

---

## 5. Security Domains

Each domain below states why it matters, what it mitigates, its implementation
complexity, its trade-offs, and whether it belongs on the current VirtualBox dev
environment or should wait for the production home server. Severity refers to the
scale in §2 — the severity of *not having this control*, given the threat model in §1.

### Infrastructure / Deployment (governs the VM/home-server phase plan)

1. **Network segmentation & firewall (UFW / Docker networking)** — Severity if
   missing: **High** once internet-exposed, **Low** on an isolated dev VM. Why: limits
   lateral movement if one service is compromised. Complexity: low — `edge`/`data`
   bridge split already exists. Trade-off: none meaningful. Timing: VM now; the
   Docker-vs-UFW interaction must be solved before real network exposure.

2. **Reverse proxy hardening (headers, rate limiting, size limits, timeouts)** —
   Severity: **Medium** (brute-force/abuse enablement). Complexity: low-medium; CSP
   deliberately deferred pending real tuning, not skipped. Trade-off: rate limiting
   can false-positive shared/NAT'd IPs. Timing: VM now, independent of TLS.

3. **TLS via Let's Encrypt** — Severity: **High** once internet-exposed (plaintext
   credentials/JWT/file contents on the wire), **N/A** on NAT-only dev VM. Complexity:
   medium. Trade-off: needs a real domain + reachable port for ACME, or a DNS
   challenge. Timing: home-server stage only.

4. **Cloudflare Tunnel (or equivalent)** — Severity: **High** (eliminates open-port
   exposure entirely). Complexity: low. Trade-off: third-party availability
   dependency; traffic decrypted at Cloudflare's edge (accepted trust boundary).
   Timing: home-server stage — the intended answer to public reachability.

5. **SSH hardening** — Severity: **Critical** if SSH is ever exposed with password
   auth; **N/A** currently (VM has no SSH workflow by deliberate choice). Complexity:
   low. Trade-off: lose password-fallback login — plan a second key location. Timing:
   dormant now; mandatory before SSH is ever exposed on the home server.

6. **Container security (least privilege, non-root, read-only fs, dropped caps, no
   privileged containers)** — Severity: **Medium-High** (limits blast radius of a
   container compromise). Complexity: low-medium, needs per-service shakeout
   (read-only + `tmpfs` for the few writable paths each container needs). Trade-off:
   upfront breakage-and-fix cycles, especially for postgres. Timing: VM now — the
   right place to shake this out before it matters for real.

7. **Docker image security (minimal base, scanning, pinning)** — Severity: **Medium**
   (supply-chain drift). Complexity: low for pinning, medium for scanning (no CI yet,
   starts manual). Trade-off: pinned digests need a deliberate bump process — pair
   with patch management, don't let pinning become "never updates." Timing: pinning
   now (no downside); scanning formalized before home-server go-live.

8. **Automatic security updates / patch management** — Severity: **High** long-term
   (most real compromises exploit already-patched CVEs). Complexity: low for host OS
   (`unattended-upgrades`), medium for containers (needs the Phase 8 rebuild pipeline
   to mean anything). Trade-off: unattended restarts at a bad moment — mitigate with a
   maintenance window. Timing: host-level VM now; container pipeline as part of the
   deployment-workflow phase.

9. **Backup & DR with encrypted offsite backups + restore testing** — Severity:
   **Critical** for data durability (though not a breach-type risk). Complexity:
   medium. Trade-off: the backup-encryption key is itself a secret needing separate,
   safe storage. Timing: must be solid *before* any database migration away from
   Neon's managed backups reopens.

10. **Monitoring & intrusion detection** — Severity: **Medium** (detection, not
    prevention — but "assume breach" makes this load-bearing). Complexity: low for
    basics, medium for real IDS-style alerting. Trade-off: overhead on the weak i3-2120
    target — keep it lightweight. Timing: basics on the VM now; suspicious-login
    alerting is a good early target since `backend/security.py` already logs the data.

11. **PostgreSQL hardening** — Severity: **N/A while on Neon** (Neon already handles
    this). Timing: only relevant if the deferred Neon→local-Postgres migration is ever
    revisited — `scram-sha-256`, no superuser app connections, `pg_hba.conf` scoped to
    the `data` network, encrypted bind-mounted data directory.

### Application-level (governs `SECURITY_NOTES.md`, independent of hosting)

12. **Auth hardening (JWT handling, session security, CSRF, login rate limiting)** —
    Severity: **High** (JWT theft via XSS is the live path today). Complexity: varies;
    login rate limiting is incremental given `backend/security.py` already tracks
    request origin. Trade-off: aggressive OTP rate limiting can lock out a legitimate
    user who mistypes a code. Timing: application work, independent of VM/home-server
    phases — do regardless of hosting.

13. **Secure file upload validation (type/size, malware scanning, path traversal)** —
    Severity: **Medium** for path traversal, **Low** for malware scanning given the
    single-operator threat model (re-evaluate to Medium/High if link-sharing with
    others is ever added). Complexity: low for path-traversal canonicalization, high
    (and lower-value here) for real AV scanning. Timing: path-traversal check is cheap
    and worth doing regardless; defer malware scanning unless the threat model changes.

14. **Encryption for data at rest (application data)** — Status: **done**. StringSession
    and API credentials are Fernet-encrypted already. Remaining item is disk-level
    encryption, which only matters if/when Postgres is self-hosted (see #11).

### Process (ongoing discipline, not a one-time phase)

15. **Secret management & rotation** — Status: **done** (Phase 6 least-privilege
    split + rotation runbook in `SECURITY_NOTES.md` §5). Ongoing obligation: actually
    rotate on the documented triggers, not just have the runbook exist.

16. **Regular security review before each major phase** — Standing practice, not a
    phase. Before any future phase's implementation, explicitly state which domains
    above it touches and whether it improves, is neutral toward, or (if unavoidable)
    worsens that domain's posture — the same way the Phase 5 backup-sequencing risk
    was flagged unprompted before it became a problem.

---

## 6. Relationship to the Phase Plan

Security work is split across two tracks:

- **Infrastructure phases** (domains 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 above) live in
  the VM/home-server migration phase plan (tracked in project memory). The former
  single "Phase 14 — Security pass" is split into independently validated and
  snapshotted sub-phases: **14a Network/Firewall Hardening, 14b Container Hardening,
  14c Docker Image Hardening + Pinning, 14d SSH Hardening, 14e Automatic Updates /
  Patch Management** — each gets its own validation and VM snapshot rather than one
  bundled milestone.
- **Application-level work** (domains 12, 13, 14) lives in `SECURITY_NOTES.md` as
  numbered issues, tracked and fixed independent of which server hosts the app.

**One hard sequencing rule:** `SECURITY_NOTES.md` issue #1 (stored XSS, reclassified
**High** in §2) must be resolved before Phase 7's Cloudflare Tunnel work ever makes
TeleCloud reachable from the public internet — enforced by the Internet Exposure
Checklist in §4, not left as an informal reminder.

---

## 7. Change Process: Security Review & Validation Summary

**No implementation is merged solely because it works.** Every future phase or pull
request brackets its implementation with two short write-ups — not a full audit each
time, just enough to keep security a first-class input to the decision rather than an
afterthought.

### Before implementation — Security Review

- Which section(s) of this document are affected (threat model, severity, principles,
  a specific domain in §5)?
- Net effect on security posture: **improves / neutral / reduces**?
- Any new attack surface introduced?
- Any new secrets, trust boundaries, or assumptions introduced?
- Rollback/recovery considerations if the change needs to be reverted?
- Does this affect the Internet Exposure Checklist (§4) — does it open, close, or
  reopen any item?
- What additional testing is required before the next snapshot?

### After implementation — Validation Summary

- Confirm each point raised in the Security Review was actually addressed — call out
  anything that wasn't, and why.
- Note any deviations from the plan.
- State pass/fail for the testing identified above.
- **If a security improvement is identified but judged non-urgent, it is logged in §8
  (Technical Debt) — never silently dropped.** A Low-severity finding that goes
  unrecorded is indistinguishable from one nobody ever noticed.

This process applies to both tracks — infrastructure/deployment phases and
application-level (`SECURITY_NOTES.md`) work.

---

## 8. Technical Debt Log

Security improvements identified as valid but not urgent enough to block current work.
Reviewed whenever their target phase/trigger comes up, not left indefinitely.

| Item | Domain (§5 #) | Severity | Why deferred | Target phase / trigger |
|---|---|---|---|---|
| Switch CSP from Report-Only to enforcing | 2 (reverse proxy hardening) | Low | Report-Only validated 2026-07-22 with zero unexpected violations across the full functional matrix (login/list/upload/download/resumable upload) — deliberately held back one cycle per explicit instruction before enforcing | Immediate next follow-up, not open-ended — small, isolated change (drop `-Report-Only` from the header name) |
| Malware scanning on uploads | 13 (upload validation) | Low | Poor fit for a single-operator threat model; real cost (ClamAV sidecar) for low payoff today | Revisit only if link-sharing with other people is ever added |
| Disk-level encryption for Postgres data directory | 11 (PostgreSQL hardening) | N/A today | Dormant while Neon hosts the DB | Only if Phase 5 (Neon → local Postgres) is ever un-deferred |
| HSTS header | 3 (TLS) | N/A today | No TLS listener active yet on the VM | Enable alongside Phase 7's TLS/Cloudflare Tunnel work |
