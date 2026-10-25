#!/usr/bin/env bash
# End-to-end install test in a throwaway HOME (macOS or Linux). Covers:
#   0  a settings.json that is not plain JSON stops the install before anything is written
#   A  install with zero logged-in accounts (port from CLAUDE_USAGE_PORT, a stray PORT ignored, node-run)
#   C  ccr add      S  status line: update our own, warn about someone else's, --chain-statusline
#   D  gateway (--with-gateway): auth, bind, watchdog, upgrade, refusal, no token in logs
#   F  uninstall    R  reinstall re-registers the kept ~/.claude-accounts dirs
# It never touches your real accounts: HOME points at a temp dir, the Keychain is skipped, the poller's
# API calls go to a dead local port, and services use their own label/unit names and ports.
#   bash test/install.test.sh            (TEST_PARENT=<dir> to choose where the temp HOME goes)
# Env: TEST_LABEL (default test.rotator), TEST_SUFFIX (systemd unit suffix, default -test),
#      TEST_PORT (default 17788), TEST_GW_PORT (default 17799).
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${TEST_LABEL:-test.rotator}"; SUFFIX="${TEST_SUFFIX:--test}"
# Never let the test reach a real install's services: units must carry a suffix, and the label must not be a real one.
[ -n "$SUFFIX" ] || { echo "TEST_SUFFIX must not be empty: the test would manage the live claude-usage.service" >&2; exit 1; }
case "$LABEL" in local.claude-usage|local.claude-usage.*|com.*) echo "TEST_LABEL=$LABEL looks like a real install's label; refusing" >&2; exit 1;; esac
P="${TEST_PORT:-17788}"; GP="${TEST_GW_PORT:-17799}"; DECOY=17790  # PORT is set to this; nothing may listen on it
T=$(mktemp -d "${TEST_PARENT:-${TMPDIR:-/tmp}}/h.XXXX"); T=$(cd "$T" && pwd -P)
DATA="$T/.local/share/claude-usage"
DUMMY="sk-ant-oat01-TEST-DUMMY-not-a-real-token"
OS=$(uname); fails=0; skipped=0
# Linux: the systemd --user manager reads units from the REAL user's config dir, not from this temp HOME.
# When it does not list $T/.config/systemd/user, install.sh registers the units with `systemctl --user link`
# (CLAUDE_USAGE_SYSTEMD_LINK=1) and cleanup removes those links again.
SYSD_LINK=0
if [ "$OS" = Linux ] && ! systemd-analyze --user unit-paths 2>/dev/null | grep -qxF "$T/.config/systemd/user"; then SYSD_LINK=1; fi
pass() { echo "PASS $*"; }
fail() { fails=$((fails+1)); echo "FAIL $*"; }
ok() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
E() { env -u CLAUDE_USAGE_DATA -u CLAUDE_USAGE_CONFIG -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_PICK_ACCOUNT -u CLAUDE_USAGE_ACCOUNT \
  -u XDG_CONFIG_HOME CLAUDE_USAGE_SYSTEMD_LINK="$SYSD_LINK" HOME="$T" USER="${USER:-$(id -un)}" CLAUDE_USAGE_PORT="$P" PORT="$DECOY" CLAUDE_USAGE_LABEL="$LABEL" CLAUDE_USAGE_UNIT_SUFFIX="$SUFFIX" \
  CLAUDE_USAGE_GATEWAY_PORT="$GP" CLAUDE_USAGE_NO_KEYCHAIN=1 CLAUDE_USAGE_API_BASE=http://127.0.0.1:1 "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }
cleanup() {
  if [ "$OS" = Darwin ]; then for l in "$LABEL" "$LABEL.gateway" "$LABEL.gateway-watchdog"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null; done
  else
    for u in "claude-usage$SUFFIX.service" "claude-gateway$SUFFIX.service" "claude-gateway-watchdog$SUFFIX.timer" "claude-gateway-watchdog$SUFFIX.service"; do
      systemctl --user disable --now "$u" >/dev/null 2>&1; systemctl --user reset-failed "$u" >/dev/null 2>&1
    done
    # any link left in the manager's own unit dir that points into this temp HOME
    find "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" -maxdepth 2 -type l -lname "$T/*" -delete 2>/dev/null
    systemctl --user daemon-reload >/dev/null 2>&1
  fi
  [ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"
}
# Check the ports BEFORE arming cleanup: a busy port means someone else's install, whose jobs must not be booted out.
for port in "$P" "$GP" "$DECOY"; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/"; then echo "port $port is in use; pick another TEST_PORT/TEST_GW_PORT" >&2; rm -rf "$T"; exit 1; fi
done
trap cleanup EXIT
echo "test HOME: $T"

# ---- 0. JSONC settings.json: clear error, clean exit, nothing written
mkdir -p "$T/.claude"; printf '{\n  // a comment\n  "theme": "dark"\n}\n' > "$T/.claude/settings.json"
E "$REPO/install.sh" > "$T/install-0.log" 2>&1; rc=$?
ok "0 install.sh refuses a JSONC settings.json (rc $rc)" [ "$rc" = 1 ]
ok "0 the error names the file" grep -q "settings.json is not valid JSON" "$T/install-0.log"
ok "0 nothing was written" sh -c '[ ! -e "$1/.local" ] && [ ! -e "$1/.zshrc" ] && [ ! -e "$1/Library/LaunchAgents" ] && [ ! -e "$1/.config/systemd" ]' _ "$T"
rm -f "$T/.claude/settings.json"

# ---- A. zero logged-in accounts
E "$REPO/install.sh" > "$T/install-a.log" 2>&1; rc=$?
ok "A install.sh exits 0" [ "$rc" = 0 ]
h=000; for _ in $(seq 1 20); do h=$(code "http://127.0.0.1:$P/healthz"); [ "$h" = 200 ] && break; sleep 1; done
ok "A /healthz 200 within 20 s (got $h)" [ "$h" = 200 ]
CCR="$T/.local/bin/ccr"
ls_out=$(E "$CCR" ls 2>&1); echo "$ls_out" | sed 's/^/    /'
ok "A ccr ls shows main NOT LOGGED IN" sh -c 'printf "%s\n" "$1" | grep "^main" | grep -q "NOT LOGGED IN"' _ "$ls_out"
E "$CCR" pick >/dev/null 2>"$T/pick.err"; rc=$?
ok "A ccr pick exits 2 ($(cat "$T/pick.err"))" [ "$rc" = 2 ]
E "$CCR" </dev/null >/dev/null 2>"$T/ccr.err"; rc=$?
ok "A ccr exits non-zero ($(head -c 120 "$T/ccr.err"))" [ "$rc" != 0 ]
if [ -x /usr/bin/cc ]; then
  if command -v zsh >/dev/null; then
    c1=$(env -i HOME="$T" PATH=/usr/bin:/bin zsh -c '. "$HOME/.zshrc" >/dev/null 2>&1; command -v cc' 2>/dev/null || true)
    ok "A zsh: cc still resolves to /usr/bin/cc ($c1)" [ "$c1" = /usr/bin/cc ]
  else echo "SKIP A zsh cc check: zsh is not installed"; skipped=$((skipped+1)); fi
  c2=$(env -i HOME="$T" PATH=/usr/bin:/bin bash -c '. "$HOME/.bashrc" >/dev/null 2>&1; command -v cc' 2>/dev/null || true)
  ok "A bash: cc still resolves to /usr/bin/cc ($c2)" [ "$c2" = /usr/bin/cc ]
  c3=$(env -i HOME="$T" PATH=/usr/bin:/bin bash -c '. "$HOME/.bashrc" >/dev/null 2>&1; type -P ccr' 2>/dev/null || true)
  ok "A new shell finds ccr ($c3)" [ "$c3" = "$T/.local/bin/ccr" ]
else
  echo "SKIP A cc check: no /usr/bin/cc on this machine"; skipped=$((skipped+1))
fi
ok "A settings.json statusLine runs statusline.js through node-run" \
  node -e 'const j=require(process.argv[1]); process.exit(j.statusLine && j.statusLine.command===JSON.stringify(process.argv[2])+" "+JSON.stringify(process.argv[3]) ? 0 : 1)' "$T/.claude/settings.json" "$DATA/app/node-run" "$DATA/app/statusline.js"
ok "A nothing listens on the stray PORT ($DECOY)" [ "$(code "http://127.0.0.1:$DECOY/healthz")" = 000 ]
ok "A accounts.json port is CLAUDE_USAGE_PORT" node -e 'process.exit(require(process.argv[1]).port===Number(process.argv[2])?0:1)' "$DATA/accounts.json" "$P"
NODE_REAL=$(command -v node)
if [ "$OS" = Darwin ]; then SVC="$T/Library/LaunchAgents/$LABEL.plist"; else SVC="$T/.config/systemd/user/claude-usage$SUFFIX.service"; fi
ok "A service starts node-run, not a pinned node path" sh -c 'grep -q "$2/app/node-run" "$1" && ! grep -q "$3" "$1"' _ "$SVC" "$DATA" "$NODE_REAL"

# ---- C. add an account
mkdir -p "$T/.claude/skills"; echo "# test" > "$T/.claude/CLAUDE.md"
echo '{"numStartups":3,"userID":"test-user-id","oauthAccount":{"emailAddress":"main@test.invalid"}}' > "$T/.claude.json"
E "$CCR" add two </dev/null > "$T/add.log" 2>&1; rc=$?
ok "C ccr add two exits 0" [ "$rc" = 0 ]
ok "C accounts.json has two" node -e 'process.exit(require(process.argv[1]).accounts.some(a=>a.id==="two")?0:1)' "$DATA/accounts.json"
ok "C account dir exists" [ -d "$T/.claude-accounts/two" ]
missing=""; for e in CLAUDE.md settings.json skills agents commands hooks plugins projects keybindings.json rules; do
  [ -e "$T/.claude/$e" ] || continue
  [ -L "$T/.claude-accounts/two/$e" ] && [ "$(readlink "$T/.claude-accounts/two/$e")" = "$T/.claude/$e" ] || missing="$missing $e"
done
ok "C every shared entry is symlinked${missing:+ (missing:$missing)}" [ -z "$missing" ]
ok "C seeded .claude.json has no oauthAccount or userID" \
  node -e 'const j=require(process.argv[1]); process.exit(!j.oauthAccount && !j.userID && j.numStartups===3 ? 0 : 1)' "$T/.claude-accounts/two/.claude.json"
ls_out=$(E "$CCR" ls 2>&1)
ok "C ccr ls lists two as NOT LOGGED IN" sh -c 'printf "%s\n" "$1" | grep "^two" | grep -q "NOT LOGGED IN"' _ "$ls_out"
mcp_out=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' | E "$CCR" mcp 2>/dev/null)
ok "C installed ccr mcp answers server/discover" sh -c 'printf "%s" "$1" | grep -q "\"supportedVersions\""' _ "$mcp_out"

# ---- S. status line
# an older install pinned the node path: a reinstall recognises it as ours and updates it
node -e 'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.statusLine.command=JSON.stringify(process.argv[2])+" "+JSON.stringify(process.argv[3]);fs.writeFileSync(p,JSON.stringify(j))' \
  "$T/.claude/settings.json" "$NODE_REAL" "$DATA/app/statusline.js"
E "$REPO/install.sh" --no-service > "$T/install-s1.log" 2>&1
ok "S reinstall updates our own older statusLine" grep -q "statusLine updated" "$T/install-s1.log"
ok "S updated statusLine uses node-run" grep -q "node-run" "$T/.claude/settings.json"
# someone else's status line: left alone, with a loud warning
node -e 'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.statusLine={type:"command",command:"echo theirs"};fs.writeFileSync(p,JSON.stringify(j))' "$T/.claude/settings.json"
E "$REPO/install.sh" --no-service > "$T/install-s2.log" 2>&1
ok "S a foreign statusLine gets a loud warning" grep -q "WARNING: statusLine NOT installed" "$T/install-s2.log"
ok "S the foreign statusLine is untouched" node -e 'process.exit(require(process.argv[1]).statusLine.command==="echo theirs"?0:1)' "$T/.claude/settings.json"
E "$REPO/install.sh" --no-service --chain-statusline > "$T/install-s3.log" 2>&1
ok "S --chain-statusline points statusLine at statusline-chain.js" grep -q "statusline-chain.js" "$T/.claude/settings.json"
sl=$(echo '{}' | E "$DATA/app/node-run" "$DATA/app/statusline-chain.js" 2>/dev/null)
ok "S the chain prints the old status line first ($sl)" sh -c 'case "$1" in theirs*) exit 0;; *) exit 1;; esac' _ "$sl"

# ---- D. gateway
E "$REPO/install.sh" --with-gateway > "$T/install-d.log" 2>&1; rc=$?
ok "D install.sh --with-gateway exits 0" [ "$rc" = 0 ]
g=000; for _ in $(seq 1 20); do g=$(code "http://127.0.0.1:$GP/healthz"); [ "$g" = 200 ] && break; sleep 1; done
ok "D gateway /healthz 200 (got $g)" [ "$g" = 200 ]
ok "D gateway.env is mode 600" sh -c '[ "$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")" = 600 ]' _ "$DATA/secrets/gateway.env"
KEY=$(sed -n 's/^CLAUDE_USAGE_GATEWAY_KEY=//p' "$DATA/secrets/gateway.env")
ok "D generated key is 32+ bytes" [ "${#KEY}" -ge 32 ]
if command -v lsof >/dev/null; then binds=$(lsof -nP -iTCP:"$GP" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ')
else binds=$(ss -ltnH "sport = :$GP" | awk '{print $4}' | sort -u | tr '\n' ' '); fi
ok "D gateway bound to 127.0.0.1 only ($binds)" [ "$binds" = "127.0.0.1:$GP " ]
ok "D lease without key -> 401" [ "$(code "http://127.0.0.1:$GP/v1/lease?caller=test")" = 401 ]
ok "D lease with wrong key -> 401" [ "$(code -H 'x-gateway-key: wrong' "http://127.0.0.1:$GP/v1/lease?caller=test")" = 401 ]
# A dummy inference token stands in for a real setup-token: this checks auth and plumbing, not Anthropic.
( umask 077; printf '{"main":"%s"}\n' "$DUMMY" > "$DATA/secrets/inference-tokens.json" )
curl -s -X POST --max-time 30 "http://127.0.0.1:$P/api/poll" >/dev/null
lc=$(curl -s -o "$T/lease.json" -w '%{http_code}' --max-time 20 -H "x-gateway-key: $KEY" "http://127.0.0.1:$GP/v1/lease?caller=test")
ok "D lease with key -> 200 (got $lc)" [ "$lc" = 200 ]
ok "D lease returns the pooled token" node -e 'process.exit(require(process.argv[1]).token===process.argv[2]?0:1)' "$T/lease.json" "$DUMMY"
ok "D gateway log names caller and account" grep -q 'lease caller=test acct=main' "$DATA/state/gateway.log"
ok "D gateway log exists and is not empty" [ -s "$DATA/state/gateway.log" ]
ok "D no token string in gateway logs" sh -c '[ -s "$1/state/gateway.log" ] && ! grep -h "sk-ant" "$1"/state/gateway*.log "$1"/state/watchdog*.log 2>/dev/null | grep -q .' _ "$DATA"
wd=$(E "$DATA/app/node-run" "$DATA/app/watchdog.js" 2>&1)
ok "D watchdog default is an HTTP check with no model call ($wd)" sh -c 'printf "%s" "$1" | grep -q "OK (http check)"' _ "$wd"
if [ "$OS" = Darwin ]; then ok "D watchdog runs every 30 min" grep -q '<key>StartInterval</key><integer>1800</integer>' "$T/Library/LaunchAgents/$LABEL.gateway-watchdog.plist"
else ok "D watchdog runs every 30 min" grep -q 'OnUnitActiveSec=30min' "$T/.config/systemd/user/claude-gateway-watchdog$SUFFIX.timer"; fi
# upgrade: a plain re-run (no --with-gateway) refreshes the installed gateway and restarts it
echo '// stale' >> "$DATA/app/gateway.js"
E "$REPO/install.sh" > "$T/install-u.log" 2>&1; rc=$?
ok "D upgrade re-run exits 0" [ "$rc" = 0 ]
ok "D upgrade refreshed gateway.js" cmp -s "$REPO/app/gateway.js" "$DATA/app/gateway.js"
g=000; for _ in $(seq 1 20); do g=$(code "http://127.0.0.1:$GP/healthz"); [ "$g" = 200 ] && break; sleep 1; done
ok "D gateway healthy after the upgrade (got $g)" [ "$g" = 200 ]
# refusal: drop the key from the env file and restart the gateway
sed -i.bak '/^CLAUDE_USAGE_GATEWAY_KEY=/d' "$DATA/secrets/gateway.env" && rm -f "$DATA/secrets/gateway.env.bak"
if [ "$OS" = Darwin ]; then launchctl kickstart -k "gui/$(id -u)/$LABEL.gateway" >/dev/null 2>&1
else systemctl --user restart "claude-gateway$SUFFIX.service" 2>/dev/null; fi
sleep 4
ok "D without a key the gateway is not serving" [ "$(code "http://127.0.0.1:$GP/healthz")" = 000 ]
if [ "$OS" = Linux ]; then
  st=$(systemctl --user show -p ActiveState --value "claude-gateway$SUFFIX.service" 2>/dev/null)
  ok "D exit 78 stops systemd restarting the gateway ($st)" sh -c '[ "$1" = failed ] || [ "$1" = inactive ]' _ "$st"
fi
ok "D without a key the gateway logs a refusal" grep -q 'refusing to start' "$DATA/state/gateway.log" "$DATA/state/gateway.err.log" 2>/dev/null

# ---- F. uninstall
printf 'n\n' | E "$REPO/uninstall.sh" > "$T/uninstall.log" 2>&1; rc=$?
sed 's/^/    /' "$T/uninstall.log"
ok "F uninstall.sh exits 0" [ "$rc" = 0 ]
ok "F asked before touching ~/.claude-accounts" grep -q 'Delete .*claude-accounts.*\[y/N\]' "$T/uninstall.log"
ok "F answering n kept ~/.claude-accounts" [ -d "$T/.claude-accounts/two" ]
if [ "$OS" = Darwin ]; then
  ok "F no $LABEL launchd jobs left" sh -c '! launchctl list | grep -q "$1"' _ "$LABEL"
  ok "F plists removed" sh -c '! ls "$1"/Library/LaunchAgents/"$2"* >/dev/null 2>&1' _ "$T" "$LABEL"
else
  ok "F no unit files left" sh -c '! ls "$1"/.config/systemd/user/claude-*"$2".* >/dev/null 2>&1' _ "$T" "$SUFFIX"
fi
ok "F rc lines removed" sh -c '! grep -q "claude-rotator\|claude-usage/app/shell.sh" "$1/.zshrc" "$1/.bashrc"' _ "$T"
ok "F ccr symlink removed" [ ! -e "$T/.local/bin/ccr" ]
ok "F data dir removed" [ ! -e "$DATA" ]
ok "F the chained statusLine is restored to the old command" node -e 'process.exit(require(process.argv[1]).statusLine.command==="echo theirs"?0:1)' "$T/.claude/settings.json"

# ---- R. reinstall after uninstall kept ~/.claude-accounts
E "$REPO/install.sh" --no-service > "$T/install-r.log" 2>&1; rc=$?
ok "R reinstall exits 0" [ "$rc" = 0 ]
ok "R reinstall re-registered two" sh -c 'grep -q "re-registered from ~/.claude-accounts: two" "$1" && node -e "process.exit(require(process.argv[1]).accounts.some(a=>a.id===\"two\")?0:1)" "$2"' _ "$T/install-r.log" "$DATA/accounts.json"

echo
[ "$skipped" = 0 ] && skipped="" || skipped=" ($skipped skipped)"
[ "$fails" = 0 ] && echo "INSTALL: ALL PASS$skipped" || { echo "INSTALL: $fails FAILED (logs in $T, rerun with KEEP=1 to keep them)"; exit 1; }
