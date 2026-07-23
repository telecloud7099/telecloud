"""Phase 11 Scenario 3 diagnostic: continuously polls GET /uploads/{id} while a restart
happens live, to directly observe (not infer) that transient failures during the backend's
down-window don't get treated as fatal by a polling client -- per the Phase 3 lesson that
clients must only treat a definitive 404 as fatal, not connection errors or 5xx responses.

Deliberately standalone from phase10_upload_benchmark.py (whose PUT path hit a urllib bug
sending huge in-memory bodies on this VM's Python 3.14) -- polling is a small GET, doesn't
need that code path at all, so this stays minimal and reuses only the retry logic itself.

Usage:
    export TELECLOUD_JWT="<token>"
    python3 phase11_poll_resilience_test.py <session_id>

Run this while a restart/kill is injected against telecloud-app in another terminal --
watch it print through the outage and recover on its own, then Ctrl+C when satisfied.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

POLL_INTERVAL_SECONDS = 1


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 phase11_poll_resilience_test.py <session_id>")
    session_id = sys.argv[1]
    token = os.environ.get("TELECLOUD_JWT")
    if not token:
        sys.exit("Set TELECLOUD_JWT first")

    url = f"http://localhost/uploads/{session_id}"
    headers = {"Authorization": f"Bearer {token}"}
    outage_started = None
    poll_count = 0

    print(f"Polling {url} every {POLL_INTERVAL_SECONDS}s -- Ctrl+C to stop")
    while True:
        poll_count += 1
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = json.loads(resp.read().decode())
            if outage_started is not None:
                print(f"[{iso_now()}] poll {poll_count}: RECOVERED after {time.monotonic() - outage_started:.1f}s outage -- {body}")
                outage_started = None
            else:
                print(f"[{iso_now()}] poll {poll_count}: OK -- session_status={body.get('session_status')} next_part_number={body.get('next_part_number')}")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"[{iso_now()}] poll {poll_count}: FATAL 404 -- session truly gone, stopping")
                return
            if outage_started is None:
                outage_started = time.monotonic()
                print(f"[{iso_now()}] poll {poll_count}: transient HTTP {e.code} -- treating as non-fatal, continuing to poll")
        except (OSError, ConnectionError, urllib.error.URLError) as e:
            if outage_started is None:
                outage_started = time.monotonic()
                print(f"[{iso_now()}] poll {poll_count}: connection error ({e}) -- treating as non-fatal, continuing to poll")

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
