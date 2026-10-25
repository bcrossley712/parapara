#!/usr/bin/env bash
# tests/sandbox-setup.sh — Claude sandbox only; never run in CI.
#
# The sandbox preinstalls a Chromium build in /opt/pw-browsers that is
# usually newer than the one the pinned @playwright/test expects, and
# newer builds also moved the executables to different inner folders
# (chrome-linux64/, chrome-headless-shell-linux64/). This links the
# newest preinstalled build under the folder names and paths the pinned
# version looks for. Safe to rerun: does nothing if they already exist.
#
# Usage (after `npm install`):
#   bash tests/sandbox-setup.sh
#   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e
#
# A sandbox run is a pre-check; CI's pinned image is the real check
# (PROJECT_NOTES.md → Testing).

set -euo pipefail

ROOT="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BROWSERS_JSON="$REPO/node_modules/playwright-core/browsers.json"

if [ ! -f "$BROWSERS_JSON" ]; then
  echo "Run npm install first (no $BROWSERS_JSON)." >&2
  exit 1
fi

# The revision the pinned Playwright wants for a browser name.
want() {
  node -e "const b=require(process.argv[1]).browsers.find(x=>x.name===process.argv[2]);process.stdout.write(b?b.revision:'')" \
    "$BROWSERS_JSON" "$1"
}

# The newest preinstalled folder matching a prefix (e.g. chromium-),
# ignoring anything that is itself one of our links.
newest() {
  local prefix="$1" best="" bestrev=0 dir rev
  for dir in "$ROOT"/"$prefix"[0-9]*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] || continue
    rev="${dir##*-}"
    if [ "$rev" -gt "$bestrev" ] 2>/dev/null; then best="$dir"; bestrev="$rev"; fi
  done
  printf '%s' "$best"
}

# The first existing executable among candidate paths inside a build.
find_exe() {
  local dir="$1"; shift
  local rel
  for rel in "$@"; do
    if [ -x "$dir/$rel" ]; then printf '%s' "$dir/$rel"; return; fi
  done
}

# link <playwright name> <folder prefix> <expected rel path> <candidate rel paths...>
link() {
  local name="$1" prefix="$2" expect_rel="$3"; shift 3
  local rev target src exe
  rev="$(want "$name")"
  if [ -z "$rev" ]; then echo "No $name entry in browsers.json." >&2; exit 1; fi
  target="$ROOT/${prefix}${rev}"

  if [ -x "$target/$expect_rel" ]; then
    echo "$name $rev: already in place."
    return
  fi

  src="$(newest "$prefix")"
  if [ -z "$src" ]; then echo "No preinstalled ${prefix}* build in $ROOT." >&2; exit 1; fi
  exe="$(find_exe "$src" "$@")"
  if [ -z "$exe" ]; then echo "No executable found in $src." >&2; exit 1; fi

  mkdir -p "$target/$(dirname "$expect_rel")"
  # Link every file next to the executable too (resources, .pak, icu),
  # so the binary finds them beside its expected path.
  local exedir f
  exedir="$(dirname "$exe")"
  for f in "$exedir"/* ; do
    ln -sfn "$f" "$target/$(dirname "$expect_rel")/$(basename "$f")"
  done
  ln -sfn "$exe" "$target/$expect_rel"
  for f in INSTALLATION_COMPLETE DEPENDENCIES_VALIDATED; do
    [ -e "$src/$f" ] && cp -f "$src/$f" "$target/$f"
  done
  echo "$name $rev: linked to $(basename "$src")."
}

link chromium chromium- chrome-linux/chrome \
  chrome-linux/chrome chrome-linux64/chrome
link chromium-headless-shell chromium_headless_shell- chrome-linux/headless_shell \
  chrome-linux/headless_shell chrome-headless-shell-linux64/chrome-headless-shell

echo "Done. Run e2e with PLAYWRIGHT_BROWSERS_PATH=$ROOT"
