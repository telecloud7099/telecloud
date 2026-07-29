#!/usr/bin/env bash
# run_suite.sh <label> <token> [range_start] [range_end]
#
# Generic transfer-performance benchmark suite -- not specific to any one
# change. Captures exact environment metadata, runs 2GB + 10GB upload/
# download timing, a resume-after-interruption test, a Range-request test,
# resource monitoring throughout, and a FloodWaitError log check. Saves all
# raw data (not just summaries) so results are independently reviewable and
# reproducible. Run once per configuration being compared (e.g. once on
# `main`, once on a change branch), same VM, same day -- see compare.sh to
# diff two runs afterward.
#
# range_start/range_end default to a range spanning 83886080 bytes (80MB),
# a value relevant to the chunk-size change this suite was first built for;
# pass different values for other purposes.
set -uo pipefail

LABEL="${1:?Usage: $0 <label> <token> [range_start] [range_end]}"
TOKEN="${2:?Usage: $0 <label> <token> [range_start] [range_end]}"
RANGE_START="${3:-83886000}"
RANGE_END="${4:-83886200}"

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
  python3 phase10_upload_benchmark.py "$file_path" --label "${LABEL}-${size_label}" --token "$TOKEN" > "$up_log" 2>&1
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
  curl -s -H "Authorization: Bearer $TOKEN" \
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

fallocate -l 2G "$BENCH_ROOT/test_2gb.bin"
FILE_ID_2GB=$(run_transfer "2gb" "$BENCH_ROOT/test_2gb.bin")

fallocate -l 10G "$BENCH_ROOT/test_10gb.bin"
FILE_ID_10GB=$(run_transfer "10gb" "$BENCH_ROOT/test_10gb.bin")

# ── 3. Range request ────────────────────────────────────────────────────────
log "--- Range request test ---"
if [ -n "$FILE_ID_10GB" ]; then
  curl -s -o /dev/null -D "$RAW_DIR/range_test_headers.txt" \
    -w "http_code=%{http_code} time_total=%{time_total} size_download=%{size_download}\n" \
    -H "Authorization: Bearer $TOKEN" -H "Range: bytes=${RANGE_START}-${RANGE_END}" \
    "http://localhost/file/$FILE_ID_10GB" > "$RAW_DIR/range_test_timing.txt" 2>&1
  cat "$RAW_DIR/range_test_timing.txt"
  RANGE_CODE=$(grep -oE 'http_code=[0-9]+' "$RAW_DIR/range_test_timing.txt" | cut -d= -f2)
  [ "$RANGE_CODE" = "206" ] || anomaly "range" "expected HTTP 206, got $RANGE_CODE"
else
  anomaly "range" "skipped -- no 10gb file_id available"
fi

# ── 4. Resume-after-interruption ────────────────────────────────────────────
log "--- Resume-after-interruption test ---"
RESUME_LOG="$RAW_DIR/resume_upload.log"
python3 phase10_upload_benchmark.py "$BENCH_ROOT/test_2gb.bin" --label "${LABEL}-resume" --token "$TOKEN" > "$RESUME_LOG" 2>&1 &
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
  echo "  \"file_id_2gb\": \"$FILE_ID_2GB\","
  echo "  \"file_id_10gb\": \"$FILE_ID_10GB\","
  echo "  \"flood_wait_error_count\": $FLOOD_COUNT,"
  echo "  \"anomaly_count\": $(wc -l < "$ANOMALY_LOG")"
  echo "}"
} > "$SUMMARY"

rm -f "$BENCH_ROOT/test_2gb.bin" "$BENCH_ROOT/test_10gb.bin"

log "===== Run complete: $LABEL ====="
log "Raw data: $RAW_DIR"
log "Anomalies ($(wc -l < "$ANOMALY_LOG")): $ANOMALY_LOG"
[ -s "$ANOMALY_LOG" ] && cat "$ANOMALY_LOG"
