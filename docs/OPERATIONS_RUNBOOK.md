# Operations Runbook

Phase 12 deliverable — practical, VM-scale monitoring for the TeleCloud stack. Deliberately
lightweight: no Loki/Grafana/Prometheus (see `docker/nginx/nginx.conf`'s comment on
`log_format main` for why that was considered and deferred, not forgotten) — this runbook is
the operational substitute for a home-server target that's deliberately capped at 2 vCPUs
to match the eventual i3-2120 hardware.

Every number in this doc is either **✅ measured** in this environment on a real date, or
explicitly marked **⚠️ expected/not yet measured** — don't treat the second kind as fact.

---

## 1. `docker stats` — container resource usage

```bash
docker stats --no-stream
```

**✅ Measured baselines (2026-07-23, VM idle, 2 vCPUs, no active upload):**

| Container | CPU % | Memory |
|---|---|---|
| `telecloud-app` | ~1-2% | ~100-180 MiB |
| `telecloud-nginx` | ~0-0.5% | ~12 MiB |
| `telecloud-postgres` | ~0% | ~50 MiB |

**✅ Measured, active large upload (Phase 10):** `telecloud-app` CPU can spike into the
40-95% range in short bursts during the `cryptg`-encryption leg of an upload. This is
expected and was root-caused, not a bug (see §6 below).

**When to be concerned:** sustained high CPU/memory with *no* active upload running
(check `GET /uploads` for active sessions first) — that would be new, unexplained load.

---

## 2. `docker compose ps` — service state and health

```bash
docker compose ps
```

**✅ Expected healthy output shape** (all three services):
- `telecloud-app`: `Up ... (healthy)` — healthcheck is `curl -f http://localhost:8000/health`
  (a trivial liveness check only — see §6, it does *not* verify Neon/Telegram connectivity).
- `telecloud-nginx`: `Up ...` (no healthcheck configured on this service — its own
  reachability is what matters, check via `curl http://localhost/health` from the host).
- `telecloud-postgres`: `Up ... (healthy)` — healthcheck is `pg_isready`.

`docker compose ps -a` (not just `ps`) is needed to see **stopped/exited** containers —
plain `ps` hides them, which can look like a container vanished when it's actually just
`Exited`. Learned the hard way in Phase 11's `docker kill` testing.

---

## 3. `docker compose logs` — application and proxy logs

```bash
docker compose logs --tail 100 telecloud-app
docker compose logs --tail 100 nginx
```

**✅ Confirmed (Phase 12):** nginx's `access.log`/`error.log` are symlinked to
`/dev/stdout`/`/dev/stderr` inside the container (standard for the official `nginx` image),
so `docker compose logs nginx` shows them directly — **do not** `docker cp` these files out
and `tail` them; they're symlinks, and `tail`-ing a copied symlink to a device file hangs
forever reading your own terminal's stream, not the log.

**✅ Confirmed (Phase 12):** nginx access log format now includes real timing fields:
```
rt=$request_time uct=$upstream_connect_time uht=$upstream_header_time urt=$upstream_response_time
```
(all in seconds, e.g. `rt=0.045`). Use these to spot slow requests directly via `grep`,
e.g. `docker compose logs nginx | grep -oP 'rt=\K[0-9.]+' | sort -rn | head` for the
slowest recent requests.

**Useful filters:**
```bash
docker compose logs telecloud-app | grep -i "error\|traceback\|exception"
docker compose logs telecloud-app | grep "SECURITY EVENT"
```

---

## 4. `journalctl` — host-level systemd logs

```bash
journalctl -u docker --since "1 hour ago"
```

Relevant units on this VM: `docker.service` (daemon-level events — container OOM-kills at
the kernel level show up here, not in `docker compose logs`), `fail2ban` (installed Phase 2,
currently dormant — no SSH workflow on this VM per Phase 14d's plan), `ufw` (firewall).

---

## 5. `btop` — host-level resource overview

```bash
btop
```

Installed in Phase 2. Use for a live, whole-VM view (all 3 containers plus host overhead)
when `docker stats` alone doesn't explain something — e.g., confirming the *host* isn't
under memory pressure from something outside Docker entirely.

---

## 6. Known patterns — troubleshooting entries from real incidents

These are things that actually happened on this VM, root-caused during Phase 10/11, not
generic advice. Check here before treating something as a new mystery.

- **`docker compose ps` shows `unhealthy`, but the app seems to respond to some requests:**
  seen during Phase 11 while a large upload was actively running. Docker's healthcheck
  failed 12 consecutive times with literally 0 bytes transferred in the full 5s timeout
  window each time (`docker inspect telecloud-app --format '{{json .State.Health}}'` shows
  the raw attempts). Correlated with — not yet profiled to a specific line of code causing
  — the active upload's `cryptg` encryption/disk I/O. If this recurs, check `GET /uploads`
  for an active session before assuming a new bug; if confirmed correlated again, that's
  still an open item for a future phase (candidates: `os.fsync()` in `chunk_upload.py`,
  blocking file reads inside Telethon's own upload path, or `cryptg.encrypt_ige()` not
  releasing the GIL — see Phase 10's `docs/PERFORMANCE_NOTES.md`).
- **`docker kill` (or an external SIGKILL from a monitoring tool) does NOT bring the
  container back on its own**, even though `restart: unless-stopped` is configured.
  This is correct, verified Docker/kernel behavior (`man 7 pid_namespaces`) — an explicit
  kill from *outside* the container's PID namespace is treated as a deliberate operator
  action, not a crash, so `unless-stopped` intentionally doesn't override it. A genuine
  in-process crash (OOM, an unhandled exception that takes down the process) **does**
  auto-restart correctly — verified directly in Phase 11. **If you ever need to force-kill
  this container, plan on running `docker compose start telecloud-app` afterward.**
- **`/tmp/*` files disappear after a VM reboot.** `/tmp` is a tmpfs mount on this VM
  (confirmed via `df -h`), wiped on every reboot. Don't be surprised finding a previously
  created test/scratch file gone — this is expected, not data loss of anything real (real
  data lives under `/opt/telecloud/data/`, a separate bind-mounted path).
- **Transient `Connection refused` to Neon Postgres and/or Telegram right after a VM
  reboot.** Observed in Phase 11: the guest's network stack takes a few seconds to fully
  stabilize post-boot, during which both external connections can fail once. The app's own
  error-handling (mark the operation `"failed"` with a retryable error, or SQLAlchemy's
  connection-pool reconnect) handles this correctly — a client-side retry a few seconds
  later succeeds. Not a bug, just a real narrow window worth recognizing rather than
  re-investigating each time.
- **Backend container restart takes far longer than `stop_grace_period` should allow
  (should be 1-2s for a healthy process, up to 30s max) is itself a symptom** worth
  investigating, not just waiting out — in Phase 11 this correlated with the event-loop-
  blocking pattern above.

---

## 7. Disk usage

```bash
df -h /opt/telecloud/data
docker system df
```

**✅ Measured (Phase 12, 2026-07-23):** with `compose.yml`'s production logging config
(`max-size: "10m"`, `max-file: "3"` per service), each service's logs are capped at ~30MB
on disk — **~90MB total** across all three services at worst, not unbounded growth. This
was empirically proven, not just configured and assumed: temporarily lowered `max-size` to
`50k` on the live VM, generated real request traffic, and directly observed (via
`sudo ls -la` on the container's `/var/lib/docker/containers/<id>/` directory) that the
active log rotates to `.log.1` right at the threshold, and once `.log`, `.log.1`, and
`.log.2` (matching `max-file: 3`) all exist, a further rotation prunes the oldest rather
than ever producing a `.log.3`. Reverted to the production `10m` setting immediately after
(confirmed via `git status` showing a clean tree against the committed config).

---

## 8. Security event review

See `docs/SECURITY_EVENT_REVIEW.md` (added alongside this runbook) and the
`security_event_summary.py` script for a lightweight way to review `SECURITY EVENT:` log
lines (login attempts, uploads, folder/file operations) without a full SIEM stack.
