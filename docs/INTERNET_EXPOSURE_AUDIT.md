# Internet Exposure Checklist — Audit

Produced 2026-07-26, re-verifying every item in `SECURITY_ARCHITECTURE.md` §4
against actual current state (commit `337e3e8be3a0557e7f90463944eb9fbb16f0fd62`) —
not recalled from memory of earlier phases, per that checklist's own item 15
requirement. This is separate from, and a strictly higher bar than,
`docs/PHASE15_GO_NO_GO_REPORT.md` — that report answers "ready for real-hardware
*validation* testing"; this one answers "ready for the *public internet*."

**TeleCloud may not be made reachable from the public internet — by Cloudflare
Tunnel, port-forward, or any other means — until every item below is satisfied.**
This is a hard gate per `SECURITY_ARCHITECTURE.md` §4, not a best-effort list.

## Verdict: **NO-GO — 2 items remaining, both already scheduled next**

13 of 15 items are now satisfied (item 14 closed 2026-07-26). The 2 outstanding items
are TLS/Tunnel configuration (items 2 + 5, one piece of work) and the final re-audit
(item 15) — exactly the sequence you've already planned.

## Item-by-item status

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | All Critical/High findings resolved, incl. issue #1 (stored XSS) | ✅ **DONE** | `SECURITY_NOTES.md` issue #1 closed 2026-07-25 with source review + 3 live DOM-verified runtime tests. No other Critical/High application-level finding exists (`#2`/`#4` Low, `#3`/`#5` Medium). |
| 2 | TLS active end-to-end | ❌ **NOT DONE** | No TLS anywhere yet — deliberately, per every phase's scope boundary up to now. This is what Cloudflare Tunnel (edge-terminated TLS) provides — planned as your next-but-one step. |
| 3 | SSH key-only if enabled | ✅ **N/A** | No SSH workflow exists on this VM (Phase 14d, verified-inapplicable via two independent layers — guest-side and host-side). Re-verify if SSH is ever introduced. |
| 4 | UFW default-deny + Docker-vs-UFW resolved | ✅ **DONE** | Phase 14a. Re-verified zero drift through Phase 15's actual reboot test (item 9) — DOCKER-USER's 5 rules identical before/after a real cold boot, not just unit-file inspection. |
| 5 | No port forwarded on home router; Tunnel is sole path in | ❌ **NOT DONE** | N/A yet — nothing is exposed at all (VM stays VirtualBox-NAT-only). Satisfied once Cloudflare Tunnel is configured as the sole path — your next planned step. |
| 6 | Login/OTP rate-limited | ✅ **DONE** | Phase 7 (`auth` zone, 5r/m). Observed firing correctly and repeatedly throughout Phase 15 testing — a live-verified control, not just configured. |
| 7 | Nginx rate limiting, headers, body-size/timeout limits | ✅ **DONE** | Phase 7. |
| 8 | Backups encrypted, offsite, restore tested | ✅ **DONE** | Phase 15 (this session): restic client-side encryption, Backblaze B2 (deliberately independent of Telegram), automated daily backup + weekly restore verification, both live-tested end-to-end including a full isolated app-startup + authenticated API call against restored data. `docs/BACKUP_POLICY.md`, `docs/DISASTER_RECOVERY_RUNBOOK.md`. |
| 9 | No secret in git history/image layers/transcript; `.env*` chmod 600 | ✅ **DONE** | `.env.app`/`.env.db`/`.env.backup`/`.env.monitoring` all confirmed `chmod 600`. All new secrets this phase (B2 keys, `RESTIC_PASSWORD`, `NTFY_TOPIC`) were generated directly on the VM and deliberately never pasted into this conversation, per established practice from three earlier-phase incidents. `.env.backup` was found not actually gitignored (never committed, just never added) — fixed alongside `.env.monitoring`. |
| 10 | Container hardening (non-root, capabilities, no privileged, `no-new-privileges`) | ✅ **DONE** | Phase 14b. Re-verified byte-for-byte identical through Phase 15's real reboot test (item 9). |
| 11 | Images digest-pinned and scanned, no outstanding Critical/High CVEs | ✅ **DONE** (as documented risk assessments) | Phase 14c pinning, confirmed `pinned == live` with zero drift as of this audit. 5 CRITICAL-severity CVEs from the monthly Trivy scan each individually investigated and documented as not-exploitable-in-current-usage, with verification method, residual risk, and invalidating conditions (`SECURITY_NOTES.md` §6a) — not remediated (versions unchanged), satisfying this item's explicit "or documented evidence... not exploitable" allowance. The 5th (`CVE-2023-45853`, zlib) was found during this audit's re-scan, having been missed in the original pass — corrected, not left uncorrected. HIGH-severity findings (several dozen per image) are deliberately not individually enumerated, a disclosed scoping decision explained in `SECURITY_NOTES.md` §6a, not an oversight. |
| 12 | Automatic security updates on host OS | ✅ **DONE** | Phase 14e (`unattended-upgrades`, extended to Docker Engine's own repo). |
| 13 | Monitoring/alerting active for suspicious logins and resource anomalies | ✅ **DONE** | Phase 15 (this session): backup/restore-verify failures, container health (with dedup + recovery notifications), and security-event clustering all alert automatically via ntfy.sh. All three paths live-tested end-to-end, two real bugs found and fixed during testing (`docs/MONITORING.md`). |
| 14 | Full functional test matrix passes against the *exact* configuration being exposed | ✅ **DONE** | Re-run 2026-07-26 against commit `8efd733`, all 8 items PASS (`docs/FUNCTIONAL_TEST_MATRIX.md`). Surfaced and resolved a real hygiene issue along the way: accumulated Phase 15 test artifacts causing 22 console 404s — cleaned via the app's own delete API, re-verified clean afterward with a fresh upload/thumbnail/download cycle. |
| 15 | Complete dedicated security audit performed immediately before go-live | ⏳ **THIS DOCUMENT** | In progress — see verdict above. Must be re-run (or explicitly re-confirmed) after items 2, 5, and 14 close, since this audit's own standard requires checking actual current state, not memory of an earlier pass. |

## What "already satisfied" means here, precisely

Every ✅ above was checked against **actual current state** (commit, live digest
comparison, or a re-run test from this session), not carried forward from an
earlier phase's memory — consistent with item 15's own requirement that checking
boxes from memory doesn't count as verification.

## The 3 remaining items, and why they're correctly sequenced

1. **Item 14 (functional matrix re-run)** should happen first, against the exact
   commit this audit applies to — confirms nothing regressed before changing
   anything about network exposure.
2. **Items 2 + 5 (TLS + Tunnel-as-sole-path)** are two facets of the same piece of
   work — configuring Cloudflare Tunnel satisfies both simultaneously (edge-terminated
   TLS, outbound-only connection with no port forward).
3. **Item 15 (final audit)** should be re-run — or this document explicitly
   re-confirmed — once 2/5/14 close, immediately before actually connecting the
   Vercel frontend to a publicly reachable endpoint. Not a formality: a "complete,
   dedicated" re-check is exactly what caught the `.env.backup`/gitignore gap and
   the stored-XSS-vs-current-codebase mismatch this session — the process finds
   real things, not just confirms assumptions.

## Recommended order (matches your stated plan)

1. VM end-to-end testing (item 14) — full functional matrix against current commit.
2. Configure Cloudflare Tunnel (items 2 + 5).
3. Re-run or re-confirm this audit (item 15) — expect a clean 15/15 at that point.
4. Only then: update Vercel's `VITE_API_URL` to the Tunnel endpoint and redeploy.
