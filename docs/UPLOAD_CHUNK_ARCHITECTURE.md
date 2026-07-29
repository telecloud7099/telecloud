# Upload Chunk Size Architecture

Decided 2026-07-29, branch `reduce-chunk-size-cloudflare-compat`. Full design
rationale — the code comments near `FREE_CHUNK_SIZE`/`PREMIUM_CHUNK_SIZE` point here
rather than repeating this in full.

## Why this changed

`FREE_CHUNK_SIZE`/`PREMIUM_CHUNK_SIZE` were originally sized against Telegram's own
per-document cap (2 GiB / 4 GiB), producing single HTTP PUT requests of ~1.9–3.9GB per
chunk. Cloudflare Tunnel — the planned mechanism for exposing this backend to the
internet without a home-router port-forward — enforces a **100MB request-body limit
on Free/Pro plans**, and this applies to **all** Tunnel traffic (Quick or Named), with
no bypass: unlike an ordinary proxied DNS record, there's no "DNS-only" mode for
Tunnel traffic, since Tunnel's entire mechanism depends on being proxied through
Cloudflare's edge. Confirmed via Cloudflare's own Error 413 documentation plus
independent corroboration from real-world reports of the same limit specifically
under `cloudflared` Tunnels — see Sources below. One honest gap: no official source
specifies whether the 100MB figure is decimal or binary bytes.

## Options considered

**Option A (adopted): reduce the chunk size directly.** Each application-level "part"
stays 1:1 with one Telegram document, just smaller.

**Option B (rejected): split HTTP transport from Telegram storage** — upload in small
HTTP chunks, reassemble them backend-side into the original ~1.9GB unit, upload that
reconstructed unit to Telegram unchanged. Preserves today's Telegram message count,
but requires a second, nested chunking layer (a new sub-chunk API, new resume state
for "partially assembled part," new recovery path) — rejected on complexity,
maintainability, and the fact that it provides zero improvement to disk usage or
resume cost, both of which Option A improves for free. See the "Complexity /
Performance / Disk usage / Resume / Telegram API efficiency / Maintainability"
comparison from the design discussion for the full six-axis evaluation; Option B's
sole genuine advantage (Telegram message count) matters most at multi-tenant scale —
TeleCloud is explicitly single-operator.

## Why 80MB specifically (not 50, 64, 75, 90, or 95)

Evaluated the full range. Larger chunks (90–95MB) mean fewer Telegram API calls per
file but shrink the safety margin under the 100MB cap to as little as 5MB — risky
given the unresolved decimal-vs-binary-byte ambiguity above (a 95 MiB chunk is
99,614,720 bytes, only ~385KB under a decimal 100,000,000-byte cutoff). Smaller
chunks (50MB) maximize margin but nearly double the API-call/`FileChunk`-row count
for a given file versus 80MB, with no corresponding benefit once you're already
safely under the cap. **80MB was chosen as the point that keeps ~16-20MB of margin
under either byte-counting convention while keeping per-file Telegram overhead close
to the practical minimum** — not a round-number default.

One consideration pulls slightly the other way, found during the pre-implementation
code audit: `routes/files.py`'s scan-based disaster-recovery path
(`_reconcile_chunk_groups`) only reconstructs a chunked file if every one of its
parts is seen within the bounded `MAX_SCAN_MESSAGES` window (default 2000). More
parts per file marginally raises the odds a very old file's group could straddle
that scan boundary during a from-scratch DB-wipe recovery — a narrow edge case that
argues for fewer/larger parts. Weighed against the margin concern above and judged
non-decisive; noted here rather than silently ignored.

## Backward compatibility

No migration needed. Verified by code, not assumed:
- `chunk_download.py`'s `ChunkPlan` computes offsets from each `FileChunk` row's own
  recorded `size` — never from `FREE_CHUNK_SIZE`/`PREMIUM_CHUNK_SIZE`. Old files with
  ~1.9GB chunks and new files with ~80MB chunks are walked by the identical generic
  loop.
- `FileChunk` rows are immutable historical records; changing the constant has zero
  retroactive effect.
- `UploadSession.chunk_size` is captured once at session-creation time and stored on
  the session row; `_expected_part_size()` reads that stored value, not the live
  constant — a session created before this change keeps behaving as it always would
  if resumed.
- **One real edge case**: a session created *before* this change, left paused, and
  resumed *after* it (e.g., through Cloudflare Tunnel) would still attempt its
  remaining part(s) at the old, larger size for that session, since that's what's
  stored on the row. Non-issue in practice as of this change (verified zero
  `status='uploading'` sessions existed at deployment time), but worth knowing if it
  ever recurs.

## Code paths audited before implementing (no hidden assumptions found)

Upload (`chunk_upload.py`, `upload.py`, `chunkedUpload.ts`), download/streaming/Range
(`chunk_download.py`, `files.py`'s `get_file`), resume/session logic
(`upload_sessions.py`, `serverHasPart`/`waitForPartConfirmed`), DB queries
(`get_file_chunks_ordered` — no `LIMIT` clause), nginx config, and the scan-based
disaster-recovery path (`_full_scan`/`_reconcile_chunk_groups`). All read part
count/chunk size as live values; nothing hardcodes an expected magnitude.

## Known future optimization, not implemented

`chunk_download.py`'s `stream_full()` resolves each chunk's Telegram media reference
sequentially — `await _get_media(chunk N)` blocks the byte stream before chunk N+1's
lookup even begins. Prefetching the next chunk's media reference concurrently via
`asyncio.create_task()` while the current chunk streams would likely hide most of the
added per-chunk latency from having more, smaller chunks, at near-zero memory cost
(the prefetched value is a lightweight metadata reference, not file bytes). Worth
revisiting if the benchmark suite shows download latency increase is bothersome;
deliberately not implemented as part of this change.

## Benchmark results

See the sign-off log at the end of this document once the benchmark suite (2GB/10GB
upload+download, resume-after-interruption, Range requests, resource utilization,
`FloodWaitError` check) completes — this document's recommendation stands provisional
until that's recorded here.

## Sources consulted

- [Error 413 · Cloudflare Support docs](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)
- [Quick Tunnels · Cloudflare Zero Trust docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
- [Increase Maximum Upload Size - Cloudflare Community](https://community.cloudflare.com/t/increase-maximum-upload-size/175622)
- [100mb tunnel limit - Cloudflare Tunnel - Cloudflare Community](https://community.cloudflare.com/t/100mb-tunnel-limit/901339)
- [Use local DNS Record (Cloudflare Tunnel 100MB Limit Workaround) · immich-app/immich Discussion](https://github.com/immich-app/immich/discussions/13175)
- [RPC Errors — Telethon 1.44.0 documentation](https://docs.telethon.dev/en/stable/concepts/errors.html)
