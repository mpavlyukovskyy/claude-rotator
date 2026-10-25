#!/usr/bin/env bash
# Setup UI in a real Chromium: starts an isolated dashboard (test/ui-harness.sh) and runs test/ui-browser.js.
# Needs Playwright with Chromium (NODE_PATH pointing at it). Run:
#   bash test/ui-browser.sh <work dir> [port, default 18350]
# Screenshots and results.json land in <work dir>/shots.
# Playwright looks for its browsers under $HOME. If you run this with HOME pointed somewhere else, set
# PLAYWRIGHT_BROWSERS_PATH to the real browser cache (~/.cache/ms-playwright on Linux,
# ~/Library/Caches/ms-playwright on macOS); the test exports it to the browser run.
set -u; cd "$(dirname "$0")/.."
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  [ -d "$PLAYWRIGHT_BROWSERS_PATH" ] || { echo "ui-browser: PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH is not a directory" >&2; exit 1; }
  export PLAYWRIGHT_BROWSERS_PATH
elif [ ! -d "$HOME/.cache/ms-playwright" ] && [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  echo "ui-browser: no Playwright browsers under $HOME. If HOME is overridden, set PLAYWRIGHT_BROWSERS_PATH." >&2
fi
REPO=$PWD; W="${1:?usage: ui-browser.sh <work dir> [port]}"; P="${2:-18350}"
. test/ui-harness.sh
rm -rf "$W/env"; mkdir -p "$W/shots"
curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$P/" && { echo "port $P is in use" >&2; exit 1; }
ui_prepare "$W/env" "$P" "$REPO" || exit 1
trap 'ui_stop' EXIT
ui_start || exit 1
UI_URL="http://127.0.0.1:$P" OUT="$W/shots" GW_KEY="gwkey-TEST-0123456789abcdef0123456789abcdef" node "$REPO/test/ui-browser.js"
