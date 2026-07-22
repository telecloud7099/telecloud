#!/usr/bin/env bash
# Phase 9 functional check (docs/FUNCTIONAL_TEST_MATRIX.md items 7-8).
#
# Automates the two functional-matrix checks that don't require live Telegram OTP
# interaction: Range-request video seeking, and thumbnail persistence across a
# normal container restart. Everything else in the matrix (login, folders, uploads,
# downloads) stays a manual walkthrough — see docs/FUNCTIONAL_TEST_MATRIX.md.
#
# Requires a real file_id and a JWT from a logged-in browser session (DevTools ->
# the stored token, or the Authorization header on any authenticated request) — this
# script can't log in on its own. Use a single, non-chunked video file for the Range
# test to avoid chunked-file Range complexity (that's Phase 11 territory).
#
# Usage: ./phase9_functional_check.sh <base_url> <file_id> <token>
#   e.g.  ./phase9_functional_check.sh http://127.0.0.1:80 3f2a1c9e-... eyJhbGciOiJIUzI1NiIs...

set -uo pipefail

BASE="${1:?Usage: $0 <base_url> <file_id> <token>}"
FILE_ID="${2:?Usage: $0 <base_url> <file_id> <token>}"
TOKEN="${3:?Usage: $0 <base_url> <file_id> <token>}"

PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $desc (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

health_check() {
  for _ in $(seq 1 10); do
    if curl -sf "$BASE/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

echo "== Item 7: Range-request video seeking =="
range_headers="$(mktemp)"
range_body="$(mktemp)"
curl -s -D "$range_headers" -o "$range_body" \
  -H "Range: bytes=100-199" \
  "$BASE/file/$FILE_ID?token=$TOKEN"

status="$(head -1 "$range_headers" | grep -oE '[0-9]{3}' | head -1)"
check "Range request returns 206 Partial Content" "206" "${status:-<none>}"

content_range="$(grep -i '^Content-Range:' "$range_headers" | tr -d '\r')"
if echo "$content_range" | grep -qE 'bytes 100-199/'; then
  echo "PASS: Content-Range header matches requested range ($content_range)"
  PASS=$((PASS + 1))
else
  echo "FAIL: Content-Range header missing or wrong (got: ${content_range:-<none>})"
  FAIL=$((FAIL + 1))
fi

body_size="$(wc -c < "$range_body" | tr -d ' ')"
check "response body is exactly 100 bytes" "100" "$body_size"
rm -f "$range_headers" "$range_body"

echo
echo "== Item 8: thumbnail persistence across a normal container restart =="
thumb1="$(mktemp)"
thumb2="$(mktemp)"

if ! curl -sf -o "$thumb1" "$BASE/thumbnail/$FILE_ID?token=$TOKEN"; then
  echo "FAIL: could not fetch thumbnail before restart — check file_id/token"
  FAIL=$((FAIL + 1))
else
  hash1="$(sha256sum "$thumb1" | awk '{print $1}')"
  echo "Thumbnail hash before restart: $hash1"

  echo "Restarting telecloud-app (normal restart, not a kill)..."
  docker compose restart telecloud-app

  if ! health_check; then
    echo "FAIL: telecloud-app did not become healthy again after restart"
    FAIL=$((FAIL + 1))
  else
    if ! curl -sf -o "$thumb2" "$BASE/thumbnail/$FILE_ID?token=$TOKEN"; then
      echo "FAIL: could not fetch thumbnail after restart"
      FAIL=$((FAIL + 1))
    else
      hash2="$(sha256sum "$thumb2" | awk '{print $1}')"
      echo "Thumbnail hash after restart:  $hash2"
      check "thumbnail content identical before/after restart (bind mount persists)" "$hash1" "$hash2"
    fi
  fi
fi
rm -f "$thumb1" "$thumb2"

echo
echo "== Summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
