#!/usr/bin/env bash
# Regression: the dashboard (1) listens on the accounts.json port and ignores a generic PORT variable,
# (2) answers only requests addressed to a loopback name on its own port (DNS rebinding), and (3) refuses
# a POST that another origin started. The gateway's guard is covered in gateway-bench.test.sh.
# Run: bash test/host-guard.test.sh [server.js]
set -u; cd "$(dirname "$0")/.."
SRV=${1:-app/server.js}; fails=0
D=$(mktemp -d); A=""; S=""; trap 'kill $A $S 2>/dev/null; wait 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
mkdir -p "$D/state"
echo "{\"port\":17920,\"pollMinutes\":60,\"allowedHosts\":[\"dash.test.invalid\"],\"accounts\":[{\"id\":\"main\",\"configDir\":\"$D/none\",\"default\":true}]}" > "$D/accounts.json"
node -e 'require("http").createServer((q,s)=>{s.writeHead(401);s.end("{}")}).listen(17922)' & A=$!
# PORT=17921 is a decoy: a dashboard that read it would listen there instead of on 17920.
HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1 \
  CLAUDE_USAGE_API_BASE=http://127.0.0.1:17922 PORT=17921 node "$SRV" > "$D/srv.log" 2>&1 & S=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17920/healthz && break; sleep 0.3; done
c() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else fails=$((fails+1)); echo "FAIL $1: expected $3, got $2"; fi; }

check "listens on the accounts.json port" "$(c http://127.0.0.1:17920/api/state)" 200
check "ignores PORT" "$(c http://127.0.0.1:17921/api/state)" 000
check "GET via localhost" "$(c http://localhost:17920/api/state)" 200
check "GET with a rebound Host is refused" "$(c -H 'Host: evil.test.invalid:17920' http://127.0.0.1:17920/api/state)" 403
check "GET / with a rebound Host is refused" "$(c -H 'Host: evil.test.invalid' http://127.0.0.1:17920/)" 403
check "loopback Host on another port is refused" "$(c -H 'Host: 127.0.0.1:80' http://127.0.0.1:17920/api/state)" 403
check "allowedHosts name is served" "$(c -H 'Host: dash.test.invalid:17920' http://127.0.0.1:17920/api/state)" 200
check "POST with no Origin (curl, ccr)" "$(c -X POST http://127.0.0.1:17920/api/poll)" 200
check "POST from the dashboard's own origin" "$(c -X POST -H 'Origin: http://127.0.0.1:17920' http://127.0.0.1:17920/api/poll)" 200
check "POST from another origin is refused" "$(c -X POST -H 'Origin: http://evil.test.invalid' http://127.0.0.1:17920/api/poll)" 403
check "POST from a loopback origin on another port is refused" "$(c -X POST -H 'Origin: http://127.0.0.1:3000' http://127.0.0.1:17920/api/poll)" 403
check "POST flagged cross-site is refused" "$(c -X POST -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:17920/api/poll)" 403
check "POST from Origin null is refused" "$(c -X POST -H 'Origin: null' http://127.0.0.1:17920/api/poll)" 403
[ $fails = 0 ] && echo "HOST-GUARD: ALL PASS" || { echo "HOST-GUARD: $fails FAILED"; tail -5 "$D/srv.log"; exit 1; }
