#!/usr/bin/env bash
# TELECLOUD_JWT=<token> run_suite.sh <label> [sizes_gb] [range_start] [range_end]
#
# Generic transfer-performance benchmark suite -- not specific to any one
# change. Captures exact environment metadata, runs upload/download timing
# for each requested file size, a resume-after-interruption test, a
# Range-request test, resource monitoring throughout, and a FloodWaitError
# log check. Saves all raw data (not just summaries) so results are
# independently reviewable and reproducible. Run once per configuration
# being compared (e.g. once on `main`, once on a change branch), same VM,
# same day -- see compare.py to diff two runs afterward.
#
# The auth token is read ONLY from the TELECLOUD_JWT environment variable,
# never as a CLI argument -- a positional argument would land in this
# process's argv, visible to any local user via `ps aux` (confirmed the hard
# way: it leaked into a shared terminal transcript this way). An env var set
# via `export` doesn't appear in `ps aux`.
#
# sizes_gb: space-separated list of file sizes in GB to test, default "2".
# Pass e.g. "2 10" for a larger stress-test pass later.
# range_start/range_end default to a range spanning 83886080 bytes (80MB),
# a value relevant to the chunk-size change this suite was first built for;
# pass different values for other purposes. The Range test runs against the
# largest size in sizes_gb.
set -uo pipefail

LABEL="${1:?Usage: TELECLOUD_JWT=<token> $0 <label> [sizes_gb] [range_start] [range_end]}"
TOKEN="${TELECLOUD_JWT:?TELECLOUD_JWT env var must be set (never pass the token as a CLI argument)}"
SIZES_GB="${2:-2}"
RANGE_START="${3:-83886000}"
RANGE_END="${4:-83886200}"

# curl's -H puts the header value in curl's own argv (briefly visible via `ps
# aux` while that curl call runs) -- routed through a private config file
# instead, same reasoning as TOKEN being env-var-only above.
AUTH_CONF=$(mktemp)
chmod 600 "$AUTH_CONF"
echo "header = \"Authorization: Bearer $TOKEN\"" > "$AUTH_CONF"
trap 'rm -f "$AUTH_CONF"' EXIT

APP_DIR="/opt/telecloud/app"
BENCH_ROOT="/opt/telecloud/bench"
RUN_DIR="$BENCH_ROOT/$LABEL"
RAW_DIR="$RUN_DIR/raw"
ANOMALY_LOG="$RUN_DIR/anomalies.log"
SUMMARY="$RUN_DIR/summary.json"

mkdir -p "$RAW_DIR"
: > "$ANOMALY_LOG"

log() { echo "$(date -Iseconds) $*"; }
anomaly() { echo "$(date -Iseconds) ANOMALY [$1]: $2" | tee -a "$ANOMALY_LOG"; }

# ── 1. Environment capture (before anything runs) ──────────────────────────
cd "$APP_DIR"
{
  echo "{"
  echo "  \"label\": \"$LABEL\","
  echo "  \"timestamp\": \"$(date -Iseconds)\","
  echo "  \"git_commit\": \"$(git log -1 --format=%H)\","
  echo "  \"git_branch\": \"$(git branch --show-current)\","
  echo "  \"git_dirty\": $([ -z "$(git status --short)" ] && echo "false" || echo "true"),"
  echo "  \"app_image_id\": \"$(docker inspect telecloud-app --format '{{.Image}}' 2>/dev/null)\","
  echo "  \"host_cpus\": $(nproc),"
  echo "  \"host_mem_total\": \"$(free -h | awk 'NR==2{print $2}')\","
  echo "  \"sizes_gb\": \"$SIZES_GB\","
  echo "  \"range_test_bytes\": \"${RANGE_START}-${RANGE_END}\""
  echo "}"
} > "$RUN_DIR/environment.json"
cat "$RUN_DIR/environment.json"

# ── Resource monitor (continuous for the whole run, raw output kept) ───────
start_monitor() {
  local name="$1"
  ( while true; do
      { echo "--- $(date -Iseconds) ---"
        docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}'
        echo -n "host loadavg: "; cat /proc/loadavg
      } >> "$RAW_DIR/${name}_resources.log" 2>&1
      sleep 5
    done ) &
  echo $!
}

# ── 2. One upload+download transfer, full raw output kept ──────────────────
run_transfer() {
  local size_label="$1" file_path="$2"
  log "--- $size_label transfer ---"
  local mon_pid; mon_pid=$(start_monitor "$size_label")

  local up_log="$RAW_DIR/${size_label}_upload.log"
  TELECLOUD_JWT="$TOKEN" python3 phase10_upload_benchmark.py "$file_path" --label "${LABEL}-${size_label}" > "$up_log" 2>&1
  local up_status=$?
  local file_id; file_id=$(grep -oE 'file_id: [a-f0-9-]+' "$up_log" | head -1 | cut -d' ' -f2)

  if [ "$up_status" -ne 0 ] || [ -z "$file_id" ]; then
    anomaly "$size_label" "upload failed or no file_id produced (exit=$up_status) -- see $up_log"
    kill "$mon_pid" 2>/dev/null
    echo ""
    return
  fi
  log "$size_label file_id=$file_id"

  local dl_path="$RAW_DIR/${size_label}_downloaded.bin"
  local dl_timing="$RAW_DIR/${size_label}_download_timing.txt"
  curl -s -K "$AUTH_CONF" \
    -w "http_code=%{http_code} time_total=%{time_total} time_starttransfer=%{time_starttransfer} speed_download=%{speed_download} size_download=%{size_download}\n" \
    "http://localhost/file/$file_id?download=true" -o "$dl_path" > "$dl_timing" 2>&1
  cat "$dl_timing"

  local src_hash dl_hash
  src_hash=$(sha256sum "$file_path" | cut -d' ' -f1)
  dl_hash=$(sha256sum "$dl_path" | cut -d' ' -f1)
  if [ "$src_hash" != "$dl_hash" ]; then
    anomaly "$size_label" "checksum mismatch src=$src_hash dl=$dl_hash"
  fi
  echo "$size_label checksum_match=$([ "$src_hash" = "$dl_hash" ] && echo true || echo false)" >> "$RUN_DIR/checksums.txt"

  kill "$mon_pid" 2>/dev/null
  rm -f "$dl_path"
  echo "$file_id"
}

LARGEST_GB=0
LARGEST_FILE_ID=""
LARGEST_FILE_PATH=""
FILE_IDS=""
for gb in $SIZES_GB; do
  size_label="${gb}gb"
  file_path="$BENCH_ROOT/test_${size_label}.bin"
  fallocate -l "${gb}G" "$file_path"
  file_id=$(run_transfer "$size_label" "$file_path")
  FILE_IDS="$FILE_IDS $size_label=$file_id"
  if [ "$gb" -ge "$LARGEST_GB" ]; then
    LARGEST_GB="$gb"
    LARGEST_FILE_ID="$file_id"
    LARGEST_FILE_PATH="$file_path"
  fi
done

# ── 3. Range request (against the largest size tested) ─────────────────────
log "--- Range request test ---"
if [ -n "$LARGEST_FILE_ID" ]; then
  curl -s -o /dev/null -D "$RAW_DIR/range_test_headers.txt" \
    -w "http_code=%{http_code} time_total=%{time_total} size_download=%{size_download}\n" \
    -K "$AUTH_CONF" -H "Range: bytes=${RANGE_START}-${RANGE_END}" \
    "http://localhost/file/$LARGEST_FILE_ID" > "$RAW_DIR/range_test_timing.txt" 2>&1
  cat "$RAW_DIR/range_test_timing.txt"
  RANGE_CODE=$(grep -oE 'http_code=[0-9]+' "$RAW_DIR/range_test_timing.txt" | cut -d= -f2)
  [ "$RANGE_CODE" = "206" ] || anomaly "range" "expected HTTP 206, got $RANGE_CODE"
else
  anomaly "range" "skipped -- no file_id available to test against"
fi

# ── 4. Resume-after-interruption (against the largest size tested) ─────────
log "--- Resume-after-interruption test ---"
RESUME_LOG="$RAW_DIR/resume_upload.log"
TELECLOUD_JWT="$TOKEN" python3 phase10_upload_benchmark.py "$LARGEST_FILE_PATH" --label "${LABEL}-resume" > "$RESUME_LOG" 2>&1 &
RESUME_PID=$!
sleep 8
if ! kill -0 "$RESUME_PID" 2>/dev/null; then
  anomaly "resume" "upload process for resume test finished before the interrupt point -- file too small or too fast for this VM, rerun with a larger delay or file"
else
  docker kill telecloud-app > /dev/null 2>&1
  log "killed telecloud-app mid-upload"
  sleep 2
  docker compose start telecloud-app > /dev/null 2>&1
  log "restarted telecloud-app"
  wait "$RESUME_PID" 2>/dev/null
  RESUME_EXIT=$?
  if [ "$RESUME_EXIT" -ne 0 ] || ! grep -q "file_id:" "$RESUME_LOG"; then
    anomaly "resume" "resume did not complete successfully (exit=$RESUME_EXIT) -- see $RESUME_LOG"
  fi
fi

# ── 5. FloodWaitError check ─────────────────────────────────────────────────
log "--- FloodWaitError check ---"
FLOOD_LOG="$RAW_DIR/floodwait_check.log"
docker compose logs telecloud-app --since 25m > "$RAW_DIR/full_app_logs.log" 2>&1
grep -i "FloodWaitError" "$RAW_DIR/full_app_logs.log" > "$FLOOD_LOG" || true
FLOOD_COUNT=$(wc -l < "$FLOOD_LOG")
[ "$FLOOD_COUNT" -gt 0 ] && anomaly "floodwait" "$FLOOD_COUNT FloodWaitError occurrence(s) found -- see $FLOOD_LOG"

# ── 6. Structured summary ───────────────────────────────────────────────────
{
  echo "{"
  echo "  \"label\": \"$LABEL\","
  echo "  \"file_ids\": \"$(echo "$FILE_IDS" | sed 's/^ //')\","
  echo "  \"flood_wait_error_count\": $FLOOD_COUNT,"
  echo "  \"anomaly_count\": $(wc -l < "$ANOMALY_LOG")"
  echo "}"
} > "$SUMMARY"

for gb in $SIZES_GB; do
  rm -f "$BENCH_ROOT/test_${gb}gb.bin"
done

log "===== Run complete: $LABEL ====="
log "Raw data: $RAW_DIR"
log "Anomalies ($(wc -l < "$ANOMALY_LOG")): $ANOMALY_LOG"
[ -s "$ANOMALY_LOG" ] && cat "$ANOMALY_LOG"
