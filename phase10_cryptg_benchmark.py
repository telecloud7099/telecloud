"""Phase 10 diagnostic: pure CPU microbenchmark for cryptg's AES-IGE throughput, with no
network involved at all. Complements phase10_upload_benchmark.py, which measures real
end-to-end Telegram upload speed -- a number that turned out to be dominated by current
network conditions (~47 KB/s observed), nowhere near any plausible CPU ceiling. This script
isolates the other half of the question Phase 10 actually cares about: does cryptg's
encryption throughput itself scale with vCPU count?

Uses cryptg.encrypt_ige(data, key, iv) directly with MTProto-shaped key/IV sizes (32 bytes
each, matching what Telethon's own crypto layer uses) -- not a synthetic stand-in.

Tests thread counts 1, 2, and os.cpu_count() (deduplicated) so the *same* script run once
on the 5-vCPU VM and once on the 2-vCPU-capped VM produces directly comparable output: if
aggregate MB/s at thread-count == cpu_count drops going from 5 to 2, encryption is
CPU-bound at this app's real concurrency model (threads within one asyncio process, not
multiprocessing). If it doesn't move, cryptg isn't the bottleneck either way.

Usage:
    python3 phase10_cryptg_benchmark.py --label 5vcpu-baseline
    python3 phase10_cryptg_benchmark.py --label 2vcpu
"""
import argparse
import os
import threading
import time

import cryptg

MB = 1024 * 1024
DATA_PER_THREAD_MB = 128  # large enough to swamp Python-level call overhead


def worker(nbytes: int, results: list, idx: int) -> None:
    key = os.urandom(32)
    iv = os.urandom(32)
    data = os.urandom(nbytes)
    t0 = time.perf_counter()
    cryptg.encrypt_ige(data, key, iv)
    results[idx] = time.perf_counter() - t0


def run_config(thread_count: int) -> dict:
    nbytes = DATA_PER_THREAD_MB * MB
    results = [0.0] * thread_count
    threads = [threading.Thread(target=worker, args=(nbytes, results, i)) for i in range(thread_count)]

    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0

    total_mb = DATA_PER_THREAD_MB * thread_count
    return {
        "thread_count": thread_count,
        "total_mb": total_mb,
        "wall_seconds": wall,
        "aggregate_mb_s": total_mb / wall,
        "per_thread_seconds": [round(r, 3) for r in results],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="run", help="Tag for this run, e.g. 5vcpu-baseline or 2vcpu")
    args = parser.parse_args()

    cpu_count = os.cpu_count()
    thread_counts = sorted(set([1, min(2, cpu_count), cpu_count]))

    print(f"=== Phase 10 cryptg CPU microbenchmark: {args.label} ===")
    print(f"os.cpu_count(): {cpu_count}")
    print(f"data per thread: {DATA_PER_THREAD_MB} MB")
    print()

    single_thread_mb_s = None
    for n in thread_counts:
        result = run_config(n)
        if n == 1:
            single_thread_mb_s = result["aggregate_mb_s"]
        scaling = f"{result['aggregate_mb_s'] / single_thread_mb_s:.2f}x" if single_thread_mb_s else "n/a"
        print(
            f"threads={n:<3} total={result['total_mb']}MB  wall={result['wall_seconds']:.3f}s  "
            f"aggregate={result['aggregate_mb_s']:.1f} MB/s  vs-1-thread={scaling}  "
            f"per_thread_seconds={result['per_thread_seconds']}"
        )

    print()
    print(f"=== end {args.label} ===")


if __name__ == "__main__":
    main()
