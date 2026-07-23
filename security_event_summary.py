"""Phase 12 operational tool (not application code): lightweight review of
backend/security.py's "SECURITY EVENT: type=... ip=... phone=... ua=... details=..." log
lines, without a full SIEM/observability stack.

Generic by design: the event-type summary auto-discovers whatever types actually appear in
the input (via a plain Counter) rather than a hardcoded list, so a new event type added to
log_security_event() later shows up automatically with no changes needed here. Login-failure
clustering is a separate, additional analysis layer on top of that generic summary, not
baked into the core parsing/counting logic.

Usage (reads log text from stdin):
    docker compose logs telecloud-app | python3 security_event_summary.py
    docker compose logs --since 24h telecloud-app | python3 security_event_summary.py
"""
import re
import sys
from collections import Counter, defaultdict

EVENT_RE = re.compile(
    r"SECURITY EVENT: type=(?P<type>\S+) ip=(?P<ip>\S+) phone=(?P<phone>\S+) "
    r"ua=(?P<ua>.*?) details=(?P<details>.*)$"
)
TIMESTAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:,\d+)?)")

LOGIN_FAILURE_CLUSTER_THRESHOLD = 3


def parse_events(lines):
    events = []
    for line in lines:
        m = EVENT_RE.search(line)
        if not m:
            continue
        ts = TIMESTAMP_RE.search(line)
        events.append({
            "type": m.group("type"),
            "ip": m.group("ip"),
            "phone": m.group("phone"),
            "details": m.group("details"),
            "timestamp": ts.group(1) if ts else "unknown-time",
        })
    return events


def generic_summary(events) -> None:
    """Auto-discovers event types present in this run's input -- no hardcoded list, so a
    new log_security_event() call site elsewhere in the app shows up here with zero changes
    to this script."""
    by_type = Counter(e["type"] for e in events)
    print(f"Total SECURITY EVENT lines parsed: {len(events)}")
    print()
    print("Counts by event type:")
    for event_type, count in by_type.most_common():
        print(f"  {event_type:<28} {count}")
    print()


def login_failure_clustering(events, threshold: int = LOGIN_FAILURE_CLUSTER_THRESHOLD) -> None:
    """Additional analysis layer, separate from the generic summary above: flags repeated
    LOGIN_FAILED events from the same ip or phone within this run's input window."""
    failures = [e for e in events if e["type"] == "LOGIN_FAILED"]
    print(f"LOGIN_FAILED clustering (threshold: {threshold}+ from the same source):")
    if not failures:
        print("  No LOGIN_FAILED events in this window.")
        return

    by_ip = defaultdict(list)
    by_phone = defaultdict(list)
    for e in failures:
        by_ip[e["ip"]].append(e)
        if e["phone"] not in ("None", "none", ""):
            by_phone[e["phone"]].append(e)

    flagged = False
    for ip, evs in by_ip.items():
        if len(evs) >= threshold:
            flagged = True
            print(f"  FLAG: ip={ip} -- {len(evs)} failed login attempts")
            for e in evs:
                print(f"    {e['timestamp']} phone={e['phone']} details={e['details']!r}")
    for phone, evs in by_phone.items():
        if len(evs) >= threshold:
            flagged = True
            print(f"  FLAG: phone={phone} -- {len(evs)} failed login attempts")
            for e in evs:
                print(f"    {e['timestamp']} ip={e['ip']} details={e['details']!r}")
    if not flagged:
        print(f"  {len(failures)} total failure(s), none clustered above the threshold.")


def main() -> None:
    lines = sys.stdin.readlines()
    events = parse_events(lines)
    if not events:
        print("No SECURITY EVENT lines found in input.")
        return
    generic_summary(events)
    login_failure_clustering(events)


if __name__ == "__main__":
    main()
