#!/usr/bin/env bash
# Setup UI, API level (curl). Covers:
#   T  the setup token: injected into the page only for a loopback Host on our port, never through an
#      allowedHosts name; the server writes it 0600 when missing; install.sh writes it and keeps it
#   G  every state-changing setup route (and the gateway key read) refuses no token, a wrong token and a
#      wrong-length token, and a foreign Origin even with the token
#   N  POST /api/accounts uses the same name rules as `ccr add`
#   L  open-login writes a .command file that logs in through `ccr login` with a bare environment
#   K  the gateway key comes only from the token-guarded route; no secret in /api/setup or /api/state
#   C  ccr ui (opens #setup, fails loudly when the dashboard is down) and ccr login
# Provider routes are a fake (test/ui-fake-providers.js) wired through requireUiToken/readJson, the
# interface the real providers block uses. Ports 18300-18302. Run: bash test/ui.test.sh
set -u; cd "$(dirname "$0")/.."
REPO=$PWD; fails=0
. test/ui-harness.sh
SCRATCH=${TEST_PARENT:-${TMPDIR:-/tmp}}
D=$(mktemp -d "$SCRATCH/ui-test.XXXX"); D=$(cd "$D" && pwd -P)
trap 'ui_stop; [ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
P=18300; B="http://127.0.0.1:$P"
for port in $P $((P + 1)) $((P + 2)); do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/" && { echo "port $port is in use" >&2; exit 1; }; done
ui_prepare "$D" "$P" "$REPO" || exit 1
ui_start || exit 1

# GNU stat first: on Linux, `stat -f` reads the filesystem, not the file, and still exits 0.
perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else fails=$((fails+1)); echo "FAIL $1: expected [$3], got [$2]"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
TOKEN=$(cat "$D/data/secrets/ui-token")
meta() { curl -s --max-time 10 "$@" | sed -n 's/.*<meta name="rotator-ui-token" content="\([^"]*\)">.*/\1/p'; }
J() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

# ---- T. token
check "T server wrote a 64-hex token when none existed" "$(grep -cE '^[0-9a-f]{64}$' "$D/data/secrets/ui-token")" 1
check "T token file is mode 600" "$(perm "$D/data/secrets/ui-token")" 600
check "T page via 127.0.0.1 carries the token" "$(meta "$B/")" "$TOKEN"
check "T page via localhost carries the token" "$(meta "http://localhost:$P/")" "$TOKEN"
check "T page via an allowedHosts name has no token" "$(meta -H "Host: dash.test.invalid:$P" "$B/")" ""
check "T page via an allowedHosts name still loads" "$(code -H "Host: dash.test.invalid:$P" "$B/")" 200
check "T page via a rebound Host is refused" "$(code -H "Host: evil.test.invalid:$P" "$B/")" 403
check "T page via a loopback name on another port is refused" "$(code -H "Host: 127.0.0.1:80" "$B/")" 403
check "T page cannot be framed" "$(curl -s -D - -o /dev/null "$B/" | grep -ci '^x-frame-options: deny')" 1

# install.sh writes the token (no services, temp HOME, fake claude), and a re-run keeps it.
I="$D/inst"; mkdir -p "$I"
inst() { env -u CLAUDE_USAGE_DATA -u CLAUDE_USAGE_CONFIG HOME="$I" PATH="$D/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" CLAUDE_USAGE_NO_KEYCHAIN=1 \
  bash "$REPO/install.sh" --no-service > "$I/install.log" 2>&1; }
inst; rc=$?
check "T install.sh --no-service exits 0" "$rc" 0
IT="$I/.local/share/claude-usage/secrets/ui-token"
check "T install.sh wrote a 64-hex token" "$(grep -cE '^[0-9a-f]{64}$' "$IT" 2>/dev/null)" 1
check "T install.sh token is mode 600" "$(perm "$IT")" 600
first=$(cat "$IT" 2>/dev/null); inst
check "T a re-run of install.sh keeps the token" "$(cat "$IT" 2>/dev/null)" "$first"

# ---- G. every state-changing route needs the token
WRONG=$(printf '%s' "$TOKEN" | tr '0-9a-f' '1-9a-f0'); SHORT=${TOKEN:0:20}
routes=("POST /api/accounts {\"name\":\"gtest\"}" "POST /api/accounts/main/open-login {}" "GET /api/gateway/key -"
  "POST /api/providers/fireworks {\"apiKey\":\"good-guard-test-key\"}" "DELETE /api/providers/fireworks -"
  "POST /api/providers/fireworks/test {}" "POST /api/fallback {\"enabled\":true}")
for r in "${routes[@]}"; do
  read -r m path body <<<"$r"
  d=(); [ "$body" != - ] && d=(-H 'content-type: application/json' -d "$body")
  check "G $m $path without a token: 403" "$(code -X "$m" ${d[@]+"${d[@]}"} "$B$path")" 403
  check "G $m $path with a wrong token: 403" "$(code -X "$m" ${d[@]+"${d[@]}"} -H "x-rotator-ui-token: $WRONG" "$B$path")" 403
  check "G $m $path with a short token: 403" "$(code -X "$m" ${d[@]+"${d[@]}"} -H "x-rotator-ui-token: $SHORT" "$B$path")" 403
  [ "$m" != GET ] && check "G $m $path with the token but a foreign Origin: 403" "$(code -X "$m" ${d[@]+"${d[@]}"} -H "x-rotator-ui-token: $TOKEN" -H 'Origin: http://evil.test.invalid' "$B$path")" 403
done
check "G nothing changed: accounts.json still has only main" "$(J 'j.accounts.map(a=>a.id).join()' < "$D/data/accounts.json")" main
check "G nothing changed: no provider key saved" "$([ -e "$D/data/secrets/providers.json" ] && echo yes || echo no)" no
check "G nothing changed: open was never run" "$([ -e "$D/log/open" ] && echo yes || echo no)" no
# ---- R. the token is for this machine only: a non-loopback peer never gets it, even with Host: 127.0.0.1.
# x-test-remote-nonlocal is a test hook (CLAUDE_USAGE_TEST_REMOTE_HOOK=1) that makes the server treat the
# peer as remote; it can only take rights away. Set UI_TEST_IFACE_IP=<this machine's LAN address> to also
# run the check over a real interface (it binds a second test dashboard to that address for a few seconds).
NL=(-H "x-test-remote-nonlocal: 1")
check "R page for a non-loopback peer has no token" "$(meta "${NL[@]}" "$B/")" ""
for r in "${routes[@]}"; do
  read -r m path body <<<"$r"
  d=(); [ "$body" != - ] && d=(-H 'content-type: application/json' -d "$body")
  check "R $m $path from a non-loopback peer with the token: 403" "$(code -X "$m" ${d[@]+"${d[@]}"} "${NL[@]}" -H "x-rotator-ui-token: $TOKEN" "$B$path")" 403
done
check "R nothing changed: accounts.json still has only main" "$(J 'j.accounts.map(a=>a.id).join()' < "$D/data/accounts.json")" main
check "R nothing changed: open was never run" "$([ -e "$D/log/open" ] && echo yes || echo no)" no
if [ -n "${UI_TEST_IFACE_IP:-}" ]; then
  P2=$((P + 2)); IP=$UI_TEST_IFACE_IP
  J "JSON.stringify({...j,port:$P2})" < "$D/data/accounts.json" > "$D/data/accounts-iface.json"
  ui_envv; "${UI_ENV[@]}" CLAUDE_USAGE_CONFIG="$D/data/accounts-iface.json" CLAUDE_USAGE_HOST="$IP" node "$D/data/app/server.js" > "$D/log/server-iface.log" 2>&1 & IFP=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null -H "Host: 127.0.0.1:$P2" "http://$IP:$P2/healthz" && break; sleep 0.2; done
  check "R real interface: page with a spoofed loopback Host has no token" "$(meta -H "Host: 127.0.0.1:$P2" "http://$IP:$P2/")" ""
  check "R real interface: a token route with a spoofed Host and the token: 403" "$(code -X POST -H "Host: 127.0.0.1:$P2" -H "x-rotator-ui-token: $TOKEN" -H 'content-type: application/json' -d '{"name":"lan"}' "http://$IP:$P2/api/accounts")" 403
  kill "$IFP" 2>/dev/null; wait "$IFP" 2>/dev/null
fi
T=(-H "x-rotator-ui-token: $TOKEN" -H 'content-type: application/json')
check "G with the token, a bad JSON body is a 400" "$(code -X POST "${T[@]}" -d '{nope' "$B/api/accounts")" 400
check "G with the token, a body over 64 KB is a 413" "$(head -c 70000 /dev/zero | tr '\0' a | sed 's/^/{"name":"/;s/$/"}/' | code -X POST "${T[@]}" --data-binary @- "$B/api/accounts")" 413

# ---- N. account names: the same rules as `ccr add`
for bad in ls ui login mcp web add 9lives Bad a/b ../x "" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa main; do
  body=$(node -e 'console.log(JSON.stringify({name:process.argv[1]}))' "$bad")
  check "N name '$bad' is refused" "$(code -X POST "${T[@]}" -d "$body" "$B/api/accounts")" 400
done
check "N a non-string name is refused" "$(code -X POST "${T[@]}" -d '{"name":123}' "$B/api/accounts")" 400
msg=$(curl -s -X POST "${T[@]}" -d '{"name":"ls"}' "$B/api/accounts" | J j.error)
check "N the refusal says why" "$(printf '%s' "$msg" | grep -c 'is a ccr command')" 1
check "N refused names left accounts.json alone" "$(J 'j.accounts.map(a=>a.id).join()' < "$D/data/accounts.json")" main
out=$(curl -s -X POST "${T[@]}" -d '{"name":"work"}' "$B/api/accounts")
check "N 'work' is accepted" "$(printf '%s' "$out" | J 'j.ok+"|"+j.id+"|"+j.login')" "true|work|ccr login work"
check "N 'work' is in accounts.json" "$(J 'j.accounts.map(a=>a.id).join()' < "$D/data/accounts.json")" "main,work"
check "N its dir exists with mode 700" "$(perm "$D/home/.claude-accounts/work")" 700
check "N adding 'work' again is refused" "$(code -X POST "${T[@]}" -d '{"name":"work"}' "$B/api/accounts")" 400

# ---- L. open-login (macOS only; Linux answers 400)
if [ "$(uname)" = Darwin ]; then
  check "L unknown account: 404" "$(code -X POST "${T[@]}" "$B/api/accounts/nobody/open-login")" 404
  check "L 'work': 200" "$(code -X POST "${T[@]}" "$B/api/accounts/work/open-login")" 200
  CMDF="$D/data/state/login-work.command"
  check "L open was handed the .command file" "$(cat "$D/log/open" 2>/dev/null)" "$CMDF"
  check "L the .command file is mode 700" "$(perm "$CMDF")" 700
  # Terminal runs it without the user's rc files: a bare environment must still reach `claude auth login`.
  env -i HOME="$D/home" /bin/bash "$CMDF" </dev/null >/dev/null 2>&1
  check "L running it logs in to the work dir" "$(tail -1 "$D/log/claude-login" 2>/dev/null)" "$D/home/.claude-accounts/work"
  check "L the .command file deleted itself after the login" "$([ -e "$CMDF" ] && echo left || echo gone)" gone
else
  check "L open-login is refused off macOS" "$(code -X POST "${T[@]}" "$B/api/accounts/work/open-login")" 400
fi

# ---- K. gateway key and secrets
GK=gwkey-TEST-0123456789abcdef0123456789abcdef
check "K the key route returns the key with the token" "$(curl -s "${T[@]}" "$B/api/gateway/key" | J j.key)" "$GK"
check "K provider key saves with the token" "$(code -X POST "${T[@]}" -d '{"apiKey":"good-SECRET-provider-key-9876"}' "$B/api/providers/fireworks")" 200
check "K providers.json is mode 600" "$(perm "$D/data/secrets/providers.json")" 600
for path in /api/setup /api/state / "/api/history?hours=1" /healthz; do
  body=$(curl -s "$B$path")
  for secret in "$GK" "$TOKEN" good-SECRET-provider-key-9876; do
    if [ "$path" = / ] && [ "$secret" = "$TOKEN" ]; then continue; fi  # the page itself carries the token by design
    check "K $path does not contain ${secret:0:12}…" "$(printf '%s' "$body" | grep -cF "$secret")" 0
  done
done
check "K the page through an allowedHosts name carries no token" "$(curl -s -H "Host: dash.test.invalid:$P" "$B/" | grep -cF "$TOKEN")" 0
S=$(curl -s "$B/api/setup")
check "K /api/setup: claude found with its version" "$(printf '%s' "$S" | J 'j.claude.found+" "+j.claude.version')" "true 9.9.9"
check "K /api/setup: both accounts" "$(printf '%s' "$S" | J 'j.accounts.map(a=>a.id+":"+a.status).join()')" "main:login,work:login"
check "K /api/setup: gateway installed, not running" "$(printf '%s' "$S" | J 'j.gateway.installed+" "+j.gateway.running')" "true false"
check "K /api/setup: one provider configured, fallback on by default" "$(printf '%s' "$S" | J 'j.providers.configured+"/"+j.providers.total+" "+j.providers.fallback.enabled')" "1/3 true"
check "K /api/setup: the MCP line" "$(printf '%s' "$S" | J j.mcp.command)" "claude mcp add --scope user claude-rotator -- ccr mcp"
check "K /api/setup: the dir is shown with ~" "$(printf '%s' "$S" | J 'j.accounts[1].configDir')" "~/.claude-accounts/work"

# ---- C. ccr ui and ccr login
: > "$D/log/open"
ui_env bash "$D/data/app/ccr" ui > "$D/log/ccr-ui.out" 2>&1; rc=$?
check "C ccr ui exits 0" "$rc" 0
check "C ccr ui opens the Setup page" "$(cat "$D/log/open")" "$B/#setup"
echo '{"port":18302,"accounts":[{"id":"main","configDir":"~/.claude","default":true}]}' > "$D/down.json"
ui_env CLAUDE_USAGE_CONFIG="$D/down.json" bash "$D/data/app/ccr" ui > "$D/log/ccr-ui-down.out" 2>&1; rc=$?
check "C ccr ui with the dashboard down exits 1" "$rc" 1
check "C and says so" "$(grep -c 'not answering' "$D/log/ccr-ui-down.out")" 1
ui_env bash "$D/data/app/ccr" login nobody </dev/null >/dev/null 2>&1; rc=$?
check "C ccr login nobody exits 1" "$rc" 1
ui_env bash "$D/data/app/ccr" login main </dev/null >/dev/null 2>&1
check "C ccr login main runs claude auth login in the default dir" "$(tail -1 "$D/log/claude-login")" default
ui_env bash "$D/data/app/ccr" login work </dev/null >/dev/null 2>&1
check "C ccr login work runs it in the work dir" "$(tail -1 "$D/log/claude-login")" "$D/home/.claude-accounts/work"
check "C ccr help lists ui and login" "$(ui_env bash "$D/data/app/ccr" help | grep -cE '^ccr (ui|login)')" 2

[ $fails = 0 ] && echo "UI: ALL PASS" || { echo "UI: $fails FAILED"; tail -5 "$D/log/server.log"; exit 1; }
