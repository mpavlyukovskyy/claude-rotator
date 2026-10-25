#!/usr/bin/env bash
# Regression: `ccr --resume` (any first arg starting with "-") picks an account and passes the arg to
# claude instead of reading it as an account name; `ccr <id>` and `ccr <N>` still pick that account; and
# `ccr add` refuses names that read as a subcommand or a number. Uses a fake dashboard and a fake claude.
# Run: bash test/ccr.test.sh [app-dir]
set -u; cd "$(dirname "$0")/.."
APP="${1:-$PWD/app}"; fails=0
D=$(mktemp -d); S=""; trap 'kill $S 2>/dev/null; wait 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
mkdir -p "$D/bin" "$D/.claude" "$D/.claude-accounts/two"
cat > "$D/bin/claude" <<'F'
#!/bin/sh
printf 'ARGS:%s\n' "$*"; printf 'DIR:%s\n' "${CLAUDE_CONFIG_DIR:-default}"
F
chmod +x "$D/bin/claude"
echo "{\"port\":17930,\"accounts\":[{\"id\":\"main\",\"label\":\"main\",\"configDir\":\"~/.claude\",\"default\":true},{\"id\":\"two\",\"label\":\"two\",\"configDir\":\"~/.claude-accounts/two\"}]}" > "$D/accounts.json"
# Fake dashboard: both accounts healthy, main first (the order /api/state would give).
node -e '
const d=process.argv[1];require("http").createServer((q,s)=>{s.end(JSON.stringify({accounts:[
 {id:"main",configDir:d+"/.claude",default:true,ok:true,eff5:10,eff7:10,headroom:90,drainTier:0},
 {id:"two",configDir:d+"/.claude-accounts/two",ok:true,eff5:20,eff7:20,headroom:80,drainTier:0}]}))}).listen(17930)' "$D" & S=$!
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17930/ && break; sleep 0.2; done
NODE_DIR=$(dirname "$(command -v node)")
R() { env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_PICK_ACCOUNT -u CLAUDE_USAGE_ACCOUNT HOME="$D" PATH="$D/bin:$NODE_DIR:/usr/bin:/bin" \
  CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" CLAUDE_USAGE_NO_KEYCHAIN=1 bash "$APP/ccr" "$@" 2>"$D/err" </dev/null; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else fails=$((fails+1)); echo "FAIL $1: expected [$3], got [$2] $(head -c 200 "$D/err")"; fi; }
line() { printf '%s\n' "$1" | sed -n "s/^$2://p"; }

out=$(R --resume abc); check "ccr --resume abc passes the args to claude" "$(line "$out" ARGS)" "--resume abc"
check "ccr --resume picks the best account (main, default dir)" "$(line "$out" DIR)" "default"
out=$(R -p hi); check "ccr -p hi passes the args to claude" "$(line "$out" ARGS)" "-p hi"
out=$(R two --resume); check "ccr two --resume runs on two" "$(line "$out" DIR)" "$D/.claude-accounts/two"
check "ccr two --resume passes --resume" "$(line "$out" ARGS)" "--resume"
out=$(R 2); check "ccr 2 runs on the second account" "$(line "$out" DIR)" "$D/.claude-accounts/two"
out=$(R bogus); rc=$?
check "ccr bogus fails" "$rc" 1
check "ccr bogus never starts claude" "$out" ""

for bad in ls run web add pick help ui login mcp 123 9lives Bad "-x" "a/b" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; do
  R add "$bad" --no-login >/dev/null; rc=$?
  check "ccr add '$bad' is refused" "$([ "$rc" != 0 ] && echo refused || echo accepted)" refused
done
node -e 'process.exit(require(process.argv[1]).accounts.length===2?0:1)' "$D/accounts.json"
check "refused names left accounts.json alone" "$?" 0
out=$(R add a_b-1 --no-login 2>/dev/null); rc=$?
check "ccr add a_b-1 is accepted" "$rc" 0
check "ccr add --no-login points at ccr login <id>" "$(printf '%s\n' "$out" | grep -c 'ccr login a_b-1')" 1
node -e 'process.exit(require(process.argv[1]).accounts.some(a=>a.id==="a_b-1")?0:1)' "$D/accounts.json"
check "a_b-1 is in accounts.json" "$?" 0
# reregister: kept ~/.claude-accounts dirs come back at the END, existing order and flags untouched,
# and every skipped dir is printed with its reason.
node -e 'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.accounts[1].lastResort=true;j.accounts[1].label="Two (spare)";fs.writeFileSync(p,JSON.stringify(j))' "$D/accounts.json"
mkdir -p "$D/.claude-accounts/new1" "$D/.claude-accounts/Bad" "$D/.claude-accounts/ls" "$D/.claude-accounts/9x"
: > "$D/.claude-accounts/notes.txt"
out=$(env HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" node "$APP/ccr-helper.js" reregister "$D/.claude-accounts" 2>&1)
printf '%s\n' "$out" | sed 's/^/    /'
order=$(node -e 'console.log(require(process.argv[1]).accounts.map(a=>a.id).join(","))' "$D/accounts.json")
check "reregister keeps the order and appends new dirs at the end" "$order" "main,two,a_b-1,new1"
flags=$(node -e 'const a=require(process.argv[1]).accounts[1];console.log(a.lastResort+"|"+a.label)' "$D/accounts.json")
check "reregister keeps lastResort and label" "$flags" "true|Two (spare)"
for x in "Bad: name must" "ls: name is a ccr command" "9x: name must" "notes.txt: not a directory"; do
  check "reregister reports skipped $x" "$(printf '%s' "$out" | grep -c "skipped $D/.claude-accounts/$x")" 1
done
check "reregister names what it added" "$(printf '%s' "$out" | grep -c 're-registered from .*: new1$')" 1
out2=$(env HOME="$D" CLAUDE_USAGE_DATA="$D" CLAUDE_USAGE_CONFIG="$D/accounts.json" node "$APP/ccr-helper.js" reregister "$D/.claude-accounts" 2>&1)
check "a second reregister adds nothing" "$(printf '%s' "$out2" | grep -c 're-registered')" 0
[ $fails = 0 ] && echo "CCR: ALL PASS" || { echo "CCR: $fails FAILED"; exit 1; }
