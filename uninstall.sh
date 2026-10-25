#!/usr/bin/env bash
# Removes what install.sh added: services, the ccr link, the shell line, the status line (only if it
# still points at this app) and $CLAUDE_USAGE_DATA (app, config, state, secrets).
# Asks before deleting ~/.claude-accounts, because those dirs hold your extra logins.
# Never touches ~/.claude itself or the default account's login.
# Run it with the same CLAUDE_USAGE_LABEL / CLAUDE_USAGE_UNIT_SUFFIX / CLAUDE_USAGE_DATA as install.sh.
set -euo pipefail
DATA="${CLAUDE_USAGE_DATA:-$HOME/.local/share/claude-usage}"
LABEL="${CLAUDE_USAGE_LABEL:-local.claude-usage}"
SUFFIX="${CLAUDE_USAGE_UNIT_SUFFIX:-}"
NODE="${CLAUDE_USAGE_NODE:-$(command -v node || true)}"

case "$DATA" in ""|"/"|"$HOME"|"$HOME/") echo "refusing: CLAUDE_USAGE_DATA=$DATA looks wrong" >&2; exit 1;; esac

# --- services
if [ "$(uname)" = Darwin ]; then
  for l in "$LABEL" "$LABEL.gateway" "$LABEL.gateway-watchdog"; do
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null && echo "stopped launchd $l" || true
    rm -f "$HOME/Library/LaunchAgents/$l.plist"
  done
elif command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  for u in "claude-usage$SUFFIX.service" "claude-gateway$SUFFIX.service" "claude-gateway-watchdog$SUFFIX.timer" "claude-gateway-watchdog$SUFFIX.service"; do
    [ -f "$UNIT_DIR/$u" ] || continue
    # disable also removes a link made with CLAUDE_USAGE_SYSTEMD_LINK=1
    systemctl --user disable --now "$u" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$u" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$u"; echo "removed systemd --user $u"
  done
  systemctl --user daemon-reload 2>/dev/null || true
fi

# --- ccr link
if [ -L "$HOME/.local/bin/ccr" ] && [ "$(readlink "$HOME/.local/bin/ccr")" = "$DATA/app/ccr" ]; then
  rm -f "$HOME/.local/bin/ccr"; echo "removed $HOME/.local/bin/ccr"
fi

# --- shell line (the "# claude-rotator" comment and the line after it)
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] && grep -q '^# claude-rotator$' "$rc" || continue
  awk 'skip { skip=0; next } /^# claude-rotator$/ { skip=1; next } { print }' "$rc" > "$rc.ccr-tmp" && cat "$rc.ccr-tmp" > "$rc" && rm -f "$rc.ccr-tmp"
  echo "removed the claude-rotator line from $rc"
done

# --- status line, only if it is ours; a chained one (install.sh --chain-statusline) gets your old command back
S="$HOME/.claude/settings.json"
if [ -f "$S" ] && [ -n "$NODE" ]; then
  "$NODE" -e '
    const fs=require("fs"),[p,app,prevFile]=process.argv.slice(1);
    let j; try { j=JSON.parse(fs.readFileSync(p,"utf8")); } catch (_) { console.log("note: "+p+" is not valid JSON; status line left as is"); process.exit(0); }
    const cur=j.statusLine && String(j.statusLine.command||"");
    if (!cur || !cur.includes(app+"/statusline")) process.exit(0);
    let prev=""; try { prev=fs.readFileSync(prevFile,"utf8").trim(); } catch (_) {}
    if (cur.includes("statusline-chain.js") && prev) { j.statusLine.command=prev; console.log("restored your previous statusLine in "+p+": "+prev); }
    else { delete j.statusLine; console.log("removed statusLine from "+p); }
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");' "$S" "$DATA/app" "$DATA/statusline.prev"
fi

# --- extra account dirs: ask first
ACC="$HOME/.claude-accounts"
if [ -d "$ACC" ]; then
  echo "$ACC holds the config dirs (and logins) of your extra accounts:"
  ls -1 "$ACC" | sed 's/^/  /'
  ans=""
  printf 'Delete %s too? Their settings and any file-based logins go with them. [y/N] ' "$ACC"
  read -r ans || true
  echo
  if [ "$ans" = y ] || [ "$ans" = Y ] || [ "$ans" = yes ]; then rm -rf "$ACC"; echo "removed $ACC"
  else echo "kept $ACC"; fi
fi

# --- data dir
if [ -d "$DATA" ]; then rm -rf "$DATA"; echo "removed $DATA"; fi
echo "claude-rotator uninstalled."
