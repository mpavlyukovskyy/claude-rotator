#!/usr/bin/env bash
# Regression: app/node-run skips any node older than 18 (CLAUDE_USAGE_NODE, PATH or nvm) and moves on to
# the next candidate; with none new enough it exits 127 with a clear message. Uses fake node binaries.
# Run: bash test/node-run.test.sh [node-run]
set -u; cd "$(dirname "$0")/.."
NR=${1:-app/node-run}; NR="$(cd "$(dirname "$NR")" && pwd)/$(basename "$NR")"; fails=0
D=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $D" || rm -rf "$D"' EXIT
fake() { # path version
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\nif [ "$1" = --version ]; then echo %s; else echo "ran %s"; fi\n' "$2" "$2" > "$1"; chmod +x "$1"; }
fake "$D/old/node" v16.20.2
fake "$D/dir with space/node" v17.9.1
fake "$D/home/.nvm/versions/node/v9.11.2/bin/node" v9.11.2
fake "$D/home/.nvm/versions/node/v20.11.1/bin/node" v20.11.1
fake "$D/home/.nvm/versions/node/v18.19.0/bin/node" v18.19.0
fake "$D/new/node" v22.1.0
# A PATH of symlinked tools that holds no node: /usr/bin on Linux has its own node, which would win.
mkdir -p "$D/tools"
for t in sh sed awk sort cut dirname; do ln -s "$(command -v "$t")" "$D/tools/$t"; done
TP="$D/tools"
R() { env -i HOME="$D/home" NODE_RUN_SEARCH= "$@" "$NR" x.js 2>"$D/err"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else fails=$((fails+1)); echo "FAIL $1: expected [$3], got [$2] $(head -c 300 "$D/err")"; fi; }

check "too-old CLAUDE_USAGE_NODE and PATH nodes are skipped; newest nvm >= 18 runs" \
  "$(R CLAUDE_USAGE_NODE="$D/old/node" PATH="$D/old:$D/dir with space:$TP")" "ran v20.11.1"
grep -q "skipping $D/old/node (v16.20.2" "$D/err"; check "the skip is reported with the version" "$?" 0
grep -q "skipping $D/dir with space/node (v17.9.1" "$D/err"; check "a PATH dir with a space is one candidate" "$?" 0
check "a node >= 18 on PATH wins over nvm" "$(R PATH="$D/old:$D/new:$TP")" "ran v22.1.0"
check "a good CLAUDE_USAGE_NODE wins" "$(R CLAUDE_USAGE_NODE="$D/new/node" PATH="$D/old:$TP")" "ran v22.1.0"
rm -rf "$D/home/.nvm/versions/node/v20.11.1" "$D/home/.nvm/versions/node/v18.19.0"
out=$(R PATH="$D/old:$TP"); rc=$?
check "no node >= 18 anywhere: exit 127" "$rc" 127
check "no node >= 18 anywhere: nothing runs" "$out" ""
grep -q "no Node 18 or later found" "$D/err"; check "no node >= 18 anywhere: clear message" "$?" 0
check "the real node still runs" "$(env -i HOME="$HOME" PATH=/usr/bin:/bin "$NR" -e 'console.log(+process.versions.node.split(".")[0] >= 18)' 2>/dev/null)" true
[ $fails = 0 ] && echo "NODE-RUN: ALL PASS" || { echo "NODE-RUN: $fails FAILED"; exit 1; }
