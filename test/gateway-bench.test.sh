#!/usr/bin/env bash
# Regression: a direct-path 429 for ONE model (Anthropic's bare refusal of a model the subscription will
# not serve raw) must bench only that model on that account, not every account. Also checks the gateway's
# hardening: no start without a 32+ byte key, 401 on a wrong key, the direct route off by default, the
# Host/Origin guard, and the isolation flags on every `claude -p` it runs.
# Run: bash test/gateway-bench.test.sh [gateway.js]
set -u; cd "$(dirname "$0")/.."
GW=${1:-app/gateway.js}; fails=0
D=$(mktemp -d); U=""; B=""; G=""; trap 'kill $U $B $G 2>/dev/null; wait 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
KEY=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
for a in one two; do mkdir -p "$D/$a"; echo '{"claudeAiOauth":{"accessToken":"tok-'$a'","expiresAt":9999999999999}}' > "$D/$a/.credentials.json"; done
echo "{\"accounts\":[{\"id\":\"one\",\"configDir\":\"$D/one\"},{\"id\":\"two\",\"configDir\":\"$D/two\"}]}" > "$D/accounts.json"
# Fake Anthropic: claude-haiku-9-9 is refused with a bare 429 on every account; claude-haiku-5-5 is served.
node -e '
require("http").createServer((q,s)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{const m=JSON.parse(b).model;
 if(m==="claude-haiku-9-9"){s.writeHead(429,{"content-type":"application/json"});return s.end(JSON.stringify({type:"error",error:{type:"rate_limit_error",message:"Error"}}));}
 s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({id:"msg_1",type:"message",role:"assistant",model:m,content:[{type:"text",text:"ok"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}}));});}).listen(17911)' & U=$!
node -e '
const dir=process.argv[1];require("http").createServer((q,s)=>{s.end(JSON.stringify({accounts:["one","two"].map(id=>({id,configDir:dir+"/"+id,ok:true,eff5:0,eff7:0,effModels:{}}))}))}).listen(17912)' "$D" & B=$!
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else fails=$((fails+1)); echo "FAIL $1: expected $3, got $2"; fi; }
genv() { exec env HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1 CLAUDE_USAGE_DASH=http://127.0.0.1:17912 \
  CLAUDE_USAGE_ANTHROPIC_URL=http://127.0.0.1:17911/v1/messages CLAUDE_USAGE_GATEWAY_PORT=17910 "$@"; }

# refuses to start without a key, or with a short one
(genv node "$GW" > "$D/nokey.log" 2>&1); check "no key: refuses to start" "$?" 78
(genv CLAUDE_USAGE_GATEWAY_KEY=short node "$GW" > "$D/short.log" 2>&1); check "short key: refuses to start" "$?" 78

genv CLAUDE_USAGE_GATEWAY_KEY="$KEY" CLAUDE_USAGE_DIRECT_HAIKU=1 node "$GW" > "$D/gw.log" 2>&1 & G=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17910/healthz && break; sleep 0.3; done
post() { curl -s -m 60 -o /dev/null -w '%{http_code}' http://127.0.0.1:17910/v1/messages -H 'content-type: application/json' -H "x-gateway-key: ${2:-$KEY}" -d "{\"model\":\"$1\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"; }
check "wrong key is refused" "$(post claude-haiku-5-5 wrong-key)" 401
check "refused model is still refused" "$(post claude-haiku-9-9)" 503
check "Haiku right after is served, not benched" "$(post claude-haiku-5-5)" 200
H=$(curl -s http://127.0.0.1:17910/healthz)
case "$H" in *'"one|claude-haiku-9-9"'*'"two|claude-haiku-9-9"'*) check "bench names account+model" yes yes;; *) check "bench names account+model ($H)" no yes;; esac
case "$H" in *'"one"'*|*'"two"'*) check "no whole-account bench ($H)" no yes;; *) check "no whole-account bench" yes yes;; esac
kill $G 2>/dev/null; wait $G 2>/dev/null

for _ in $(seq 1 20); do lsof -nP -iTCP:17910 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.3; done
# direct route off by default: a tool-using Haiku request goes to the cli path and is refused fast (422)
genv CLAUDE_USAGE_GATEWAY_KEY="$KEY" node "$GW" > "$D/gw2.log" 2>&1 & G=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17910/healthz && break; sleep 0.3; done
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' http://127.0.0.1:17910/v1/messages -H 'content-type: application/json' -H "x-gateway-key: $KEY" \
  -d '{"model":"claude-haiku-5-5","max_tokens":5,"tools":[{"name":"t","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hi"}]}')
check "direct Haiku route off by default (tool call -> 422)" "$code" 422
grep -q "direct Haiku route off" "$D/gw2.log" && check "startup log says direct route off" yes yes || check "startup log says direct route off" no yes
# DNS-rebinding / cross-origin guard, checked before the key
check "rebound Host is refused even with the key" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.test.invalid:17910' -H "x-gateway-key: $KEY" http://127.0.0.1:17910/v1/lease)" 403
check "browser Origin from another site is refused" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.test.invalid' -H "x-gateway-key: $KEY" http://127.0.0.1:17910/v1/lease)" 403
check "loopback Host on the gateway port passes the guard (then 401 without key)" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost:17910' http://127.0.0.1:17910/v1/lease)" 401
kill $G 2>/dev/null; wait $G 2>/dev/null
for _ in $(seq 1 20); do lsof -nP -iTCP:17910 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.3; done

# claude -p isolation: a fake claude records its argv. Every cli-path call must carry the flags that keep a
# caller away from this user's MCP servers, hooks, settings and CLAUDE.md, and still no tools.
fake() { # name help-text
  printf '#!/bin/sh\nif [ "$1" = --help ]; then printf "%%s\\n" "%s"; exit 0; fi\nfor a in "$@"; do printf "[%%s]" "$a"; done > "%s/argv.txt"\ncat >/dev/null\necho %s\n' \
    "$2" "$D" "'{\"result\":\"ok\",\"is_error\":false,\"usage\":{}}'" > "$D/$1"; chmod +x "$D/$1"; }
fake claude-new "  --strict-mcp-config  x
  --restricted  x
  --safe-mode  x
  --setting-sources <s>  x"
genv CLAUDE_USAGE_GATEWAY_KEY="$KEY" CLAUDE_BIN="$D/claude-new" node "$GW" > "$D/gw3.log" 2>&1 & G=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17910/healthz && break; sleep 0.3; done
check "cli path serves through the fake claude" "$(post claude-haiku-5-5)" 200
A=$(cat "$D/argv.txt" 2>/dev/null)
for f in '[--strict-mcp-config]' '[--restricted]' '[--safe-mode]' '[--tools][]' '[--no-session-persistence]'; do
  case "$A" in *"$f"*) check "claude -p gets $f" yes yes;; *) check "claude -p gets $f ($A)" no yes;; esac
done
case "$A" in *'[--mcp-config]'*) check "no --mcp-config is passed" no yes;; *) check "no --mcp-config is passed" yes yes;; esac
grep -q 'isolation: --strict-mcp-config --restricted --safe-mode' "$D/gw3.log" && check "startup log names the isolation flags" yes yes || check "startup log names the isolation flags" no yes
kill $G 2>/dev/null; wait $G 2>/dev/null
fake claude-old "  --tools <tools...>  x"
genv CLAUDE_USAGE_GATEWAY_KEY="$KEY" CLAUDE_BIN="$D/claude-old" node "$GW" > "$D/gw4.log" 2>&1 & G=$!
for _ in $(seq 1 40); do kill -0 $G 2>/dev/null || break; sleep 0.25; done
if kill -0 $G 2>/dev/null; then kill $G; wait $G 2>/dev/null; rc=started; else wait $G; rc=$?; fi
check "a claude without --strict-mcp-config: refuses to start" "$rc" 78

grep -q "tok-one\|tok-two\|$KEY" "$D/gw.log" "$D/gw2.log" && check "no token or key in the gateway log" leaked clean || check "no token or key in the gateway log" clean clean
[ $fails = 0 ] && echo "GATEWAY-BENCH: ALL PASS" || { echo "GATEWAY-BENCH: $fails FAILED"; tail -5 "$D/gw.log"; exit 1; }
