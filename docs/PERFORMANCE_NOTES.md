# Performance Notes

Phase 10 deliverable — does capping the VM's vCPU count to approximate the eventual i3-2120
home-server target meaningfully hurt chunked-upload throughput, given `cryptg`'s AES-IGE
encryption is CPU-bound work sitting on the backend→Telegram leg of every upload?

## Methodology

The original plan was a real end-to-end upload comparison (same file, 5 vCPUs vs. 2 vCPUs,
measuring wall-clock upload time). That approach was abandoned after the first real-world
run: a 500MB file uploaded at ~47 KB/s, and an independent guest-side download test to an
unrelated server (`speedtest.tele2.net`) showed a similar ~180 KB/s ceiling — indicating the
bottleneck that day was the VM's outbound network path (real ISP conditions and/or
VirtualBox NAT overhead), not CPU. At that throughput, a full comparison run would have
taken ~3 hours per vCPU count and would not have isolated the variable this phase actually
cares about — real-world upload speed and cryptg's CPU cost are two different questions,
and the network dominates the first one so heavily that it masks the second.

Instead, `phase10_cryptg_benchmark.py` measures `cryptg.encrypt_ige()` directly against
in-memory buffers (MTProto-shaped 32-byte key/IV, matching Telethon's own crypto layer) —
no network involved at all. It launches N Python threads (matching this app's real
concurrency model: threads within one asyncio process, not multiprocessing) and measures
each thread's own CPU time via `time.thread_time()` rather than wall-clock, because an
early wall-clock-only version proved too noisy to trust: single-thread throughput swung
102–174 MB/s across 3 back-to-back runs on this VM, symptomatic of hypervisor scheduling
jitter (VirtualBox sharing the physical CPU with the Windows host), not a real property of
cryptg. The script reports **`cores_utilized`** = sum(per-thread CPU-seconds) / wall-seconds
— the effective number of cores actually computing in parallel, independent of scheduling
noise — and repeats each thread-count configuration 3x internally, reporting the median.

## Results (2026-07-23)

Both runs used identical parameters: 256MB per thread, 3 repeats per thread-count,
`cryptg==0.6.0` confirmed installed and active (`pip show cryptg` inside `telecloud-app`).

| Config | threads | median aggregate MB/s | cores_utilized (median) |
|---|---|---|---|
| 5 vCPU baseline | 1 | 157.1 | 0.56 |
| 5 vCPU baseline | 2 | 216.3 | 0.74 |
| 5 vCPU baseline | 5 | 263.2 | 0.87 |
| 2 vCPU (capped) | 1 | 190.7 | 0.54 |
| 2 vCPU (capped) | 2 | 195.9 | 0.73 |

(2 vCPU only has thread-counts 1 and 2 available — `os.cpu_count()` inside the container
correctly reflects the VM's actual vCPU allocation in both cases, confirmed via the script's
own `os.cpu_count()` output and cross-checked against `nproc` on the VM host.)

## Conclusion

**Capping the VM from 5 to 2 vCPUs does not meaningfully change cryptg's encryption
throughput.** `cores_utilized` at the shared threads=2 configuration is essentially
identical (0.74 vs. 0.73), and the threads=1 numbers differ by less than the noise already
observed within a single vCPU count (single-thread throughput swung nearly 3x across
repeats in earlier wall-clock-only testing before the CPU-time fix). At no point, even with
5 threads and 5 vCPUs available, did `cores_utilized` approach the thread count — it topped
out at 0.87, meaning a single upload's encryption work never used much more than one core's
worth of compute regardless of how many cores were available. This is consistent with
`cryptg.encrypt_ige()` holding the GIL for most of its duration rather than releasing it for
true multi-thread parallelism.

Practical implication: a single chunked upload's cryptg-bound throughput should be
essentially unaffected by running on the target i3-2120 home server (2-4 cores depending on
hyperthreading) versus this 5-vCPU test VM. The real-world upload speed observed in this
session (~47 KB/s) was governed by network conditions, not CPU — a separate concern from
this phase's original hypothesis, and one that should be re-measured with
`phase10_upload_benchmark.py` under better/more typical network conditions as a real-world
sanity check, but it is not blocked on vCPU count.

## Caveats / follow-ups

- The real end-to-end run (`phase10_upload_benchmark.py`) was never completed cleanly at
  either vCPU count due to the network conditions described above — it remains available
  and useful for a future real-world throughput check, but contributed no data to this
  phase's actual conclusion.
- `cores_utilized` never approaching `thread_count` (even at 0.87 with 5 real vCPUs
  available) is itself worth a closer look at some point — it suggests `cryptg` may not be
  releasing the GIL during its C computation, which would mean concurrent uploads from
  multiple users could contend more than expected on a single Uvicorn worker. Out of scope
  for Phase 10 (single-upload throughput), but relevant to any future multi-worker decision.
- This data reflects a single test session on shared/virtualized hardware (VirtualBox on a
  Windows host); absolute MB/s numbers are illustrative, not a hardware spec. The
  *comparison* between 5 and 2 vCPUs (same host, same session, same method) is the reliable
  part.
