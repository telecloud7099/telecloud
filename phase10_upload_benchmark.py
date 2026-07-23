"""Phase 10 diagnostic: drives the real chunked-upload API end-to-end (create session ->
PUT part(s) -> poll GET for the server-side "uploading_telegram" phase -> complete) and
times the two legs separately:

  - "receive" leg: how long the PUT itself takes to return (request body -> temp file on
    disk, per chunk_upload.py's receive_part -- this is the client-to-backend leg and
    should be near-instant when this script runs on the VM itself against localhost).
  - "telegram" leg: wall-clock time the part spends in the "uploading_telegram" phase
    (backend -> Telegram, the cryptg-bound leg this Phase 10 test cares about), cross-
    checked against the server's own speed_bps/bytes instrumentation from
    upload_progress.py rather than re-derived only from wall-clock deltas.

Stdlib only (urllib) -- deliberately no `requests`/`httpx` dependency added just for a
throwaway benchmark that isn't part of the deployed app.

Not part of the app -- ad hoc benchmark for Phase 10 (5 vCPU baseline vs 2 vCPU cap).
Run it identically for both, with the same file, from the same place (the VM itself, over
loopback to nginx), so the only thing that differs between runs is the VM's vCPU count.

Usage:
    export TELECLOUD_JWT="<paste from browser localStorage after logging in>"
    python phase10_upload_benchmark.py /tmp/phase10_testfile.bin --label 5vcpu-baseline
    python phase10_upload_benchmark.py /tmp/phase10_testfile.bin --label 2vcpu

Run `docker stats telecloud-app --no-stream` in a second terminal a few times during the
"telegram" leg to sample CPU/memory -- this script doesn't do that itself since it needs
to run on the VM host (docker CLI), not from inside the container this script talks to.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

POLL_INTERVAL_SECONDS = 0.5


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _request(method: str, url: str, token: str, data: bytes = None, json_body: dict = None, timeout: int = 30) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    body = data
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {url} -> HTTP {e.code}: {e.read().decode()}")


def create_session(base_url: str, token: str, filename: str, total_size: int) -> dict:
    body = _request("POST", f"{base_url}/uploads", token, json_body={
        "filename": filename, "total_size": total_size, "mime_type": "application/octet-stream",
        "folder_name": "phase10-benchmark",
    })
    if not body.get("chunked"):
        raise SystemExit(
            f"File is below the resumable threshold and would use the single-shot /upload "
            f"endpoint instead -- pick a larger file so this exercises the chunked/session "
            f"path this test is measuring. Server response: {body}"
        )
    return body


def put_part(base_url: str, token: str, session_id: str, part_number: int, data: bytes) -> float:
    t0 = time.monotonic()
    _request("PUT", f"{base_url}/uploads/{session_id}/parts/{part_number}", token, data=data, timeout=600)
    return time.monotonic() - t0


def poll_until_confirmed(base_url: str, token: str, session_id: str, part_number: int) -> dict:
    """Polls GET /uploads/{id} until this part clears from part_progress (confirmed).
    Returns timing + the last-seen server-reported progress sample for cross-check."""
    telegram_start = None
    last_progress = None

    while True:
        body = _request("GET", f"{base_url}/uploads/{session_id}", token)
        progress = body.get("part_progress")

        if progress and progress.get("phase") == "uploading_telegram":
            if telegram_start is None:
                telegram_start = time.monotonic()
            last_progress = progress
        elif progress is None and body["next_part_number"] > part_number:
            telegram_end = time.monotonic()
            return {
                "telegram_seconds": (telegram_end - telegram_start) if telegram_start else None,
                "last_server_speed_bps": last_progress["speed_bps"] if last_progress else None,
            }
        elif progress and progress.get("error"):
            raise SystemExit(f"Part {part_number} failed server-side: {progress['error']}")

        time.sleep(POLL_INTERVAL_SECONDS)


def complete_session(base_url: str, token: str, session_id: str) -> dict:
    return _request("POST", f"{base_url}/uploads/{session_id}/complete", token)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file_path")
    parser.add_argument("--label", default="run", help="Tag for this run, e.g. 5vcpu-baseline or 2vcpu")
    parser.add_argument("--base-url", default="http://localhost", help="Backend base URL (default: through nginx on the VM itself)")
    parser.add_argument("--token", default=os.environ.get("TELECLOUD_JWT"), help="JWT, or set TELECLOUD_JWT env var")
    args = parser.parse_args()

    if not args.token:
        sys.exit("No JWT provided -- pass --token or set TELECLOUD_JWT")

    total_size = os.path.getsize(args.file_path)
    filename = os.path.basename(args.file_path)

    print(f"=== Phase 10 upload benchmark: {args.label} ===")
    print(f"started_at: {iso_now()}")
    print(f"os.cpu_count(): {os.cpu_count()}")
    print(f"file: {args.file_path} ({total_size} bytes)")
    print(f"base_url: {args.base_url}")
    print()

    wall_start = time.monotonic()
    session = create_session(args.base_url, args.token, filename, total_size)
    session_id = session["session_id"]
    chunk_size = session["chunk_size"]
    total_chunks = session["total_chunks"]
    print(f"session_id={session_id} chunk_size={chunk_size} total_chunks={total_chunks}")
    print()

    part_results = []
    with open(args.file_path, "rb") as f:
        for part_number in range(1, total_chunks + 1):
            start = (part_number - 1) * chunk_size
            end = min(part_number * chunk_size, total_size)
            f.seek(start)
            data = f.read(end - start)

            receive_seconds = put_part(args.base_url, args.token, session_id, part_number, data)
            telegram_info = poll_until_confirmed(args.base_url, args.token, session_id, part_number)

            part_results.append({
                "part_number": part_number,
                "size_bytes": len(data),
                "receive_seconds": receive_seconds,
                **telegram_info,
            })
            print(
                f"part {part_number}/{total_chunks}: size={len(data)} bytes  "
                f"receive={receive_seconds:.2f}s  "
                f"telegram={telegram_info['telegram_seconds']:.2f}s  "
                f"server_speed_bps={telegram_info['last_server_speed_bps']}"
            )

    complete_result = complete_session(args.base_url, args.token, session_id)
    wall_total = time.monotonic() - wall_start

    total_telegram_seconds = sum(p["telegram_seconds"] for p in part_results if p["telegram_seconds"])
    throughput_mb_s = (total_size / (1024 * 1024)) / total_telegram_seconds if total_telegram_seconds else None

    print()
    print(f"finished_at: {iso_now()}")
    print(f"file_id: {complete_result.get('file_id')}")
    print(f"wall_clock_total_seconds: {wall_total:.2f}")
    print(f"sum_telegram_leg_seconds: {total_telegram_seconds:.2f}")
    print(f"throughput_MB_per_s (file_size / sum_telegram_leg_seconds): {throughput_mb_s:.3f}")
    print()
    print(f"=== end {args.label} ===")


if __name__ == "__main__":
    main()
