#!/usr/bin/env bash
# Fallback providers (app/providers.js): the Anthropic <-> OpenAI translation, provider order, skipping
# unkeyed providers, moving on after a 429/5xx/timeout, stopping on an auth error, the gateway falling
# through only when every account is capped, x-rotator-no-fallback, model-prefix routing, the dashboard
# routes and their setup-token guard, providers.json at 0600, and no key in any log or API response.
# Fake Fireworks, OpenRouter and Anthropic servers stand in for the real ones; nothing leaves the machine.
# Run: bash test/providers.test.sh   (temp files go under $TMPDIR)
set -u; cd "$(dirname "$0")/.."
fails=0
D=$(mktemp -d "${TMPDIR:-/tmp}/providers-test.XXXXXX"); F=""; B=""; G=""; S=""
trap 'kill $F $B $G $S 2>/dev/null; wait 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
FW=18401; OR=18402; AN=18403; DASH=18404; GWP=18405; SRV=18406
KFW="fw_test_$(node -p 'require("crypto").randomBytes(12).toString("hex")')"
KOR="sk-or-test-$(node -p 'require("crypto").randomBytes(12).toString("hex")')"
KAN="sk-ant-test-$(node -p 'require("crypto").randomBytes(12).toString("hex")')"
GKEY=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
UIT=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
mkdir -p "$D/secrets" "$D/one" "$D/two"; chmod 700 "$D/secrets"
for a in one two; do echo '{"claudeAiOauth":{"accessToken":"tok-'$a'","expiresAt":9999999999999}}' > "$D/$a/.credentials.json"; done
printf '%s' "$UIT" > "$D/secrets/ui-token"; chmod 600 "$D/secrets/ui-token"
echo "{\"port\":$SRV,\"pollMinutes\":60,\"accounts\":[{\"id\":\"one\",\"configDir\":\"$D/one\"},{\"id\":\"two\",\"configDir\":\"$D/two\"}]}" > "$D/accounts.json"
echo '{}' > "$D/mode.json"; : > "$D/hits.jsonl"

# Fake upstreams. mode.json: { "<provider>": "ok" | "429" | "500" | "401" | "slow" }. Each hit is logged
# (provider, body, whether the right key came) to hits.jsonl. A 401 echoes the key it got, the way some
# real APIs do, so the test can prove the key is scrubbed before it reaches a log or a response.
cat > "$D/fake.js" <<'EOF'
const http = require('http'), fs = require('fs');
const [D, fw, or, an, kfw, kor, kan] = process.argv.slice(2);
const srv = (name, port, key, anthropic) => http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d); q.on('end', () => {
    const body = JSON.parse(b || '{}');
    const got = anthropic ? q.headers['x-api-key'] : String(q.headers.authorization || '').replace(/^Bearer /, '');
    fs.appendFileSync(D + '/hits.jsonl', JSON.stringify({ name, body, keyOk: got === key }) + '\n');
    const mode = (JSON.parse(fs.readFileSync(D + '/mode.json', 'utf8'))[name]) || 'ok';
    const out = (c, o) => { s.writeHead(c, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (mode === '429') return out(429, { error: { message: 'rate limited' } });
    if (mode === '500') return out(500, { error: { message: 'upstream broke' } });
    if (mode === '401') return out(401, { error: { message: 'Incorrect API key provided: ' + got } });
    if (mode === 'slow') return setTimeout(() => out(200, {}), 5000);
    if (anthropic) return out(200, { id: 'msg_an', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'thinking', thinking: 'private chain', signature: 'x' }, { type: 'text', text: 'hello from anthropic' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } });
    out(200, { id: 'c1', model: body.model, choices: [{ index: 0, finish_reason: 'length',
      message: { role: 'assistant', content: '<think>private chain</think>hello from ' + name, reasoning: 'private chain' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } });
  });
}).listen(port);
srv('fireworks', +fw, kfw); srv('openrouter', +or, kor); srv('anthropic', +an, kan, true);
EOF
node "$D/fake.js" "$D" $FW $OR $AN "$KFW" "$KOR" "$KAN" & F=$!
# Fake dashboard: dash.json says whether both accounts are healthy or capped at 100%.
echo healthy > "$D/dash.mode"
node -e '
const [D,port]=process.argv.slice(1),fs=require("fs");require("http").createServer((q,s)=>{const capped=fs.readFileSync(D+"/dash.mode","utf8").trim()==="capped";
s.end(JSON.stringify({accounts:["one","two"].map(id=>({id,configDir:D+"/"+id,ok:true,eff5:capped?100:0,eff7:0,effModels:{}}))}))}).listen(+port)' "$D" $DASH & B=$!
# Fake claude: lists the isolation flags in --help, answers every -p call with "from-claude", or with
# Claude Code's "Not logged in" error while $D/claude.mode says nologin.
cat > "$D/claude" <<F
#!/bin/sh
if [ "\$1" = --help ]; then echo "  --strict-mcp-config x"; exit 0; fi
echo call >> "$D/claude-calls"
cat >/dev/null
if [ "\$(cat "$D/claude.mode" 2>/dev/null)" = nologin ]; then echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1; fi
echo '{"result":"from-claude","is_error":false,"usage":{}}'
F
chmod +x "$D/claude"

ENVV=(HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1
  CLAUDE_USAGE_API_BASE=http://127.0.0.1:1 CLAUDE_USAGE_FIREWORKS_URL=http://127.0.0.1:$FW/inference/v1/chat/completions
  CLAUDE_USAGE_OPENROUTER_URL=http://127.0.0.1:$OR/api/v1/chat/completions CLAUDE_USAGE_ANTHROPIC_API_URL=http://127.0.0.1:$AN/v1/messages
  CLAUDE_USAGE_PROVIDER_TIMEOUT_MS=1500)
env_() { env "${ENVV[@]}" "$@"; }
# Background services: exec, so $! is node itself and the EXIT trap stops it.
bgenv() { exec env "${ENVV[@]}" "$@"; }
perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else fails=$((fails+1)); echo "FAIL $1: expected $3, got $2"; fi; }
mode() { echo "$1" > "$D/mode.json"; : > "$D/hits.jsonl"; }
# Run one providers.js call in a fresh node; prints its JSON (or {"err":...,"code":...}).
pj() { env_ node -e '
const P=require("./app/providers");const [fn,arg]=process.argv.slice(1);const a=arg?JSON.parse(arg):undefined;
(async()=>{try{const r=await P[fn](...(Array.isArray(a)?a:[a]));console.log(JSON.stringify(r===undefined?{done:true}:r))}
catch(e){console.log(JSON.stringify({err:e.message,code:e.code,attempts:(e.attempts||[]).map(x=>x.provider+":"+x.kind)}))}})()' "$@" 2>&1; }
jq_() { node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{const v=(new Function("j","return "+process.argv[1]))(JSON.parse(b));console.log(typeof v==="string"?v:JSON.stringify(v))}catch(e){console.log("PARSE-ERR "+b.slice(0,200))}})' "$1"; }
hits() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);console.log(l.map(h=>h.name).join(",")||"none")' "$D/hits.jsonl"; }
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$DASH/ && curl -s -o /dev/null http://127.0.0.1:$AN/ && break; sleep 0.2; done

REQ='{"model":"claude-opus-5-5","max_tokens":64,"temperature":0.2,"stop_sequences":["END"],"system":[{"type":"text","text":"Be brief."},{"type":"text","text":"Plain words."}],"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"hello"}]},{"role":"user","content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}]}]}'

echo "== keys, list() and file modes"
check "no keys: list shows nothing configured" "$(pj list | jq_ 'j.map(p=>p.name+"="+p.configured).join(",")')" "fireworks=false,openrouter=false,anthropic=false"
check "no keys: complete() says so with 503" "$(pj complete "$REQ" | jq_ 'j.code+" "+/no fallback provider has an API key/.test(j.err)')" "503 true"
pj setKey "[\"fireworks\",\"$KFW\"]" >/dev/null; pj setKey "[\"openrouter\",\"$KOR\"]" >/dev/null; pj setKey "[\"anthropic\",\"$KAN\"]" >/dev/null
check "providers.json is mode 0600" "$(perm "$D/secrets/providers.json")" 600
check "secrets dir stays 0700" "$(perm "$D/secrets")" 700
L=$(pj list)
check "list shows all three configured" "$(echo "$L" | jq_ 'j.filter(p=>p.configured).length')" 3
check "keyHint is the last 4 characters only" "$(echo "$L" | jq_ 'j[0].keyHint')" "…${KFW: -4}"
check "default models are the latest Kimi and Sonnet" "$(echo "$L" | jq_ 'j.map(p=>p.model).join(",")')" "accounts/fireworks/models/kimi-k3,moonshotai/kimi-k3,claude-sonnet-5-5"
case "$L" in *"$KFW"*|*"$KOR"*|*"$KAN"*) check "list() never returns a key" leaked clean;; *) check "list() never returns a key" clean clean;; esac
check "setKey refuses an unknown provider" "$(pj setKey '["nope","abcdefgh12"]' | jq_ 'j.code')" 400
check "setKey refuses a key with spaces" "$(pj setKey '["fireworks","abc def ghi"]' | jq_ 'j.code')" 400

echo "== translation round trip (Fireworks first)"
mode '{}'
R=$(pj complete "$REQ")
check "served by fireworks" "$(echo "$R" | jq_ 'j.provider')" fireworks
check "response model is the provider model" "$(echo "$R" | jq_ 'j.model')" "accounts/fireworks/models/kimi-k3"
check "inline <think> text is stripped" "$(echo "$R" | jq_ 'j.content[0].text')" "hello from fireworks"
case "$R" in *"private chain"*) check "no reasoning text anywhere in the reply" leaked clean;; *) check "no reasoning text anywhere in the reply" clean clean;; esac
check "finish_reason length -> stop_reason max_tokens" "$(echo "$R" | jq_ 'j.stop_reason')" max_tokens
check "usage maps (input excludes cache reads)" "$(echo "$R" | jq_ '[j.usage.input_tokens,j.usage.output_tokens,j.usage.cache_read_input_tokens].join(",")')" "10,5,2"
check "Anthropic message shape" "$(echo "$R" | jq_ '[j.type,j.role,j.content[0].type,/^msg_/.test(j.id)].join(",")')" "message,assistant,text,true"
H=$(head -1 "$D/hits.jsonl")
check "sent with the fireworks key" "$(echo "$H" | jq_ 'j.keyOk')" true
check "system blocks become one system message" "$(echo "$H" | jq_ 'j.body.messages[0].role+"|"+j.body.messages[0].content')" "system|Be brief.
Plain words."
check "multi-turn roles kept in order" "$(echo "$H" | jq_ 'j.body.messages.map(m=>m.role).join(",")')" "system,user,assistant,user"
check "thinking block in history dropped, text kept" "$(echo "$H" | jq_ 'j.body.messages[2].content')" hello
check "text blocks joined" "$(echo "$H" | jq_ 'j.body.messages[3].content')" "part one
part two"
check "max_tokens, temperature, stop carried" "$(echo "$H" | jq_ '[j.body.max_tokens,j.body.temperature,j.body.stop.join("")].join(",")')" "64,0.2,END"
check "Fireworks gets reasoning_effort none, no reasoning field" "$(echo "$H" | jq_ 'j.body.reasoning_effort+","+(j.body.reasoning===undefined)')" "none,true"
check "Fireworks model slug" "$(echo "$H" | jq_ 'j.body.model')" "accounts/fireworks/models/kimi-k3"

echo "== order, skipping, 429 / 5xx / timeout, auth"
mode '{"fireworks":"429"}'; R=$(pj complete "$REQ")
check "429 on fireworks -> openrouter serves" "$(echo "$R" | jq_ 'j.provider')" openrouter
check "both were tried, in order" "$(hits)" "fireworks,openrouter"
H=$(sed -n 2p "$D/hits.jsonl")
check "OpenRouter gets reasoning off + Moonshot hosting ignored" "$(echo "$H" | jq_ 'j.body.reasoning.enabled+","+j.body.provider.ignore.join("")')" "false,Moonshot AI"
check "OpenRouter model slug" "$(echo "$H" | jq_ 'j.body.model')" "moonshotai/kimi-k3"
mode '{"fireworks":"500","openrouter":"slow"}'; R=$(pj complete "$REQ")
check "500 then timeout -> anthropic serves" "$(echo "$R" | jq_ 'j.provider')" anthropic
check "anthropic leg keeps the requested Claude model" "$(echo "$R" | jq_ 'j.model')" claude-opus-5-5
check "anthropic thinking blocks stripped" "$(echo "$R" | jq_ 'j.content.map(b=>b.type).join(",")')" text
H=$(sed -n 3p "$D/hits.jsonl")
check "anthropic leg: x-api-key sent, temperature dropped for the 5 family" "$(echo "$H" | jq_ 'j.keyOk+","+(j.body.temperature===undefined)')" "true,true"
mode '{"fireworks":"401"}'; R=$(pj complete "$REQ")
check "401 stops the chain" "$(echo "$R" | jq_ 'j.code')" auth
check "nothing after the auth failure was called" "$(hits)" fireworks
check "auth error names the provider" "$(echo "$R" | jq_ '/Fireworks rejected the API key \(HTTP 401\)/.test(j.err)')" true
case "$R" in *"$KFW"*) check "echoed key is scrubbed from the error" leaked clean;; *) check "echoed key is scrubbed from the error" clean clean;; esac
mode '{"fireworks":"429","openrouter":"429","anthropic":"500"}'; R=$(pj complete "$REQ")
check "all transient failures -> 503 with every attempt" "$(echo "$R" | jq_ 'j.code+" "+j.attempts.join(",")')" "503 fireworks:next,openrouter:next,anthropic:next"
mode '{}'; pj removeKey "\"fireworks\"" >/dev/null
check "removeKey keeps 0600" "$(perm "$D/secrets/providers.json")" 600
R=$(pj complete "$REQ")
check "unkeyed fireworks is skipped without a call" "$(echo "$R" | jq_ 'j.provider')+$(hits)" "openrouter+openrouter"
pj setKey "[\"fireworks\",\"$KFW\"]" >/dev/null
pj setFallback '{"order":["anthropic","fireworks"]}' >/dev/null
mode '{}'; R=$(pj complete "$REQ")
check "custom order: anthropic first" "$(echo "$R" | jq_ 'j.provider')" anthropic
mode '{"anthropic":"429"}'; R=$(pj complete "$REQ")
check "openrouter left out of the order is never used" "$(echo "$R" | jq_ 'j.provider')+$(hits)" "fireworks+anthropic,fireworks"
check "setFallback refuses an unknown provider" "$(pj setFallback '{"order":["fireworks","bogus"]}' | jq_ 'j.code')" 400
pj setFallback '{"order":["fireworks","openrouter","anthropic"]}' >/dev/null
TOOLS='{"model":"claude-opus-5-5","max_tokens":5,"tools":[{"name":"t","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hi"}]}'
mode '{}'; R=$(pj complete "$TOOLS")
check "tool request: OpenAI-style providers decline, anthropic serves" "$(echo "$R" | jq_ 'j.provider')+$(hits)" "anthropic+anthropic"

echo "== gateway"
genv() { bgenv CLAUDE_USAGE_DASH=http://127.0.0.1:$DASH CLAUDE_USAGE_GATEWAY_PORT=$GWP CLAUDE_USAGE_GATEWAY_KEY="$GKEY" CLAUDE_BIN="$D/claude" "$@"; }
genv node app/gateway.js > "$D/gw.log" 2>&1 & G=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$GWP/healthz && break; sleep 0.3; done
gpost() { # model [extra header] -> "code|path|provider|text"
  curl -s -m 30 -D "$D/h.txt" -o "$D/b.json" -w '%{http_code}' http://127.0.0.1:$GWP/v1/messages -H 'content-type: application/json' -H "x-gateway-key: $GKEY" ${2:+-H "$2"} \
    -d "{\"model\":\"$1\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" > "$D/code"
  printf '%s|%s|%s|%s' "$(cat "$D/code")" "$(grep -i '^x-gateway-path:' "$D/h.txt" | tr -d '\r' | awk '{print $2}')" \
    "$(grep -i '^x-gateway-provider:' "$D/h.txt" | tr -d '\r' | awk '{print $2}')" "$(jq_ 'j.content?j.content[0].text:j.error.message' < "$D/b.json")"; }
mode '{}'; rm -f "$D/claude-calls"
check "healthy accounts: claude -p serves, no provider called" "$(gpost claude-sonnet-5-5)+$(hits)" "200|cli||from-claude+none"
echo capped > "$D/dash.mode"
check "every account capped: falls through to fireworks" "$(gpost claude-sonnet-5-5)" "200|fallback|fireworks|hello from fireworks"
mode '{}'
check "x-rotator-no-fallback: 1 keeps the 503" "$(gpost claude-sonnet-5-5 'x-rotator-no-fallback: 1' | cut -d'|' -f1)+$(hits)" "503+none"
mode '{"fireworks":"401"}'
R=$(gpost claude-sonnet-5-5)
check "fallback auth error -> 502 authentication_error, chain stopped" "$(cut -d'|' -f1 <<< "$R")+$(jq_ 'j.error.type' < "$D/b.json")+$(hits)" "502+authentication_error+fireworks"
cp "$D/b.json" "$D/api-gw401.json"
gtools() { curl -s -m 30 -D "$D/h.txt" -o "$D/b.json" -w '%{http_code}' http://127.0.0.1:$GWP/v1/messages -H 'content-type: application/json' -H "x-gateway-key: $GKEY" ${1:+-H "$1"} -d "$TOOLS"; }
mode '{}'
check "tools, every account capped: the Anthropic key serves it" "$(gtools)+$(grep -i '^x-gateway-provider:' "$D/h.txt" | tr -d '\r' | awk '{print $2}')+$(hits)" "200+anthropic+anthropic"
mode '{}'
check "tools, capped, x-rotator-no-fallback: 1 -> 422, no provider" "$(gtools 'x-rotator-no-fallback: 1')+$(hits)" "422+none"
pj removeKey '"anthropic"' >/dev/null; mode '{}'
check "tools, capped, no Anthropic key -> the cli path's 422, not a 503" "$(gtools)+$(jq_ 'j.error.type' < "$D/b.json")+$(hits)" "422+invalid_request_error+none"
pj setKey "[\"anthropic\",\"$KAN\"]" >/dev/null
echo healthy > "$D/dash.mode"; mode '{}'
check "tools, accounts healthy -> 422, no provider" "$(gtools)+$(hits)" "422+none"
echo capped > "$D/dash.mode"
echo healthy > "$D/dash.mode"; mode '{}'; rm -f "$D/claude-calls"
check "prefix openrouter: goes straight there with accounts healthy" "$(gpost openrouter:moonshotai/kimi-k3)" "200|provider|openrouter|hello from openrouter"
check "prefix call never ran claude -p" "$([ -f "$D/claude-calls" ] && echo ran || echo none)" none
mode '{}'
check "prefix anthropic-api: with a model" "$(gpost anthropic-api:claude-haiku-5-5)" "200|provider|anthropic|hello from anthropic"
check "anthropic-api: got the named model" "$(head -1 "$D/hits.jsonl" | jq_ 'j.body.model')" claude-haiku-5-5
mode '{}'
check "prefix fireworks: with no slug uses the configured model" "$(gpost fireworks: | cut -d'|' -f1-3)+$(head -1 "$D/hits.jsonl" | jq_ 'j.body.model')" "200|provider|fireworks+accounts/fireworks/models/kimi-k3"
mode '{"openrouter":"429"}'
check "prefix routing does not fall to another provider" "$(gpost openrouter:moonshotai/kimi-k3 | cut -d'|' -f1)+$(hits)" "503+openrouter"
pj removeKey "\"openrouter\"" >/dev/null
check "prefix to an unkeyed provider -> 400 that says so" "$(gpost openrouter:x | cut -d'|' -f1)+$(jq_ '/no API key/.test(j.error.message)' < "$D/b.json")" "400+true"
pj setKey "[\"openrouter\",\"$KOR\"]" >/dev/null
grep -q 'provider=fireworks served=accounts/fireworks/models/kimi-k3 path=fallback' "$D/gw.log" && check "gateway log names provider + model" yes yes || check "gateway log names provider + model" no yes
pj setFallback '{"enabled":false}' >/dev/null; echo capped > "$D/dash.mode"; mode '{}'
check "fallback.enabled false: no fall-through" "$(gpost claude-sonnet-5-5 | cut -d'|' -f1)+$(hits)" "503+none"
pj setFallback '{"enabled":true}' >/dev/null
# A dead login is not the caller's problem: bench that account, try the next, then the providers.
echo healthy > "$D/dash.mode"; echo nologin > "$D/claude.mode"; mode '{}'; rm -f "$D/claude-calls"
check "every login dead (Not logged in): served by a provider, not a 502" "$(gpost claude-sonnet-5-5)" "200|fallback|fireworks|hello from fireworks"
check "both accounts were tried before the providers" "$(wc -l < "$D/claude-calls" | tr -d ' ')" 2
check "the gateway log names the login error" "$(grep -c 'login error on one' "$D/gw.log")" 1
check "/healthz lists both accounts as benched" "$(curl -s http://127.0.0.1:$GWP/healthz | jq_ 'j.benched.sort().join()')" "one,two"
rm -f "$D/claude.mode"
kill $G 2>/dev/null; wait $G 2>/dev/null; G=""

echo "== dashboard routes"
# The test hook lets a request claim a non-loopback peer (it can only take rights away).
bgenv CLAUDE_USAGE_TEST_REMOTE_HOOK=1 node app/server.js > "$D/srv.log" 2>&1 & S=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$SRV/healthz && break; sleep 0.3; done
api() { curl -s -m 15 -o "$D/api.json" -w '%{http_code}' "$@"; }
U=http://127.0.0.1:$SRV
check "GET /api/providers is open (no secrets in it)" "$(api $U/api/providers)" 200
check "it lists three providers + the fallback order" "$(jq_ 'j.providers.length+" "+j.fallback.order.join(",")' < "$D/api.json")" "3 fireworks,openrouter,anthropic"
cp "$D/api.json" "$D/api-get.json"
check "POST key without the setup token -> 403" "$(api -X POST $U/api/providers/fireworks -d '{"apiKey":"fw_new_key_123456"}')" 403
check "POST key with a wrong token -> 403" "$(api -X POST -H "x-rotator-ui-token: ${UIT%?}x" $U/api/providers/fireworks -d '{"apiKey":"fw_new_key_123456"}')" 403
check "DELETE without the token -> 403" "$(api -X DELETE $U/api/providers/anthropic)" 403
check "POST test without the token -> 403" "$(api -X POST $U/api/providers/fireworks/test)" 403
check "POST /api/fallback without the token -> 403" "$(api -X POST $U/api/fallback -d '{"enabled":false}')" 403
check "no-token calls changed nothing" "$(pj list | jq_ 'j.map(p=>p.configured).join(",")')+$(pj config | jq_ 'j.enabled')" "true,true,true+true"
T="x-rotator-ui-token: $UIT"
R="x-test-remote-nonlocal: 1"
check "POST key from a non-loopback peer, right token -> 403" "$(api -X POST -H "$T" -H "$R" $U/api/providers/fireworks -d '{"apiKey":"fw_new_key_123456"}')" 403
check "DELETE from a non-loopback peer, right token -> 403" "$(api -X DELETE -H "$T" -H "$R" $U/api/providers/anthropic)" 403
check "POST test from a non-loopback peer, right token -> 403" "$(api -X POST -H "$T" -H "$R" $U/api/providers/fireworks/test)" 403
check "POST /api/fallback from a non-loopback peer, right token -> 403" "$(api -X POST -H "$T" -H "$R" $U/api/fallback -d '{"enabled":false}')" 403
check "non-loopback calls changed nothing" "$(pj list | jq_ 'j.map(p=>p.configured).join(",")')+$(pj config | jq_ 'j.enabled')" "true,true,true+true"
check "POST key with the token -> 200 ok" "$(api -X POST -H "$T" $U/api/providers/fireworks -d "{\"apiKey\":\"$KFW\"}")+$(jq_ 'j.ok' < "$D/api.json")" "200+true"
cp "$D/api.json" "$D/api-post.json"
check "response carries the hint, not the key" "$(jq_ 'j.providers[0].keyHint' < "$D/api.json")" "…${KFW: -4}"
check "providers.json still 0600 after a dashboard save" "$(perm "$D/secrets/providers.json")" 600
mode '{}'
check "POST test with the token -> ok" "$(api -X POST -H "$T" $U/api/providers/fireworks/test)+$(jq_ 'j.ok+" "+j.model' < "$D/api.json")" "200+true accounts/fireworks/models/kimi-k3"
mode '{"anthropic":"401"}'
check "test() reports an auth failure without the key" "$(api -X POST -H "$T" $U/api/providers/anthropic/test)+$(jq_ 'j.ok' < "$D/api.json")" "200+false"
cp "$D/api.json" "$D/api-test401.json"
check "POST /api/fallback with the token -> 200 ok" "$(api -X POST -H "$T" $U/api/fallback -d '{"order":["openrouter","fireworks","anthropic"]}')+$(jq_ 'j.ok+" "+j.fallback.order[0]' < "$D/api.json")" "200+true openrouter"
check "unparseable body -> 400" "$(api -X POST -H "$T" $U/api/providers/fireworks -d '{not json')" 400
head -c 70000 /dev/zero | tr '\0' 'a' > "$D/big.json"
check "body over 64 KB -> 413" "$(api -X POST -H "$T" $U/api/providers/fireworks --data-binary @"$D/big.json")" 413
check "bad fallback body -> 400" "$(api -X POST -H "$T" $U/api/fallback -d '{"enabled":"yes"}')" 400
check "unknown provider -> 400" "$(api -X POST -H "$T" $U/api/providers/bogus -d '{"apiKey":"abcdefgh12"}')" 400
check "cross-origin POST refused before the token check" "$(api -X POST -H "$T" -H 'Origin: http://evil.test.invalid' $U/api/providers/fireworks -d '{"apiKey":"abcdefgh12"}')" 403
check "DELETE with the token -> 200" "$(api -X DELETE -H "$T" $U/api/providers/anthropic)+$(jq_ 'j.providers[2].configured' < "$D/api.json")" "200+false"
cp "$D/api.json" "$D/api-del.json"
rm -f "$D/secrets/ui-token"
check "no ui-token file: guarded routes refuse" "$(api -X POST -H "$T" $U/api/fallback -d '{"enabled":true}')" 403

echo "== no key in any log or API response"
leak=clean
for k in "$KFW" "$KOR" "$KAN"; do grep -rqF -- "$k" "$D/gw.log" "$D/srv.log" "$D"/api-*.json "$D/b.json" && leak="leaked in $(grep -rlF -- "$k" "$D/gw.log" "$D/srv.log" "$D"/api-*.json "$D/b.json" | xargs -n1 basename | tr '\n' ' ')"; done
check "no provider key in gateway log, server log or responses" "$leak" clean

[ $fails = 0 ] && echo "PROVIDERS: ALL PASS" || { echo "PROVIDERS: $fails FAILED"; tail -5 "$D/gw.log" "$D/srv.log"; exit 1; }
