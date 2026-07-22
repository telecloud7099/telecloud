#!/usr/bin/env bash
# Phase 7 security regression check (SECURITY_ARCHITECTURE.md §7 Validation Summary).
#
# Exercises the rate limits, security headers, and a few malformed-request edge cases
# added in Phase 7. Run from the VM guest (or the host via the NAT port-forward) after
# `docker compose up -d --build`.
#
# Does NOT replace the manual 5-point functional matrix (login/list/upload/download/
# resumable upload) from Phase 6 — Telegram OTP can't be scripted here, and a CSP
# violation is only visible in the browser DevTools console, not from curl.
#
# Usage: ./phase7_security_check.sh [base_url]   (default: http://127.0.0.1:8080)

set -uo pipefail
BASE="${1:-http://127.0.0.1:8080}"
PASS=0
FAIL=0
INFO=0

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

info() {
  echo "INFO: $1"
  INFO=$((INFO + 1))
}

echo "Target: $BASE"
echo

echo "== Security headers present on a normal response =="
headers=$(curl -s -o /dev/null -D - "$BASE/")
check "CSP-Report-Only header present" "1" "$(echo "$headers" | grep -ic 'content-security-policy-report-only')"
check "Permissions-Policy header present" "1" "$(echo "$headers" | grep -ic 'permissions-policy')"
check "Cross-Origin-Resource-Policy header present" "1" "$(echo "$headers" | grep -ic 'cross-origin-resource-policy')"
check "X-Content-Type-Options header present" "1" "$(echo "$headers" | grep -ic 'x-content-type-options')"
# Enforcing CSP must NOT be present yet — this phase is Report-Only only.
check "enforcing Content-Security-Policy NOT yet present (still Report-Only)" "0" "$(echo "$headers" | grep -ic '^content-security-policy:')"

echo
echo "== Auth zone rate limiting (expect a 429 within a rapid burst against /send_code) =="
got429="no"
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/send_code" \
    -H "Content-Type: application/json" -d '{"phone":"+10000000000"}')
  if [ "$code" = "429" ]; then got429="yes"; break; fi
done
check "auth zone throttles rapid /send_code requests" "yes" "$got429"

echo
echo "== Malformed request handling =="
oversized=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/send_code" \
  -H "Content-Type: application/json" \
  --data-binary "$(head -c 2000000 /dev/zero | tr '\0' 'a')")
check "oversized body rejected (413, global client_max_body_size)" "413" "$oversized"

badmethod=$(curl -s -o /dev/null -w "%{http_code}" -X TRACE "$BASE/")
check "unsupported HTTP method rejected (405)" "405" "$badmethod"

# Path-traversal probe is informational, not a strict assertion: nginx's own URI
# normalization already rewrites literal ../ sequences before location matching, and
# /file/{file_id} looks the id up as a DB/Telegram reference rather than a raw
# filesystem path — so the expected safe outcome could legitimately show up as a 404
# from nginx, a 404 from the app, or the SPA fallback (200), depending on where the
# request lands. Record what actually happens rather than asserting one exact code.
traversal_code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/file/../../../../etc/passwd")
info "path-traversal probe on /file/ returned $traversal_code (expected: NOT actual file contents; review manually if this looks unexpected)"

echo
echo "== Summary: $PASS passed, $FAIL failed, $INFO informational =="
[ "$FAIL" -eq 0 ]
