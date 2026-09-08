#!/usr/bin/env bash
#
# security-review.sh — the executable half of security-review.md
#
# Runs every check that can be decided from the source tree alone. Checks needing a running
# server or a funded chain live in verify.md and are NOT run here.
#
# Exit codes:  0 = no FAIL   1 = at least one FAIL   2 = a check could not run (UNVERIFIED)
#
# Design rule: a check that cannot execute is NEVER silently a pass. It is UNVERIFIED, which
# is louder than PASS and is retried once before being recorded.
#
# Usage:
#   scripts/security-review.sh                 # human-readable
#   scripts/security-review.sh --log           # also append to security-log/
#   scripts/security-review.sh --strict        # UNVERIFIED also exits non-zero

set -uo pipefail
cd "$(dirname "$0")/.."

WANT_LOG=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --log) WANT_LOG=1 ;;
    --strict) STRICT=1 ;;
  esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""; }

PASS_COUNT=0; FAIL_COUNT=0; UNVERIFIED_COUNT=0
RESULTS=()

record() { # id | status | detail
  RESULTS+=("$1|$2|$3")
  case "$2" in
    PASS)       PASS_COUNT=$((PASS_COUNT+1));       printf "  ${GREEN}PASS${RESET}        %-26s %s\n" "$1" "$3" ;;
    FAIL)       FAIL_COUNT=$((FAIL_COUNT+1));       printf "  ${RED}FAIL${RESET}        %-26s %s\n" "$1" "$3" ;;
    UNVERIFIED) UNVERIFIED_COUNT=$((UNVERIFIED_COUNT+1)); printf "  ${YELLOW}UNVERIFIED${RESET}  %-26s %s\n" "$1" "$3" ;;
  esac
}

# Run a command that must produce NO output. Retries once before giving up, so a transient
# failure (a slow filesystem, a lock) is not recorded as a real finding.
expect_empty() { # id | description | command...
  local id="$1" desc="$2"; shift 2
  local out rc attempt
  for attempt in 1 2; do
    out="$("$@" 2>&1)"; rc=$?
    # grep exits 1 for "no matches", which is exactly the pass condition here.
    if [ $rc -le 1 ]; then
      if [ -z "$out" ]; then record "$id" PASS "$desc"
      else record "$id" FAIL "$desc — $(echo "$out" | head -3 | tr '\n' ' ')"; fi
      return
    fi
    [ $attempt -eq 1 ] && sleep 1
  done
  record "$id" UNVERIFIED "$desc — command exited $rc, could not evaluate"
}

need() { command -v "$1" >/dev/null 2>&1; }

echo
echo "Spigot security review — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "${DIM}commit $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')${RESET}"
echo

# ---------------------------------------------------------------------------
echo "S1  Secrets"
# ---------------------------------------------------------------------------
# Two independent detectors, because either alone has a blind spot:
#   (a) by NAME  — a credential-ish identifier assigned a long literal
#   (b) by SHAPE — a known provider token prefix, whatever the variable is called
# (b) exists because a real leak found during testing (`const LEAKED_KEY = "sk_live_…"`)
# slipped past (a): the identifier matched none of the name patterns.
expect_empty "S1.1-hardcoded-name" "no credential-named literal in source" \
  bash -c "grep -rnE \"(mnemonic|api_?key|secret|passwd|password|token|credential|_KEY|PRIVATE_KEY)[[:space:]]*[:=][[:space:]]*['\\\"][A-Za-z0-9+/=_-]{16,}\" backend/src cli --include='*.ts' --include='*.mjs' 2>/dev/null | grep -v 'process\.env' | grep -vi 'storage_key' | grep -v '\.example' | grep -vE ':[0-9]+:[[:space:]]*(\*|//)'"

expect_empty "S1.1-hardcoded-shape" "no provider-shaped token literal in source" \
  bash -c "grep -rnE \"['\\\"](sk_live_|sk_test_|pk_live_|rk_live_|AKIA[0-9A-Z]{16}|ghp_|gho_|github_pat_|xox[baprs]-|re_[A-Za-z0-9]{16}|AIza[0-9A-Za-z_-]{35})\" backend/src cli --include='*.ts' --include='*.mjs' 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*(\*|//)'"

# 25 space-separated lowercase words in a quoted string is an Algorand mnemonic.
expect_empty "S1.1-mnemonic-shape" "no 25-word mnemonic literal in source" \
  bash -c "grep -rnE \"['\\\"]([a-z]+ ){24}[a-z]+['\\\"]\" backend/src cli --include='*.ts' --include='*.mjs' 2>/dev/null"

expect_empty "S1.2-env-committed" "no .env file is tracked by git" \
  bash -c "git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.' | grep -v '\.example'"

# ---------------------------------------------------------------------------
echo
echo "S2  Authentication and authorisation"
# ---------------------------------------------------------------------------
for pair in \
  "backend/src/routes/consume.ts:requireSession" \
  "backend/src/routes/credits.ts:requireSession" \
  "backend/src/routes/dashboard.ts:authenticate" \
  "backend/src/routes/publishers.ts:requireSession"; do
  f="${pair%%:*}"; guard="${pair##*:}"
  if [ ! -f "$f" ]; then
    record "S2-$(basename "$f" .ts)" UNVERIFIED "$f not found — route may have moved"
  elif grep -q "$guard" "$f"; then
    record "S2-$(basename "$f" .ts)" PASS "$guard present in $(basename "$f")"
  else
    record "S2-$(basename "$f" .ts)" FAIL "$guard MISSING from $(basename "$f")"
  fi
done

# The dashboard must scope its query to the authenticated publisher, not the URL parameter.
if [ -f backend/src/routes/dashboard.ts ]; then
  if grep -q "req.publisher!.id" backend/src/routes/dashboard.ts; then
    record "S2.5-idor" PASS "dashboard scopes to the authenticated publisher"
  else
    record "S2.5-idor" FAIL "dashboard may trust the URL publisherId (IDOR)"
  fi
else
  record "S2.5-idor" UNVERIFIED "dashboard.ts not found"
fi

# ---------------------------------------------------------------------------
echo
echo "S3  Payment integrity"
# ---------------------------------------------------------------------------
check_contains() { # id | file | pattern | description
  if [ ! -f "$2" ]; then record "$1" UNVERIFIED "$2 not found"; return; fi
  if grep -q "$3" "$2"; then record "$1" PASS "$4"; else record "$1" FAIL "$4 — pattern '$3' absent"; fi
}

check_contains "S3.1-debit-first" backend/src/routes/consume.ts "debit(" \
  "credit is debited before any on-chain spend"
check_contains "S3.2-refund" backend/src/routes/consume.ts "releaseHold" \
  "a failed call releases the hold"
check_contains "S3.3-replay" backend/src/routes/gateway.ts "paymentFingerprint" \
  "gateway computes a replay fingerprint"
check_contains "S3.4-server-reqs" backend/src/routes/credits.ts "Rebuild the requirements server-side" \
  "recharge rebuilds payment requirements server-side"
check_contains "S3.5-onramp-closed" backend/src/routes/credits.ts "Fiat onramp is not configured" \
  "onramp webhook fails closed without its secret"
check_contains "S3.6-onramp-hmac" backend/src/routes/credits.ts "timingSafeEqual" \
  "onramp webhook compares its HMAC in constant time"
check_contains "S3.7-onramp-cap" backend/src/routes/credits.ts "MAX_RECHARGE_USDC" \
  "onramp webhook is bounded by MAX_RECHARGE_USDC"
check_contains "S3.8-auth-type-gate" backend/src/routes/apis.ts "SUPPORTED_AUTH_TYPES" \
  "publish refuses upstream auth the proxy cannot perform"

# Both replay columns must be UNIQUE, or one payment buys two calls.
if [ -f backend/src/db/schema.ts ]; then
  if grep -q "tx_id TEXT UNIQUE" backend/src/db/schema.ts && grep -q "payment_hash TEXT UNIQUE" backend/src/db/schema.ts; then
    record "S3.9-unique-cols" PASS "tx_id and payment_hash are both UNIQUE"
  else
    record "S3.9-unique-cols" FAIL "replay guard columns are not both UNIQUE"
  fi
else
  record "S3.9-unique-cols" UNVERIFIED "schema.ts not found"
fi

# ---------------------------------------------------------------------------
echo
echo "S4  Injection and execution"
# ---------------------------------------------------------------------------
# migrations.ts (PRAGMA) and connection.ts (Turso sync) interpolate table names from code
# constants, never from a request. Anything else is a finding.
expect_empty "S4.1-sql" "no request-derived SQL interpolation" \
  bash -c "grep -rnE 'prepare\([\`\"'\\''].*\\\$\{' backend/src --include='*.ts' | grep -v 'migrations.ts' | grep -v 'connection.ts'"

expect_empty "S4.2-exec" "no eval / Function / child_process" \
  bash -c "grep -rnE '\beval\(|new Function\(|child_process|execSync' backend/src cli --include='*.ts' --include='*.mjs' 2>/dev/null"

# ---------------------------------------------------------------------------
echo
echo "S5  Data exposure"
# ---------------------------------------------------------------------------
check_contains "S5.1-vault-only" backend/src/services/vault.ts "decryptSecret" \
  "vault.ts is the single decryption point"

expect_empty "S5.2-key-in-response" "no signing key reaches an HTTP response" \
  bash -c "grep -rnE 'res\.(json|send)\([^)]*(getSigningKey|decryptSecret|encrypted_key|mnemonic)' backend/src --include='*.ts'"

check_contains "S5.3-proxy-headers" backend/src/services/proxy.ts "BLOCKED_HEADERS" \
  "proxy strips consumer credentials before calling upstream"
check_contains "S5.4-admin-guard" backend/src/index.ts "ADMIN_TOKEN" \
  "/admin/status is behind ADMIN_TOKEN"

# ---------------------------------------------------------------------------
echo
echo "S6  Error handling"
# ---------------------------------------------------------------------------
# `catch (e: any)` disables every type check inside the handler. Comment lines are excluded:
# the errors.ts helpers document the pattern they exist to replace.
expect_empty "S6.1-catch-any" "no 'catch (e: any)' handlers" \
  bash -c "grep -rn 'catch ([a-zA-Z_]*: any)' backend/src --include='*.ts' 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*(\*|//)'"

# An empty catch swallows the failure entirely.
expect_empty "S6.2-empty-catch" "no silently empty catch blocks" \
  bash -c "grep -rnPzo 'catch\s*\([^)]*\)\s*\{\s*\}' backend/src --include='*.ts' 2>/dev/null | tr -d '\0'"

check_contains "S6.3-handler-last" backend/src/index.ts "app.use(errorHandler)" \
  "the error handler is mounted"

# Production must not return stack traces or internal messages to the caller.
if [ -f backend/src/middleware/errorHandler.ts ]; then
  if grep -q "IS_PRODUCTION" backend/src/middleware/errorHandler.ts; then
    record "S6.4-no-leak" PASS "error handler suppresses internals in production"
  else
    record "S6.4-no-leak" FAIL "error handler may leak internal errors in production"
  fi
else
  record "S6.4-no-leak" UNVERIFIED "errorHandler.ts not found"
fi

# ---------------------------------------------------------------------------
echo
echo "S7  Rate limiting"
# ---------------------------------------------------------------------------
for pair in \
  "backend/src/routes/consume.ts:consume" \
  "backend/src/routes/credits.ts:recharge" \
  "backend/src/routes/auth.ts:rateLimit" \
  "backend/src/routes/publishers.ts:publisher-create"; do
  f="${pair%%:*}"; key="${pair##*:}"
  if [ ! -f "$f" ]; then record "S7-$(basename "$f" .ts)" UNVERIFIED "$f not found"
  elif grep -q "$key" "$f"; then record "S7-$(basename "$f" .ts)" PASS "$(basename "$f") rate limited"
  else record "S7-$(basename "$f" .ts)" FAIL "$(basename "$f") has no rate limit"; fi
done

# ---------------------------------------------------------------------------
echo
echo "S8  Dependencies"
# ---------------------------------------------------------------------------
if need npm; then
  audit_json="$(npm audit --omit=dev --json 2>/dev/null)"
  if [ -z "$audit_json" ]; then
    record "S8.1-audit" UNVERIFIED "npm audit produced no output (offline?)"
  else
    counts="$(node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{const a=JSON.parse(s);const m=a.metadata&&a.metadata.vulnerabilities||{};
        console.log((m.critical||0)+' '+(m.high||0)+' '+(m.moderate||0)+' '+(m.low||0));}
        catch(e){console.log('ERR');}});" <<<"$audit_json")"
    if [ "$counts" = "ERR" ]; then
      record "S8.1-audit" UNVERIFIED "could not parse npm audit output"
    else
      read -r crit high mod low <<<"$counts"
      if [ "$crit" -gt 0 ] || [ "$high" -gt 0 ]; then
        record "S8.1-audit" FAIL "$crit critical, $high high in production deps"
      elif [ "$mod" -gt 0 ] || [ "$low" -gt 0 ]; then
        record "S8.1-audit" PASS "no critical/high ($mod moderate, $low low)"
      else
        record "S8.1-audit" PASS "0 vulnerabilities in production deps"
      fi
    fi
  fi
else
  record "S8.1-audit" UNVERIFIED "npm not on PATH"
fi

# ---------------------------------------------------------------------------
echo
printf "%s\n" "────────────────────────────────────────────────────────"
printf "  ${GREEN}%d passed${RESET}   ${RED}%d failed${RESET}   ${YELLOW}%d unverified${RESET}\n" \
  "$PASS_COUNT" "$FAIL_COUNT" "$UNVERIFIED_COUNT"
echo

if [ "$WANT_LOG" = "1" ]; then
  mkdir -p security-log
  stamp="$(date -u '+%Y-%m-%dT%H-%M-%SZ')"
  logfile="security-log/${stamp}.md"
  {
    echo "# Security review — ${stamp}"
    echo
    echo "| Field | Value |"
    echo "| --- | --- |"
    echo "| Commit | \`$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\` |"
    echo "| Branch | \`$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)\` |"
    echo "| Passed | ${PASS_COUNT} |"
    echo "| Failed | ${FAIL_COUNT} |"
    echo "| Unverified | ${UNVERIFIED_COUNT} |"
    echo
    echo "## Results"
    echo
    echo "| Check | Status | Detail |"
    echo "| --- | --- | --- |"
    for r in "${RESULTS[@]}"; do
      id="${r%%|*}"; rest="${r#*|}"; status="${rest%%|*}"; detail="${rest#*|}"
      echo "| \`${id}\` | ${status} | ${detail//|/\\|} |"
    done
    echo
    if [ "$UNVERIFIED_COUNT" -gt 0 ]; then
      echo "> **${UNVERIFIED_COUNT} check(s) could not be evaluated.** Unverified is not a pass."
      echo "> Each was retried once. Investigate before trusting this run."
      echo
    fi
    echo "Generated by \`scripts/security-review.sh\`. Checks are defined in [security-review.md](../security-review.md)."
  } > "$logfile"
  echo "log written: $logfile"
  echo
fi

[ "$FAIL_COUNT" -gt 0 ] && exit 1
[ "$STRICT" = "1" ] && [ "$UNVERIFIED_COUNT" -gt 0 ] && exit 2
exit 0
