#!/usr/bin/env bash
# Regression: a session's live usage lands on the account its OWN reset times belong to, never on the one the
# env/config dir guesses. A session still running on login "two" in the default dir (which was re-logged as
# "one") must not put two's windows on one's card. Run: bash test/statusline.test.sh [statusline.js]
set -u
SL=${1:-$(dirname "$0")/../app/statusline.js}; SL=$(cd "$(dirname "$SL")" && pwd)/$(basename "$SL")
D=$(mktemp -d); mkdir -p "$D/state/live"
cat > "$D/accounts.json" <<'J'
{"port":17788,"accounts":[{"id":"main","label":"Main","configDir":"~/.claude","default":true},{"id":"two","label":"two@test","configDir":"~/.claude-accounts/two"}],"nicknames":{"one@test.invalid":"one"}}
J
# Polled truth, relative to now so no window has rolled: main = one, two = two, remote far.
eval "$(node -e '
const n=Math.floor(Date.now()/1000/600)*600, iso=s=>new Date(s*1000).toISOString();
const W={one:[n+7200,n+400000],two:[n+7800,n+100000],far:[n+8400,n+300000],alien:[n+9999,n+599999]};
const st={accounts:[
 {id:"main",ok:true,email:"one@test.invalid",fiveHour:{pct:40,resetsAt:iso(W.one[0])},sevenDay:{pct:6,resetsAt:iso(W.one[1])}},
 {id:"two",ok:true,email:"two@test.invalid",fiveHour:{pct:1,resetsAt:iso(W.two[0])},sevenDay:{pct:60,resetsAt:iso(W.two[1])}}],
 remotes:[{label:"other-host",accounts:[{id:"other-host:far",ok:true,email:"far@test.invalid",label:"far@test",fiveHour:{pct:5,resetsAt:iso(W.far[0])},sevenDay:{pct:20,resetsAt:iso(W.far[1])}}]}]};
require("fs").writeFileSync(process.argv[1],JSON.stringify(st));
const rl=(k,a,b)=>JSON.stringify({model:{display_name:"Opus"},rate_limits:{five_hour:{used_percentage:a,resets_at:W[k][0]},seven_day:{used_percentage:b,resets_at:W[k][1]}}});
console.log(`one=${JSON.stringify(rl("one",41,7))}; two=${JSON.stringify(rl("two",2,61))}; far=${JSON.stringify(rl("far",6,21))}; alien=${JSON.stringify(rl("alien",9,9))}`);
' "$D/state/state.json")"
fails=0
run() { # name input env expected-file|NONE expected-label-prefix
  rm -f "$D"/state/live/*.json
  out=$(printf '%s' "$2" | env -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CONFIG_DIR -u CLAUDE_PICK_ACCOUNT HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1 $3 node "$SL")
  files=$(ls "$D/state/live" | tr '\n' ' ')
  if [ "$4" = NONE ]; then ok=$([ -z "$files" ] && echo 1); else ok=$([ "$files" = "$4 " ] && echo 1); fi
  case "$out" in "[$5"*) ;; *) ok="";; esac
  if [ -n "$ok" ]; then echo "PASS $1 -> ${files:-no file} $out"; else fails=$((fails+1)); echo "FAIL $1: files=[$files] out=$out"; fi
}
run "own session, default dir"                   "$one"   ""                          main.json  "one]"
run "two's session in the default dir"           "$two"   ""                          two.json   "two@test]"
run "picked main but running on two"             "$two"   "CLAUDE_PICK_ACCOUNT=main"  two.json   "two@test]"
run "picked two, token stripped"                 "$two"   "CLAUDE_PICK_ACCOUNT=two"   two.json   "two@test]"
run "remote session writes no local card"        "$far"   "CLAUDE_PICK_ACCOUNT=far"   NONE       "far@test]"
run "unknown login writes nothing, flags ?"      "$alien" ""                          NONE       "Main?]"
mv "$D/state/state.json" "$D/state/s.bak"
run "no poll to verify against: writes nothing"  "$one"   ""                          NONE       "Main]"
rm -rf "$D"; [ $fails = 0 ] && echo "STATUSLINE: ALL PASS" || { echo "STATUSLINE: $fails FAILED"; exit 1; }
