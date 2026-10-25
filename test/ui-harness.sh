#!/usr/bin/env bash
# Shared by ui.test.sh and the browser test: builds an isolated dashboard in <dir> and starts it on <port>.
#   . test/ui-harness.sh; ui_prepare <dir> <port> [repo]; ui_start; ...; ui_stop
# Layout: <dir>/home (HOME), <dir>/data (CLAUDE_USAGE_DATA, app copied in, fake providers.js + routes),
# <dir>/bin (fake claude, open, xdg-open), <dir>/log (what the fakes were asked to do).
# Nothing here reads a real login: the Keychain is skipped and the poller's API calls go to a closed port.
ui_prepare() {
  UD="$1"; UP="$2"; local repo="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  mkdir -p "$UD/home/.claude" "$UD/data/state/live" "$UD/data/secrets" "$UD/bin" "$UD/log"
  chmod 700 "$UD/data/secrets"
  cp -R "$repo/app" "$UD/data/"
  cp "$repo/test/ui-fake-providers.js" "$UD/data/app/providers.js"
  # The fake provider routes go right after the setup UI block, where the real providers block will sit.
  UD_NODE_FILE="$UD/data/app/server.js" node -e '
    const fs=require("fs"),f=process.env.UD_NODE_FILE; let s=fs.readFileSync(f,"utf8");
    const anchor="    // --- end setup UI routes ---\n";
    if(!s.includes(anchor)) { console.error("ui-harness: end-of-setup-routes anchor line missing in server.js"); process.exit(1); }
    s=s.replace(anchor, anchor+"    { const h = await require(\"./providers\").fakeRoutes(req, u, { requireUiToken, readJson, NO_TOKEN }); if (h) return send(res, h[0], h[1]); }\n");
    fs.writeFileSync(f,s);' || return 1
  cat > "$UD/bin/claude" <<F
#!/bin/sh
case "\$1" in
  --version) echo "9.9.9 (Claude Code)";;
  auth) if [ "\$2" = --help ]; then echo "  login [options]  Sign in"; elif [ "\$2" = login ]; then echo "\${CLAUDE_CONFIG_DIR:-default}" >> "$UD/log/claude-login"; fi;;
  *) echo "fake claude \$*";;
esac
F
  printf '#!/bin/sh\necho "$*" >> "%s/log/open"\n' "$UD" > "$UD/bin/open"
  cp "$UD/bin/open" "$UD/bin/xdg-open"
  chmod +x "$UD/bin/claude" "$UD/bin/open" "$UD/bin/xdg-open"
  echo "{\"port\":$UP,\"pollMinutes\":60,\"allowedHosts\":[\"dash.test.invalid\"],\"accounts\":[{\"id\":\"main\",\"label\":\"main\",\"configDir\":\"~/.claude\",\"default\":true}]}" > "$UD/data/accounts.json"
  # A gateway install's key file, so the key route has something to guard.
  ( umask 077; printf 'CLAUDE_USAGE_GATEWAY_KEY=%s\nCLAUDE_USAGE_GATEWAY_PORT=%s\n' "gwkey-TEST-0123456789abcdef0123456789abcdef" "$((UP + 1))" > "$UD/data/secrets/gateway.env" )
}
ui_envv() {
  UI_ENV=(env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_USAGE_ACCOUNT -u CLAUDE_PICK_ACCOUNT
    HOME="$UD/home" PATH="$UD/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" CLAUDE_USAGE_DATA="$UD/data" CLAUDE_USAGE_CONFIG="$UD/data/accounts.json"
    CLAUDE_USAGE_NO_KEYCHAIN=1 CLAUDE_USAGE_API_BASE=http://127.0.0.1:1 CLAUDE_USAGE_OPEN_CMD="$UD/bin/open"
    CLAUDE_USAGE_TEST_REMOTE_HOOK=1)
}
ui_env() { ui_envv; "${UI_ENV[@]}" "$@"; }
ui_start() {
  ui_envv
  # A plain command, not a function, so $! is the env process that execs node and ui_stop really stops it.
  "${UI_ENV[@]}" node "$UD/data/app/server.js" > "$UD/log/server.log" 2>&1 & UI_PID=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$UP/healthz" && return 0; sleep 0.2; done
  echo "ui-harness: dashboard did not start on $UP"; tail -20 "$UD/log/server.log"; return 1
}
ui_stop() { [ -n "${UI_PID:-}" ] || return 0; kill "$UI_PID" 2>/dev/null; wait "$UI_PID" 2>/dev/null; UI_PID=""; }
