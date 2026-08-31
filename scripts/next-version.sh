#!/usr/bin/env bash
# Decide the next release version from Conventional Commits.
#
# Prints the version to stdout (no `v` prefix) when the commits since the last
# release warrant one, and prints nothing — exit 0 — when they do not. CI treats
# empty output as "nothing to release", so a branch of `docs:` and `chore:`
# commits merges without minting a version, an image, or a deploy.
#
#   scripts/next-version.sh          what the next release would be
#   scripts/next-version.sh --why    the same, with the commits that decided it
#
# BUMP RULES, AND WHY THEY ARE NOT THE USUAL ONES
#
# Below 1.0.0, SemVer gives the minor position the meaning that major has later:
# it is the axis that is allowed to break. So while the major is 0, a breaking
# change bumps the minor rather than shipping a 1.0.0 nobody decided to declare.
# Reaching 1.0.0 is a deliberate act — tag it by hand — not something a `!` in a
# commit subject does on your behalf.
#
#   major 0        feat / feat! / BREAKING CHANGE  → minor    0.1.0
#                  fix / perf / revert             → patch    0.0.2
#   major >= 1     feat! / BREAKING CHANGE         → major    2.0.0
#                  feat                            → minor    1.1.0
#                  fix / perf / revert             → patch    1.0.1
#
# Anything else — docs, chore, test, refactor, ci, style, build — releases
# nothing on its own, but rides along with the next release that happens.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHY=false
[ "${1:-}" = "--why" ] && WHY=true

# The last release is the newest v-tag, not package.json: tags are what CI
# actually published, and package.json can drift on a branch.
LAST_TAG="$(git -C "$ROOT" tag --list 'v[0-9]*' --sort=-v:refname | head -1)"

if [ -z "$LAST_TAG" ]; then
  # Bootstrap. Nothing has been released, so the version already declared in
  # package.json is the release — tag it as-is rather than bumping past it.
  node -p "require('${ROOT}/package.json').version"
  $WHY && echo "  (no v-tag yet: releasing the version package.json already declares)" >&2
  exit 0
fi

CURRENT="${LAST_TAG#v}"
IFS=. read -r MAJOR MINOR PATCH <<EOF
$CURRENT
EOF

# --no-merges so a merge commit's own subject ("Merge pull request #12 …")
# cannot decide a release; the commits it brings in still count. Squash merges
# are unaffected — their subject is the commit.
SUBJECTS="$(git -C "$ROOT" log --no-merges --format='%s' "${LAST_TAG}..HEAD")"
BODIES="$(git -C "$ROOT" log --no-merges --format='%B' "${LAST_TAG}..HEAD")"

BREAKING=false
FEAT=false
FIX=false

# `type!:` and `type(scope)!:` are the subject form; `BREAKING CHANGE:` the body
# form. Both are Conventional Commits; both are checked.
grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$SUBJECTS" && BREAKING=true
grep -qE '^BREAKING[ -]CHANGE:' <<<"$BODIES" && BREAKING=true
grep -qE '^feat(\([^)]*\))?!?:' <<<"$SUBJECTS" && FEAT=true
grep -qE '^(fix|perf|revert)(\([^)]*\))?!?:' <<<"$SUBJECTS" && FIX=true

if [ "$MAJOR" -eq 0 ]; then
  if $BREAKING || $FEAT; then NEXT="0.$((MINOR + 1)).0"
  elif $FIX;            then NEXT="0.${MINOR}.$((PATCH + 1))"
  else                       NEXT=""
  fi
else
  if $BREAKING;  then NEXT="$((MAJOR + 1)).0.0"
  elif $FEAT;    then NEXT="${MAJOR}.$((MINOR + 1)).0"
  elif $FIX;     then NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))"
  else                NEXT=""
  fi
fi

if $WHY; then
  {
    echo "since ${LAST_TAG}:"
    if [ -z "$SUBJECTS" ]; then
      echo "  (no commits)"
    else
      sed 's/^/  /' <<<"$SUBJECTS"
    fi
    echo "breaking=${BREAKING} feat=${FEAT} fix=${FIX}"
    echo "${CURRENT} -> ${NEXT:-no release}"
  } >&2
fi

[ -n "$NEXT" ] && echo "$NEXT"
exit 0
