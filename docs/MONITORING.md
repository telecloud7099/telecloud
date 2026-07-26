# Monitoring & Alerting

Established Phase 15, 2026-07-25/26, as part of Internet Exposure Checklist item 13
(`SECURITY_ARCHITECTURE.md` §4). Covers backup/restore-verification failures,
container health, and suspicious login clustering — the three things this project
had no *active* (as opposed to run-it-yourself) detection for before this.

## Architecture

```
telecloud-backup.service ──┐
telecloud-restore-verify.service ──┤── OnFailure= ──> telecloud-notify-failure@.service ──┐
                                                                                             │
telecloud-health-monitor.timer (5 min)  ──> health_monitor.sh ─────────────────────────────┤──> notify.sh ──> ntfy.sh ──> your phone/browser
                                                                                             │
telecloud-security-alert.timer (hourly) ──> security_alert.sh (wraps security_event_summary.py) ──┘
```

`notify.sh` is the single choke point every alert goes through — one place that
formats messages consistently and holds the ntfy topic credential.

**Why ntfy.sh instead of Telegram:** deliberate design choice, mirroring the reasoning
behind using Backblaze B2 instead of Telegram for backups (`docs/BACKUP_POLICY.md`).
Monitoring should not depend on the same platform the application relies on — if a
future incident involves Telegram itself, alerts must still get through.

## Notification format

Every alert follows the same structure:
```
[SEVERITY] TeleCloud: Component        <- title
Severity: CRITICAL
Component: Backup
Host: roy-VirtualBox
Time: 2026-07-26T03:00:01Z

<short description>
See:
<suggested next command>
```
Severities: `CRITICAL` (urgent priority), `WARNING` (high priority), `RECOVERY`
(component has returned to healthy — sent so silence doesn't have to be interpreted as
"still fine"), `INFO`.

## What triggers an alert

| Source | Trigger | Severity | Dedup behavior |
|---|---|---|---|
| `telecloud-backup.service` | Any failed stage (`pg_dump`, `restic backup`, `retention_prune`, `integrity_check`) | CRITICAL | Systemd `OnFailure=` fires once per failed run — inherently not spammy, one alert per actual failure. |
| `telecloud-restore-verify.service` | Any failed stage (restore, schema/row-count check, app startup, health check, authenticated API call) | CRITICAL | Same as above. |
| Container health (`health_monitor.sh`, every 5 min) | Container missing, exited, or Docker-reported unhealthy | CRITICAL | State-tracked per container (`/opt/telecloud/monitoring_state/`) — alerts once on the healthy→bad transition, stays silent on every subsequent check while still bad, sends a `RECOVERY` alert on the bad→healthy transition. |
| Container health | Restart loop (`RestartCount` jumps by 3+ within one 5-minute check) | CRITICAL | Same transition-based dedup, tracked separately from the health-status flag (a container can be "healthy right now" while having just finished a loop). |
| `security_alert.sh` (hourly) | `security_event_summary.py` emits a literal `FLAG:` line (its own existing 3+-from-same-source clustering threshold, unmodified) | WARNING | Each run only scans log lines since the previous run's timestamp (state-tracked), so the same historical cluster isn't re-reported across multiple hourly runs. Routine, below-threshold auth failures never alert at all — this is inherent to the wrapped script's own logic, not something layered on top. |

**Known limitation, documented not silently accepted:** restart-loop detection compares
`RestartCount` to the previous check. A deliberate redeploy resets a fresh container's
count to 0, which correctly avoids a false alarm — but means a genuine crash loop
starting *immediately* after a redeploy, within the same 5-minute window, could be
masked by that reset. The separate exited/unhealthy check above provides a second,
independent detection path for that same scenario, so the gap is narrow, not absolute.

**Known limitation on the hourly security check:** a fixed one-hour non-overlapping
window means an attack whose attempts straddle exactly across two check boundaries
could stay under the clustering threshold in both windows individually, despite being
close together in real time. This is a defense-in-depth secondary layer — nginx's
`auth` rate-limit zone (Phase 7) is the primary control — and the script remains
available to run manually with a wider window at any time.

## Setup / operations

### Subscribing to alerts
Install the ntfy app (iOS/Android) or open `https://ntfy.sh/<your-topic>` in a browser,
and subscribe to the exact topic string in `.env.monitoring`'s `NTFY_TOPIC`.

### Rotating the topic
Anyone who knows the topic can read (or spoof) alerts on ntfy's public server — rotate
if you suspect it's leaked (e.g., accidentally pasted somewhere):
```bash
openssl rand -hex 24                                    # generate a new one
nano /opt/telecloud/app/.env.monitoring                 # update NTFY_TOPIC
```
Then re-subscribe on your device(s) to the new topic. No service restart needed — every
script sources `.env.monitoring` fresh on each run.

### Changing notification settings
- **Health-check interval:** edit `OnUnitActiveSec=` in
  `docker/monitoring/telecloud-health-monitor.timer`, then
  `sudo systemctl daemon-reload`.
- **Restart-loop threshold:** `RESTART_LOOP_THRESHOLD` at the top of
  `health_monitor.sh`.
- **Security-check cadence:** `OnUnitActiveSec=` in
  `telecloud-security-alert.timer`.
- **Login-failure clustering threshold:** `LOGIN_FAILURE_CLUSTER_THRESHOLD` in
  `security_event_summary.py` itself (shared with any manual run of that script).

### Testing manually
```bash
# Generic notification test:
./docker/monitoring/notify.sh WARNING "Test" "Manual test message" "no action needed"

# Force a health-monitor run right now:
./docker/monitoring/health_monitor.sh

# Force a security-alert run right now (uses the real since-last-check window):
./docker/monitoring/security_alert.sh

# Force the failure-notification path without waiting for a real failure:
./docker/monitoring/notify_failure.sh telecloud-backup.service
```

### Troubleshooting — alerts stop arriving
1. Confirm the timers are actually active: `systemctl list-timers 'telecloud-*'`.
2. Check each script's own recent runs: `journalctl -u telecloud-health-monitor.service --since today` (same pattern for `-security-alert`/`-backup`/`-restore-verify`).
3. Confirm `.env.monitoring` exists, is readable by `roy`, and `NTFY_TOPIC` is set:
   `ls -la /opt/telecloud/app/.env.monitoring`.
4. Send a manual test (above) and check for a `curl` error — a non-zero exit or HTTP
   error there points at ntfy.sh reachability or a malformed topic, not this project's
   logic.
5. Confirm you're still subscribed to the *current* topic on your device — a topic
   rotation (above) requires re-subscribing.

## Verification history
- 2026-07-26: manual test notification confirmed delivered with correct formatting
  (severity/component/host/timestamp/message/next-step), no secrets present.
