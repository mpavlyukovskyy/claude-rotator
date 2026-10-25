#!/usr/bin/env bash
# Installs or updates claude-rotator for the current user.
#   ./install.sh [--no-service] [--with-gateway] [--alias-cc|--no-alias-cc] [--titles|--no-titles]
#                [--chain-statusline]
# Re-run it to upgrade: it refreshes every installed file (the gateway too, once installed) and restarts
# the services. Your accounts.json, logins and gateway key are kept.
# What it does:
#   - copies app/ to $CLAUDE_USAGE_DATA (default ~/.local/share/claude-usage)
#   - writes accounts.json from accounts.example.json if there is none (never overwrites)
#   - adds the status line to ~/.claude/settings.json if no status line is set (or updates its own);
#     --chain-statusline runs an existing status line and ours together
#   - prepares a config dir for every non-default account
#   - links `ccr` into ~/.local/bin and adds one line to ~/.zshrc and ~/.bashrc
#   - runs the poller + dashboard as a launchd agent (macOS) or systemd --user service (Linux)
#   - with --with-gateway: also the gateway on 127.0.0.1 and its watchdog
# Env: CLAUDE_USAGE_DATA, CLAUDE_USAGE_NODE, CLAUDE_USAGE_LABEL (launchd label, default local.claude-usage),
#      CLAUDE_USAGE_UNIT_SUFFIX (appended to systemd unit names), CLAUDE_USAGE_PORT (dashboard port, written
#      to accounts.json; default 7788), CLAUDE_USAGE_GATEWAY_PORT (default 7799),
#      CLAUDE_USAGE_SYSTEMD_LINK=1 (Linux: register units with `systemctl --user link`, for a HOME the manager does not read).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
NO_SERVICE=0; WITH_GATEWAY=0; ALIAS_CC=""; TITLES=""; CHAIN_SL=0
for a in "$@"; do
  case "$a" in
    --no-service) NO_SERVICE=1;;
    --with-gateway) WITH_GATEWAY=1;;
    --alias-cc) ALIAS_CC=1;;
    --no-alias-cc) ALIAS_CC=0;;
    --titles) TITLES=1;;
    --no-titles) TITLES=0;;
    --chain-statusline) CHAIN_SL=1;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown option: $a (see --help)" >&2; exit 1;;
  esac
done

DATA="${CLAUDE_USAGE_DATA:-$HOME/.local/share/claude-usage}"
CFG="$DATA/accounts.json"
LABEL="${CLAUDE_USAGE_LABEL:-local.claude-usage}"
SUFFIX="${CLAUDE_USAGE_UNIT_SUFFIX:-}"
OS="$(uname)"

# --- 1. requirements --------------------------------------------------------
NODE="${CLAUDE_USAGE_NODE:-$(command -v node || true)}"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found. Install Node 18 or later (https://nodejs.org) and re-run." >&2; exit 1; }
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || { echo "node $("$NODE" -v) is too old; Node 18 or later is needed." >&2; exit 1; }
CLAUDE_FOUND="$(type -P claude || true)"
[ -n "$CLAUDE_FOUND" ] || { echo "the claude CLI is not on PATH. Install Claude Code first: https://code.claude.com/docs/en/setup" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }
# Both JSON files must parse before anything is written. Claude Code itself accepts only plain JSON here.
for f in "$HOME/.claude/settings.json" "$CFG"; do
  [ -f "$f" ] || continue
  if ! err=$("$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>&1); then
    echo "$f is not valid JSON (comments and trailing commas are not allowed):" >&2
    printf '%s\n' "$err" | grep -m1 -i 'SyntaxError' >&2 || true
    echo "Fix it and re-run. Nothing was installed or changed." >&2; exit 1
  fi
done
# Once installed, the gateway stays installed: an upgrade without --with-gateway still refreshes it.
[ -f "$DATA/app/gateway.js" ] && WITH_GATEWAY=1

# --- 2. app files ------------------------------------------------------------
mkdir -p "$DATA/app/public" "$DATA/state/live" "$DATA/secrets"
chmod 700 "$DATA/secrets"
# Setup token: the dashboard puts it only into pages loaded from 127.0.0.1, and its setup routes refuse
# any change that does not send it back. Kept across upgrades.
UI_TOKEN="$DATA/secrets/ui-token"
if ! grep -q '^[0-9a-f]\{64\}$' "$UI_TOKEN" 2>/dev/null; then
  ( umask 077; "$NODE" -p 'require("crypto").randomBytes(32).toString("hex")' > "$UI_TOKEN" )
  echo "setup token -> $UI_TOKEN (new, mode 0600)"
fi
chmod 600 "$UI_TOKEN"
cp "$SRC"/app/lib.js "$SRC"/app/server.js "$SRC"/app/statusline.js "$SRC"/app/statusline-chain.js "$SRC"/app/poll-once.js \
   "$SRC"/app/setup-dirs.js "$SRC"/app/ccr-helper.js "$SRC"/app/accuracy-check.js "$SRC"/app/ccr "$SRC"/app/shell.sh \
   "$SRC"/app/node-run "$SRC"/app/providers.js "$SRC"/app/mcp.js "$DATA/app/"
cp "$SRC/app/public/index.html" "$DATA/app/public/"
[ "$WITH_GATEWAY" = 1 ] && cp "$SRC"/app/gateway.js "$SRC"/app/watchdog.js "$DATA/app/"
chmod +x "$DATA/app/ccr" "$DATA/app/node-run"
# Services and the status line start node through this launcher, which finds node at run time, so a
# Node upgrade or an nvm switch does not break them.
RUN="$DATA/app/node-run"
echo "app -> $DATA/app"

# --- 3. accounts.json ----------------------------------------------------------
if [ ! -f "$CFG" ]; then
  "$NODE" -e '
    const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    j.port=Number(process.argv[3])||7788; fs.writeFileSync(process.argv[2], JSON.stringify(j,null,2)+"\n");' \
    "$SRC/accounts.example.json" "$CFG" "${CLAUDE_USAGE_PORT:-7788}"
  echo "config -> $CFG (new)"
else
  if [ -n "${CLAUDE_USAGE_PORT:-}" ]; then
    "$NODE" -e '
      const fs=require("fs"),p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); const n=Number(process.argv[2]);
      if (n && j.port!==n) { j.port=n; fs.writeFileSync(p+".tmp", JSON.stringify(j,null,2)+"\n"); fs.renameSync(p+".tmp", p); console.log("config port -> "+n); }' \
      "$CFG" "$CLAUDE_USAGE_PORT"
  fi
  echo "config -> $CFG (kept)"
fi
export CLAUDE_USAGE_DATA="$DATA" CLAUDE_USAGE_CONFIG="$CFG"
# Account dirs left in ~/.claude-accounts (an uninstall keeps them) go back into accounts.json, at the end.
"$NODE" "$DATA/app/ccr-helper.js" reregister "$HOME/.claude-accounts"
PORT_CFG=$("$NODE" "$DATA/app/ccr-helper.js" port)

# --- 4. status line (settings.json is shared by symlink, so this covers every account) ---------
mkdir -p "$HOME/.claude"
[ -f "$HOME/.claude/settings.json" ] || echo '{}' > "$HOME/.claude/settings.json"
# Ours = any command naming $DATA/app/statusline*.js (an older install pinned a node path; that gets updated).
# Someone else's = left alone and reported loudly, unless --chain-statusline asks to run both.
"$NODE" -e '
const fs=require("fs"),[p,run,app,data,chain]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(p,"utf8"));
const q=JSON.stringify, plain=q(run)+" "+q(app+"/statusline.js"), chained=q(run)+" "+q(app+"/statusline-chain.js");
const cur=j.statusLine&&j.statusLine.command?String(j.statusLine.command):"";
const save=()=>fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
const mine=cur.includes(app+"/statusline");
if(!cur){ j.statusLine={type:"command",command:plain,padding:0}; save(); console.log("statusLine installed"); }
else if(mine){ const want=cur.includes("statusline-chain.js")?chained:plain;
  if(cur!==want){ j.statusLine.command=want; save(); console.log("statusLine updated"); } else console.log("statusLine already installed"); }
else if(chain==="1"){ fs.writeFileSync(data+"/statusline.prev",cur+"\n"); j.statusLine.command=chained; save();
  console.log("statusLine chained: your old one ("+cur+") runs first, then ours. uninstall.sh restores it."); }
else { console.error("\n*** WARNING: statusLine NOT installed. "+p+" already runs:\n      "+cur+
  "\n    Without ours, numbers from open sessions are not recorded and the dashboard relies on polling only."+
  "\n    To run both, re-run install.sh with --chain-statusline (README: \"Status line\").\n"); }
' "$HOME/.claude/settings.json" "$RUN" "$DATA/app" "$DATA" "$CHAIN_SL"

# --- 5. per-account config dirs ---------------------------------------------------
"$NODE" "$DATA/app/setup-dirs.js"

# --- 6. ccr on PATH + shell line ----------------------------------------------------
mkdir -p "$HOME/.local/bin"
if [ -e "$HOME/.local/bin/ccr" ] && [ ! -L "$HOME/.local/bin/ccr" ]; then
  echo "WARNING: $HOME/.local/bin/ccr exists and is not a symlink; left it alone. ccr is at $DATA/app/ccr" >&2
else
  ln -sfn "$DATA/app/ccr" "$HOME/.local/bin/ccr"
fi
CONF="$DATA/shell.conf"
OLD_ALIAS=0; OLD_TITLES=0
[ -f "$CONF" ] && { OLD_ALIAS=$(sed -n 's/^CCR_ALIAS_CC=//p' "$CONF"); OLD_TITLES=$(sed -n 's/^CCR_CLAUDE_TITLES=//p' "$CONF"); }
printf 'CCR_ALIAS_CC=%s\nCCR_CLAUDE_TITLES=%s\n' "${ALIAS_CC:-${OLD_ALIAS:-0}}" "${TITLES:-${OLD_TITLES:-0}}" > "$CONF"
case "$DATA" in "$HOME"/*) DATA_RC="\$HOME/${DATA#"$HOME"/}";; *) DATA_RC="$DATA";; esac
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  grep -q '# claude-rotator' "$rc" 2>/dev/null && continue
  printf '\n# claude-rotator\n[ -f "%s/app/shell.sh" ] && . "%s/app/shell.sh"\n' "$DATA_RC" "$DATA_RC" >> "$rc"
done
echo "ccr -> $HOME/.local/bin/ccr (open a new shell, or: . $DATA/app/shell.sh)"

# --- 7/8. services ----------------------------------------------------------------
# PATH for the services. No version-pinned node dir (nvm, fnm): node-run finds node at run time and adds
# its dir, which also covers a claude that npm installed next to it.
case "$(dirname "$NODE")" in */.nvm/*|*/fnm/*|*/.fnm/*) NODE_DIR="";; *) NODE_DIR="$(dirname "$NODE"):";; esac
case "$(dirname "$CLAUDE_FOUND")" in */.nvm/*|*/fnm/*|*/.fnm/*) CLAUDE_DIR="";; *) CLAUDE_DIR="$(dirname "$CLAUDE_FOUND"):";; esac
SVC_PATH="${CLAUDE_DIR}${NODE_DIR}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Optional settings and test hooks, passed through to the services only when set.
PASS_VARS="CLAUDE_BIN CLAUDE_USAGE_NODE CLAUDE_USAGE_NO_KEYCHAIN CLAUDE_USAGE_API_BASE CLAUDE_USAGE_REFRESH_MODEL ALERT_WEBHOOK WATCHDOG_DEEP"

if [ "$WITH_GATEWAY" = 1 ]; then
  GENV="$DATA/secrets/gateway.env"
  if ! grep -q '^CLAUDE_USAGE_GATEWAY_KEY=.\{32,\}' "$GENV" 2>/dev/null; then
    ( umask 077
      KEY=$("$NODE" -p 'require("crypto").randomBytes(32).toString("hex")')
      { echo "# claude-rotator gateway config, read by gateway.js and watchdog.js"
        echo "CLAUDE_USAGE_GATEWAY_KEY=$KEY"
        echo "CLAUDE_USAGE_GATEWAY_PORT=${CLAUDE_USAGE_GATEWAY_PORT:-7799}"
        echo "CLAUDE_USAGE_GATEWAY_HOST=127.0.0.1"
        echo "# ALERT_WEBHOOK=https://hooks.slack.com/services/..."; } > "$GENV" )
    echo "gateway key -> $GENV (new, mode 0600)"
  fi
  chmod 600 "$GENV"
  GW_PORT=$(sed -n 's/^CLAUDE_USAGE_GATEWAY_PORT=//p' "$GENV"); GW_PORT="${GW_PORT:-7799}"
fi

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
plist_env() {
  printf '<key>HOME</key><string>%s</string><key>USER</key><string>%s</string><key>PATH</key><string>%s</string>' "$(xml "$HOME")" "$(xml "$USER")" "$(xml "$SVC_PATH")"
  printf '<key>CLAUDE_USAGE_DATA</key><string>%s</string>' "$(xml "$DATA")"
  for v in $PASS_VARS; do [ -n "${!v:-}" ] && printf '<key>%s</key><string>%s</string>' "$v" "$(xml "${!v}")"; done
  return 0
}
write_plist() { # label script keepalive(1|0) interval-seconds
  local p="$HOME/Library/LaunchAgents/$1.plist" run
  if [ "$3" = 1 ]; then run='<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>'
  else run="<key>RunAtLoad</key><true/><key>StartInterval</key><integer>$4</integer>"; fi
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$p" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>$(xml "$RUN")</string><string>$(xml "$DATA/app/$2")</string></array>
  <key>EnvironmentVariables</key><dict>$(plist_env)</dict>
  $run
  <key>StandardOutPath</key><string>$(xml "$DATA/state/${2%.js}.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$DATA/state/${2%.js}.err.log")</string>
</dict></plist>
PL
  echo "$p"
}
# bootout returns before the job is gone; an immediate bootstrap then fails with "5: Input/output error"
# and leaves the job down. Retry until it takes.
boot() { launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl bootstrap "gui/$(id -u)" "$2" 2>/dev/null && return 0; sleep 1; done
  echo "FAILED to load launchd job $1" >&2; return 1; }

unit_env() {
  printf 'Environment="HOME=%s" "USER=%s" "PATH=%s" "CLAUDE_USAGE_DATA=%s"' "$HOME" "$USER" "$SVC_PATH" "$DATA"
  for v in $PASS_VARS; do [ -n "${!v:-}" ] && printf ' "%s=%s"' "$v" "${!v}"; done
  echo
}
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Logs go to the same files as on macOS: $DATA/state/<script>.log and .err.log.
unit_logs() { printf 'StandardOutput=append:%s\nStandardError=append:%s\n' "$DATA/state/${1%.js}.log" "$DATA/state/${1%.js}.err.log"; }
write_unit() { # name description script
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$1.service" <<S
[Unit]
Description=$2
After=network-online.target
[Service]
ExecStart="$RUN" "$DATA/app/$3"
Restart=always
RestartSec=15
# 78 = refused to start on a config error (no gateway key, unsupported claude): retrying cannot fix it.
RestartPreventExitStatus=78
$(unit_env)
$(unit_logs "$3")
[Install]
WantedBy=default.target
S
}
# systemctl failures are reported, never swallowed by set -e.
sysd() { local out; if ! out=$(systemctl --user "$@" 2>&1); then
  echo "FAILED: systemctl --user $* : $out" >&2
  echo "The units are in $UNIT_DIR. If your systemd --user manager does not read that dir (HOME or XDG_CONFIG_HOME differs from the manager's, as in an isolated test HOME), re-run with CLAUDE_USAGE_SYSTEMD_LINK=1 so install.sh registers them with 'systemctl --user link'." >&2
  exit 1; fi; }

if [ "$NO_SERVICE" = 1 ]; then
  echo "services: skipped (--no-service). Start the dashboard by hand with: $RUN $DATA/app/server.js"
elif [ "$OS" = Darwin ]; then
  boot "$LABEL" "$(write_plist "$LABEL" server.js 1)"
  echo "service: launchd $LABEL"
  if [ "$WITH_GATEWAY" = 1 ]; then
    boot "$LABEL.gateway" "$(write_plist "$LABEL.gateway" gateway.js 1)"
    boot "$LABEL.gateway-watchdog" "$(write_plist "$LABEL.gateway-watchdog" watchdog.js 0 1800)"
    echo "service: launchd $LABEL.gateway + $LABEL.gateway-watchdog (every 30 min)"
  fi
elif [ "$OS" = Linux ]; then
  command -v systemctl >/dev/null || { echo "systemctl not found; re-run with --no-service and start $RUN $DATA/app/server.js yourself" >&2; exit 1; }
  write_unit "claude-usage$SUFFIX" "claude-rotator poller + dashboard (127.0.0.1:$PORT_CFG)" server.js
  UNITS="claude-usage$SUFFIX.service"
  if [ "$WITH_GATEWAY" = 1 ]; then
    write_unit "claude-gateway$SUFFIX" "claude-rotator gateway (127.0.0.1:$GW_PORT)" gateway.js
    cat > "$UNIT_DIR/claude-gateway-watchdog$SUFFIX.service" <<S
[Unit]
Description=claude-rotator gateway watchdog
[Service]
Type=oneshot
ExecStart="$RUN" "$DATA/app/watchdog.js"
$(unit_env)
$(unit_logs watchdog.js)
S
    cat > "$UNIT_DIR/claude-gateway-watchdog$SUFFIX.timer" <<S
[Unit]
Description=claude-rotator gateway watchdog every 30 min
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
[Install]
WantedBy=timers.target
S
    UNITS="$UNITS claude-gateway$SUFFIX.service claude-gateway-watchdog$SUFFIX.timer"
  fi
  if [ "${CLAUDE_USAGE_SYSTEMD_LINK:-0}" = 1 ]; then
    for u in $UNITS; do sysd link "$UNIT_DIR/$u"; done
    [ "$WITH_GATEWAY" = 1 ] && sysd link "$UNIT_DIR/claude-gateway-watchdog$SUFFIX.service"
  fi
  sysd daemon-reload
  for u in $UNITS; do sysd enable "$u"; systemctl --user reset-failed "$u" 2>/dev/null || true; sysd restart "$u"; done
  loginctl enable-linger "$USER" 2>/dev/null || echo "note: could not enable linger; services stop when you log out" >&2
  echo "service: systemd --user $UNITS"
else
  echo "unsupported OS $OS: re-run with --no-service" >&2; exit 1
fi

# --- 9. health ------------------------------------------------------------------------
if [ "$NO_SERVICE" != 1 ]; then
  code=000
  for _ in $(seq 1 20); do code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_CFG/healthz" || true); [ "$code" = 200 ] && break; sleep 1; done
  echo "dashboard: http://127.0.0.1:$PORT_CFG/   health: $code"
  if [ "$WITH_GATEWAY" = 1 ]; then
    gcode=000
    for _ in $(seq 1 10); do gcode=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GW_PORT/healthz" || true); [ "$gcode" = 200 ] && break; sleep 1; done
    echo "gateway:   http://127.0.0.1:$GW_PORT/   health: $gcode   (key in $DATA/secrets/gateway.env)"
  fi
fi
echo
echo "Next: ccr ui          (setup page: logins, fallback keys, gateway, MCP)"
echo "      ccr ls          (accounts and headroom)"
echo "      ccr add <name>  (add a second subscription, then log in to it)"
