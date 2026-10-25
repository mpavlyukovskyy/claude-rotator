#!/usr/bin/env bash
# Regression: one login copied to two machines = one rotating refresh-token chain with two refreshers; the
# first refresh revokes the other copy (invalid_grant). The dashboard must flag the copy the moment both
# hold it. Run: bash test/shared-chain.test.sh [server.js]
set -u; cd "$(dirname "$0")/.."
SRV=${1:-app/server.js}; fails=0
FP=$(printf '%s' 'RT-SAME' | shasum -a 256 | cut -c1-12)
J() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s),a=(d.accounts||[]).filter(x=>x.id==="copy");
  if(!a.length||!a[0].checkedAt)return console.log("");
  if(!a[0].sharedChain)return console.log("no");
  console.log(a[0].drainTier===3&&d.recommended!=="copy"?"yes":"flagged-but-still-ranked")}catch(_){console.log("")}})'; }
run() { # name remote-fingerprint expect(yes|no)
  D=$(mktemp -d); mkdir -p "$D/state" "$D/acct"
  echo '{"claudeAiOauth":{"accessToken":"x","refreshToken":"RT-SAME","expiresAt":9999999999999}}' > "$D/acct/.credentials.json"
  echo '{"oauthAccount":{"emailAddress":"copy@test.invalid"}}' > "$D/acct/.claude.json"
  # fake remote dashboard + fake Anthropic API (401 for everything), so no call leaves the machine
  node -e 'require("http").createServer((q,s)=>{s.end(JSON.stringify({accounts:[{id:"twin",label:"twin",email:"twin@test.invalid",ok:true,credFp:process.argv[1]}]}))}).listen(17901)' "$2" & R=$!
  node -e 'require("http").createServer((q,s)=>{s.writeHead(401);s.end("{}")}).listen(17902)' & A=$!
  echo "{\"port\":17900,\"pollMinutes\":60,\"accounts\":[{\"id\":\"copy\",\"label\":\"copy\",\"configDir\":\"$D/acct\"}],\"remotes\":[{\"label\":\"fake\",\"url\":\"http://127.0.0.1:17901\"}]}" > "$D/accounts.json"
  HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1 \
    CLAUDE_USAGE_API_BASE=http://127.0.0.1:17902 node "$SRV" >/dev/null 2>&1 & S=$!
  got=""; for _ in $(seq 1 30); do sleep 1
    # "yes" = flagged AND demoted to the broken tier AND not recommended; anything half-done is a failure.
    got=$(curl -s http://127.0.0.1:17900/api/state | J)
    [ -n "$got" ] && break; done
  kill $S $R $A 2>/dev/null; wait $S $R $A 2>/dev/null; rm -rf "$D"
  if [ "$got" = "$3" ]; then echo "PASS $1 (sharedChain=$got)"; else fails=$((fails+1)); echo "FAIL $1: expected $3, got '${got:-no answer}'"; fi
}
run "same login on both machines is flagged" "$FP"          yes
run "different logins are not flagged"       "000000000000" no
[ $fails = 0 ] && echo "SHARED-CHAIN: ALL PASS" || { echo "SHARED-CHAIN: $fails FAILED"; exit 1; }
