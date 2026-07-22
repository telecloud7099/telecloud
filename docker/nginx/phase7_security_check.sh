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
# Written to a temp file rather than passed as a command-line argument — a 2MB shell
# argument exceeds the OS's ARG_MAX and makes curl itself fail before sending anything
# (seen in the first run: "Argument list too long"), which is a test-tooling bug, not
# a finding about nginx.
oversized_file="$(mktemp)"
head -c 2000000 /dev/zero | tr '\0' 'a' > "$oversized_file"
oversized=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/send_code" \
  -H "Content-Type: application/json" \
  --data-binary "@${oversized_file}")
rm -f "$oversized_file"
check "oversized body rejected (413, global client_max_body_size)" "413" "$oversized"

badmethod=$(curl -s -o /dev/null -w "%{http_code}" -X TRACE "$BASE/")
check "unsupported HTTP method rejected (405)" "405" "$badmethod"

# --path-as-is is required here: curl normalizes ../ sequences out of the URL itself
# by default, so without this flag the request that actually reaches nginx is just
# "/etc/passwd" (whatever curl decided to collapse the path to), not the raw
# traversal string an actual attacker's HTTP client would send. This is testing what
# nginx/the app do with a literal, un-normalized traversal attempt.
traversal_body="$(curl -s --path-as-is "$BASE/file/../../../../etc/passwd")"
traversal_code=$(curl -s --path-as-is -o /dev/null -w "%{http_code}" "$BASE/file/../../../../etc/passwd")
if echo "$traversal_body" | grep -q "root:.*:0:0:"; then
  echo "FAIL: path-traversal on /file/ returned actual /etc/passwd contents (HTTP $traversal_code)"
  FAIL=$((FAIL + 1))
else
  info "path-traversal probe on /file/ returned HTTP $traversal_code, body does NOT contain /etc/passwd contents (first 80 chars: $(echo "$traversal_body" | head -c 80 | tr -d '\n'))"
fi

echo
echo "== Summary: $PASS passed, $FAIL failed, $INFO informational =="
[ "$FAIL" -eq 0 ]
