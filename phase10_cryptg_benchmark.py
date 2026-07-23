"""Phase 10 diagnostic: pure CPU microbenchmark for cryptg's AES-IGE throughput, with no
network involved at all. Complements phase10_upload_benchmark.py, which measures real
end-to-end Telegram upload speed -- a number that turned out to be dominated by current
network conditions (~47 KB/s observed), nowhere near any plausible CPU ceiling. This script
isolates the other half of the question Phase 10 actually cares about: does cryptg's
encryption throughput itself scale with vCPU count?

Uses cryptg.encrypt_ige(data, key, iv) directly with MTProto-shaped key/IV sizes (32 bytes
each, matching what Telethon's own crypto layer uses) -- not a synthetic stand-in.

First version of this script measured wall-clock time only and was far too noisy to trust
(single-thread throughput swung 102-174 MB/s across 3 back-to-back runs on this VM) --
symptomatic of hypervisor/host scheduling jitter (VirtualBox sharing the physical CPU with
the Windows host), not a real property of cryptg. This version instead:
  - measures each thread's own CPU time via time.thread_time() (POSIX per-thread CPU-seconds
    consumed), which is far less sensitive to a thread simply waiting for a scheduler slot
  - reports "cores_utilized" = sum(per-thread CPU-seconds) / wall-seconds -- the effective
    number of cores that were actually computing at once (should be ~= thread_count if
    cryptg truly parallelizes across threads, ~= 1 if it's GIL-bound/serialized regardless
    of thread count)
  - repeats each thread-count config 3x internally and reports the median, instead of
    relying on the caller to manually re-run the whole script for stability

Tests thread counts 1, 2, and os.cpu_count() (deduplicated) so the *same* script run once
on the 5-vCPU VM and once on the 2-vCPU-capped VM produces directly comparable output.

Usage:
    python3 phase10_cryptg_benchmark.py --label 5vcpu-baseline
    python3 phase10_cryptg_benchmark.py --label 2vcpu
"""
import argparse
import os
import statistics
import threading
import time

import cryptg

MB = 1024 * 1024
DATA_PER_THREAD_MB = 256  # large enough that a single scheduling hiccup doesn't dominate
REPEATS_PER_CONFIG = 3


def worker(nbytes: int, results: list, idx: int) -> None:
    key = os.urandom(32)
    iv = os.urandom(32)
    data = os.urandom(nbytes)
    wall0 = time.perf_counter()
    cpu0 = time.thread_time()
    cryptg.encrypt_ige(data, key, iv)
    results[idx] = (time.perf_counter() - wall0, time.thread_time() - cpu0)


def run_once(thread_count: int) -> dict:
    nbytes = DATA_PER_THREAD_MB * MB
    results = [None] * thread_count
    threads = [threading.Thread(target=worker, args=(nbytes, results, i)) for i in range(thread_count)]

    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0

    total_cpu = sum(r[1] for r in results)
    total_mb = DATA_PER_THREAD_MB * thread_count
    return {
        "wall_seconds": wall,
        "total_cpu_seconds": total_cpu,
        "aggregate_mb_s": total_mb / wall,
        "cores_utilized": total_cpu / wall,
        "per_thread_cpu_seconds": [round(r[1], 3) for r in results],
    }


def run_config(thread_count: int) -> dict:
    runs = [run_once(thread_count) for _ in range(REPEATS_PER_CONFIG)]
    return {
        "thread_count": thread_count,
        "runs": runs,
        "wall_seconds_median": statistics.median(r["wall_seconds"] for r in runs),
        "aggregate_mb_s_median": statistics.median(r["aggregate_mb_s"] for r in runs),
        "cores_utilized_median": statistics.median(r["cores_utilized"] for r in runs),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="run", help="Tag for this run, e.g. 5vcpu-baseline or 2vcpu")
    args = parser.parse_args()

    cpu_count = os.cpu_count()
    thread_counts = sorted(set([1, min(2, cpu_count), cpu_count]))

    print(f"=== Phase 10 cryptg CPU microbenchmark: {args.label} ===")
    print(f"os.cpu_count(): {cpu_count}")
    print(f"data per thread: {DATA_PER_THREAD_MB} MB, {REPEATS_PER_CONFIG} repeats per thread-count")
    print()

    single_thread_mb_s = None
    for n in thread_counts:
        config = run_config(n)
        if n == 1:
            single_thread_mb_s = config["aggregate_mb_s_median"]
        scaling = f"{config['aggregate_mb_s_median'] / single_thread_mb_s:.2f}x" if single_thread_mb_s else "n/a"
        per_run_mb_s = [round(r["aggregate_mb_s"], 1) for r in config["runs"]]
        print(
            f"threads={n:<3} median_aggregate={config['aggregate_mb_s_median']:.1f} MB/s  "
            f"vs-1-thread={scaling}  cores_utilized(median)={config['cores_utilized_median']:.2f}  "
            f"per_run_mb_s={per_run_mb_s}"
        )

    print()
    print("cores_utilized ~= thread_count means cryptg truly parallelizes across threads;")
    print("cores_utilized ~= 1 regardless of thread_count means it's effectively serialized")
    print("(e.g. GIL-bound), and adding/removing vCPUs won't change a single upload's speed.")
    print()
    print(f"=== end {args.label} ===")


if __name__ == "__main__":
    main()
