#!/usr/bin/env bash
# Every mermaid diagram in docs/ must actually render.
#
# WHY IT EXISTS
#
# A diagram that does not parse is invisible in review. It is not a test failure,
# not a type error, and not a visible difference in a diff — GitHub renders an
# error box in place of the picture, and the people most likely to see it are the
# consumers the document was written for.
#
# docs/consuming-drigodb.md shipped that way and nobody noticed:
#
#   Error: Parse error on line 7:
#       participant DB as db-&lt;id&gt;<br/>drigodb-databases
#
# THE TRAP, WHICH IS NOT OBVIOUS
#
# mermaid treats `;` as a statement separator inside a sequence diagram. Any
# semicolon in participant or note text truncates the statement and the rest of
# the sentence is parsed as a diagram instruction. Two natural ways in:
#
#   * an HTML entity — &lt; &gt; &amp; — which is exactly what somebody writes
#     to get `db-<id>` into a label
#   * an ordinary semicolon in an English sentence, which is the house style in
#     this repository's prose
#
# And the error names neither. It reports `Expecting SOLID_ARROW ... got ','` and
# points at a comma several words from the problem, so it is bisected rather than
# read. Three of the four diagrams in docs/diagrams/high-availability.md failed
# this way on the first attempt and were caught only because they were rendered
# by hand before committing.
#
#   scripts/diagram-render-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/versions.env"

if [ -t 1 ]; then GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; RESET='\033[0m'; else GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''; fi
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; }
note() { printf "  ${YELLOW}…${RESET} %s\n" "$1"; }

command -v npx >/dev/null || { echo "npx not found; install Node."; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract every fenced mermaid block, one file per block, named so a failure
# points at the source rather than at a temp path.
python3 - "$ROOT" "$WORK" <<'PY'
import re, sys, pathlib
root, work = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
count = 0
for md in sorted(root.rglob("*.md")):
    if "node_modules" in str(md):
        continue
    rel = md.relative_to(root)
    for i, block in enumerate(re.findall(r"```mermaid\n(.*?)```", md.read_text(), re.S), 1):
        name = str(rel).replace("/", "__") + f".block{i}.mmd"
        (work / name).write_text(block)
        count += 1
print(count)
PY
TOTAL="$(find "$WORK" -name '*.mmd' | wc -l | tr -d ' ')"

echo "▸ Every mermaid block in docs/, rendered"
if [ "$TOTAL" = "0" ]; then
  note "no mermaid blocks found — nothing to check"
  exit 0
fi

# A puppeteer config is needed in CI: the sandbox is unavailable to the runner's
# container and Chrome refuses to start without --no-sandbox.
cat > "${WORK}/puppeteer.json" <<'JSON'
{ "args": ["--no-sandbox", "--disable-dev-shm-usage"] }
JSON

status=0
for f in "$WORK"/*.mmd; do
  src="$(basename "$f" .mmd)"
  src="${src%.block*}"; src="${src//__//}"
  blk="$(basename "$f" .mmd)"; blk="${blk##*.block}"
  if out="$(npx --yes "@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}" \
      -p "${WORK}/puppeteer.json" -i "$f" -o "${f}.svg" 2>&1)" && [ -s "${f}.svg" ]; then
    ok "${src} block ${blk}"
  else
    fail "${src} block ${blk} does not render"
    # mermaid's own words, which name the line even when they misname the cause.
    printf '%s\n' "$out" | grep -iE "^Error|Parse error|Expecting" | head -3 | sed 's/^/      /'
    # The likely culprit, because the message will not say it.
    if grep -q ';' "$f"; then
      printf '      %s\n' "NOTE: this block contains ';', which mermaid treats as a statement separator."
      printf '      %s\n' "      An HTML entity (&lt; &gt; &amp;) counts — that is usually the cause."
      grep -n ';' "$f" | head -3 | sed 's/^/        /'
    fi
    status=1
  fi
done

echo
if [ "$status" = "0" ]; then
  printf "${GREEN}${BOLD}All %s diagrams render.${RESET}\n" "$TOTAL"
else
  printf "${RED}${BOLD}A diagram does not render, and would ship as an error box.${RESET}\n"
fi
exit "$status"
