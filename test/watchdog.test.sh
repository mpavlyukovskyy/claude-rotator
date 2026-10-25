#!/usr/bin/env bash
# Regression: the default (HTTP-only) watchdog must not say OK when no account has credentials, since the
# gateway then answers but can serve nothing. Two such runs alert; adding a setup-token recovers it.
# Uses a fake gateway; makes no model call. Run: bash test/watchdog.test.sh [watchdog.js]
set -u; cd "$(dirname "$0")/.."
WD=${1:-app/watchdog.js}; fails=0
D=$(mktemp -d); G=""; trap 'kill $G 2>/dev/null; wait 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
mkdir -p "$D/state" "$D/secrets" "$D/one"
echo "{\"accounts\":[{\"id\":\"one\",\"configDir\":\"$D/one\"}]}" > "$D/accounts.json"
# fake gateway: healthz 200, a keyed malformed POST gets the real gateway's 400
node -e 'require("http").createServer((q,s)=>{s.writeHead(q.url.endsWith("/healthz")?200:400);s.end("{}")}).listen(17940)' & G=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17940/healthz && break; sleep 0.2; done
W() { env -u WATCHDOG_DEEP -u ALERT_WEBHOOK HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1 \
  CLAUDE_USAGE_GATEWAY_ENV="$D/none.env" CLAUDE_USAGE_GATEWAY_LOCAL=http://127.0.0.1:17940 CLAUDE_USAGE_GATEWAY_KEY=k node "$WD" 2>&1; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else fails=$((fails+1)); echo "FAIL $1: expected [$3], got [$2]"; fi; }
has() { printf '%s' "$1" | grep -q "$2" && echo yes || echo no; }

o1=$(W); check "no credentials: not OK" "$(has "$o1" 'OK (')" no
check "no credentials: strike 1 names the cause" "$(has "$o1" 'FAIL (strike 1/2): no account has credentials (0/1)')" yes
o2=$(W); check "no credentials twice: alert" "$(has "$o2" 'ALERT claude-rotator gateway DOWN (2 consecutive checks): no account has credentials')" yes
( umask 077; echo '{"one":"sk-ant-oat01-TEST-DUMMY"}' > "$D/secrets/inference-tokens.json" )
o3=$(W); check "with a setup-token: OK" "$(has "$o3" 'OK (http check): gateway live, 1/1 accounts')" yes
check "with a setup-token: recovery note" "$(has "$o3" 'RECOVERED')" yes
check "no token in watchdog output" "$(has "$o1$o2$o3" 'sk-ant')" no
[ $fails = 0 ] && echo "WATCHDOG: ALL PASS" || { echo "WATCHDOG: $fails FAILED"; printf '%s\n' "$o1" "$o2" "$o3"; exit 1; }
