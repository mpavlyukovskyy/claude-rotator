#!/usr/bin/env bash
# Builds "Claude Dashboard.app", a native macOS window on the local claude-rotator dashboard.
# Needs Xcode or the Command Line Tools (xcrun swiftc).
#   ./build.sh
# Env: CLAUDE_DASHBOARD_URL (default http://127.0.0.1:<port from accounts.json>/),
#      CLAUDE_USAGE_LABEL (launchd label the app restarts when the dashboard is down, default local.claude-usage),
#      CLAUDE_DASHBOARD_APP_DIR (where the .app goes, default ~/Applications),
#      CLAUDE_DASHBOARD_BUNDLE_ID (default local.claude-rotator.dashboard).
set -euo pipefail
cd "$(dirname "$0")"
DATA="${CLAUDE_USAGE_DATA:-$HOME/.local/share/claude-usage}"
PORT=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||7788)}catch(e){console.log(7788)}' "$DATA/accounts.json")
URL="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:$PORT/}"
case "$URL" in */) ;; *) URL="$URL/";; esac
LABEL="${CLAUDE_USAGE_LABEL:-local.claude-usage}"
BUNDLE="${CLAUDE_DASHBOARD_BUNDLE_ID:-local.claude-rotator.dashboard}"
OUT="${CLAUDE_DASHBOARD_APP_DIR:-$HOME/Applications}"
APP="$OUT/Claude Dashboard.app"
mkdir -p build
cat > build/Config.swift <<SW
let DEFAULT_URL = "$URL"
let LAUNCHD_LABEL = "$LABEL"
SW
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -O -framework Cocoa -framework WebKit main.swift build/Config.swift -o "$APP/Contents/MacOS/ClaudeDashboard"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claude Dashboard</string>
  <key>CFBundleDisplayName</key><string>Claude Dashboard</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE</string>
  <key>CFBundleExecutable</key><string>ClaudeDashboard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PL
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $APP (opens $URL)"
