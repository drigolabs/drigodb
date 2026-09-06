#!/usr/bin/env bash
# The chart must be a pure function of its values.
#
# Render it twice with identical inputs and assert identical bytes. That is the
# whole test, it needs no cluster, and it runs in a second.
#
# WHY IT EXISTS
#
# templates/secret-api-token.yaml used to call Helm's `lookup` to preserve the
# API token across upgrades. `lookup` only resolves against a live cluster, so
# the chart rendered differently depending on who rendered it. Argo CD renders
# with `helm template` and has no cluster context, so it took the random
# fallback on EVERY sync — rotating the bearer token every consumer holds, while
# reporting Synced and healthy, because after applying the new value live
# matches desired and there is nothing left to report.
#
# Removing `lookup` fixed that once. This test is what stops the next one:
# `lookup`, `randAlphaNum`, `now`, `uuidv4`, `randAlphaNum` behind a conditional.
# Any of them fails here rather than in somebody's cluster.
#
#   scripts/chart-determinism-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHART="${ROOT}/charts/drigodb"
if [ -t 1 ]; then GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; RED=''; BOLD=''; RESET=''; fi
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; }

command -v helm >/dev/null || { echo "helm not found"; exit 1; }

# Fixed inputs, so any difference between renders comes from the chart rather
# than from the test.
COMMON=(--namespace drigodb-system --set api.token=fixed-for-this-test)

status=0
render() { helm template drigodb "$CHART" "${COMMON[@]}" "$@"; }

echo "▸ Rendering twice with identical values"
A="$(mktemp)"; B="$(mktemp)"
trap 'rm -f "$A" "$B" "${A}.2" "${B}.2"' EXIT
render > "$A"
render > "$B"
if diff -q "$A" "$B" >/dev/null; then
  ok "byte-identical ($(wc -l < "$A" | tr -d ' ') lines)"
else
  fail "the chart rendered differently twice with the same inputs"
  diff "$A" "$B" | head -20
  status=1
fi

echo "▸ And with the other way of supplying a token"
render2() { helm template drigodb "$CHART" --namespace drigodb-system --set api.existingSecret=my-secret "$@"; }
render2 > "${A}.2"
render2 > "${B}.2"
if diff -q "${A}.2" "${B}.2" >/dev/null; then
  ok "byte-identical with api.existingSecret"
else
  fail "non-deterministic when using an existing Secret"
  diff "${A}.2" "${B}.2" | head -20
  status=1
fi

echo "▸ No template reaches for a cluster or a clock"
# Static, as well as behavioural. Two renders can agree by luck — `now` truncated
# to the day, a lookup against a cluster that happens to be absent both times —
# and this names the mistake at the point someone writes it.
#
# Comment blocks are stripped first. The template that used to call `lookup` now
# carries a paragraph explaining why it must not, and a grep that cannot tell
# those apart fails on its own documentation.
BAD="$(python3 - "$CHART" <<'PYEOF'
import re, sys, pathlib
bad = []
for f in sorted(pathlib.Path(sys.argv[1], "templates").rglob("*")):
    if not f.is_file(): continue
    src = re.sub(r"\{\{-?\s*/\*.*?\*/\s*-?\}\}", "", f.read_text(), flags=re.S)
    for n, line in enumerate(src.split("\n"), 1):
        for fn in ("lookup", "randAlphaNum", "randAlpha", "randNumeric", "randAscii", "uuidv4", "now"):
            if re.search(r"\{\{[^}]*\b" + fn + r"\b", line):
                bad.append(f"{f.name}:{n}: {fn} — {line.strip()[:70]}")
print("\n".join(bad))
PYEOF
)"
if [ -n "$BAD" ]; then
  fail "a template is non-deterministic:"
  printf '%s\n' "$BAD" | sed 's/^/      /'
  status=1
else
  ok "no lookup, no randomness, no clock"
fi

echo "▸ Refusing to invent a credential"
if helm template drigodb "$CHART" --namespace drigodb-system >/dev/null 2>&1; then
  fail "rendered with no token supplied — the chart invented one"
  status=1
else
  ok "no token, no render"
fi

[ "$status" = 0 ] && printf "\n${GREEN}${BOLD}The chart is a pure function of its values.${RESET}\n"
exit "$status"
