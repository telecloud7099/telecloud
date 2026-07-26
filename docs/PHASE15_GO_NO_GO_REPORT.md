# Phase 15 — Go/No-Go Report (VM Validation Stage)

Produced 2026-07-26, after full execution of `docs/PHASE15_GO_NO_GO_TEST_PLAN.md` —
not a running commentary during it, per that plan's own stated deliverable.

**This report answers**: *"Is TeleCloud ready to migrate to the i3-2120 as a
temporary, 24/7, LAN-only test server?"* — not "is it ready for production or the
internet." That is a separate, larger gate (`SECURITY_ARCHITECTURE.md`'s Internet
Exposure Checklist), audited independently in
`docs/INTERNET_EXPOSURE_AUDIT.md`.

## Verdict: **GO**

TeleCloud is ready to migrate to the i3-2120 for real-hardware validation testing.
All 10 planned test areas passed. Two real application bugs were found and fixed
during execution (not just during dedicated bug-hunting) — the system was made
better by running this plan, not just measured by it.

## Exact state this verdict applies to

- **Commit**: `337e3e8be3a0557e7f90463944eb9fbb16f0fd62`, clean working tree
  confirmed on the VM (`git status --short` empty).
- **Digest-pinned images**, confirmed `pinned == live` via `patch_management_check.sh`
  section 3, zero drift:
  - `nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10`
  - `postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`
  - `python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91`
  - `node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`
- A later commit is a new, unvalidated state until re-verified against this same
  10-area plan.

## Summary by area

| # | Area | Result |
|---|---|---|
| 1 | Functional test matrix (full re-run) | PASS |
| 2 | Security re-verification (14a–14e, no drift) | PASS |
| 3 | Frontend production build ↔ VM backend | PASS (root cause of an initial false alarm confirmed — nginx rate-limit zone, not a real bug) |
| 4 | Long-duration stability (24–48h) | PASS (full 48h window run to completion; all 13 logged errors reviewed and accounted for) |
| 5 | Large-file upload/download/resumable transfer | PASS (uncovered and fixed two real widget bugs along the way) |
| 6 | Backup and restore verification (fresh run) | PASS |
| 7 | Resource measurement under real load | PASS (peak CPU/mem numbers recorded for i3-2120 comparison) |
| 8 | Upload-unresponsiveness reproduction attempt | NOT REPRODUCED (documented with direct evidence, not silence — retry on real hardware) |
| 9 | Docker restart + VM reboot recovery | PASS (first real proof DOCKER-USER rules and container hardening survive a cold boot) |
| 10 | Deployment reproducibility check | PASS |

Full narrative, evidence, and exact commands for every area: `docs/PHASE15_GO_NO_GO_TEST_PLAN.md`.

## Real bugs found and fixed during this phase (not pre-existing knowledge)

1. **Upload widget's "Reattach to resume" was inert text** — no click handler, no
   file picker, despite instructing an action. Fixed by clarifying the actual resume
   path is documented; tracked as a UX follow-up (not fixed this phase — the dismiss
   bug below was the higher-priority fix).
2. **Dismissing a paused upload never actually canceled it server-side** — the ✕
   button only cleared local UI state; the backend's `DELETE /uploads/{id}` endpoint
   existed but was never wired to any control. Fixed: confirms before dismissing any
   live session and actually aborts it. Committed `21223b5`.
3. **`PreviewModal.tsx`'s PDF-preview iframe had no `sandbox` attribute**, and MIME
   type was fully client-supplied and unvalidated — investigated as a potential
   attack surface (not part of the original stored-XSS finding), tested live with a
   crafted HTML-disguised-as-PDF payload, confirmed not exploitable
   (`X-Content-Type-Options: nosniff` genuinely prevents it), then hardened anyway
   with `sandbox=""` as defense-in-depth. Verified no regression to real PDF viewing.

## Non-blocking findings carried forward (not silently dropped)

- **Item 3**: a legitimately rate-limited client sees a misleading "CORS blocked"
  browser error instead of a clear rate-limit signal, for any cross-origin request
  (as the real Vercel/Tunnel-fronted deployment will be). Revisit at the production
  stage.
- **Item 4/item 10**: intermittent network blips (Telethon connection resets, Neon
  DNS resolution failures) observed twice across the 48h window, self-recovering
  both times, no crash/outage. Root cause undetermined between VirtualBox NAT, host
  networking, or upstream — re-evaluate on the physical i3-2120 to see if it's
  VM-environment-specific.
- **Item 5**: two upload-widget usability findings not yet fixed — no session
  ID/timestamp shown when multiple sessions share a filename (found during item 9),
  and the missing resume-affordance UX itself (distinct from the dismiss-bug fix
  above).
- **Item 8**: Phase 11's upload-unresponsiveness finding was not reproduced under VM
  conditions despite deliberately attempting to, with direct evidence (curl-probe
  timing at the exact CPU peak) — not simply "we didn't see it." Retry on the
  i3-2120 per the original resilience test plan's own stated objective.
- **Item 10**: five CRITICAL-severity CVEs from the monthly Trivy scan, each
  individually assessed and documented as not-exploitable-in-current-usage
  (`SECURITY_NOTES.md` §6a) — not remediated, since digest-pinning intentionally
  locks content, not future CVE-freeness. Re-reviewed on the same monthly cadence as
  the pinned-image check. (A 5th, `CVE-2023-45853`, was found and corrected during
  the subsequent Internet Exposure audit — see that document.)

## What this verdict does NOT cover

Per this phase's explicit scope boundary, none of the following were tested or are
implied by this GO verdict, and are covered separately in
`docs/INTERNET_EXPOSURE_AUDIT.md`: TLS, public internet reachability, Cloudflare
Tunnel, LAN-CIDR firewall scoping (deferred to the actual i3-2120 deployment by
design), or the full Internet Exposure Checklist.
