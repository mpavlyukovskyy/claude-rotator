# claude-rotator shell setup (sourced from ~/.zshrc / ~/.bashrc by one line that install.sh adds).
# Never prepends to PATH, so it cannot hide /usr/bin/cc or anything else.
_CCR_DATA="${CLAUDE_USAGE_DATA:-$HOME/.local/share/claude-usage}"
[ -f "$_CCR_DATA/shell.conf" ] && . "$_CCR_DATA/shell.conf"

# ccr lives in ~/.local/bin. Append that dir only when it is missing (Claude Code's installer usually adds it).
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$PATH:$HOME/.local/bin";; esac

# Put the terminal title back to the working directory once claude exits (ccr sets it to the account).
_ccr_untitle() { [ -t 1 ] && printf '\033]0;%s\007' "${PWD##*/}"; return 0; }
ccr() { command ccr "$@"; local rc=$?; _ccr_untitle; return $rc; }

# Opt-in (install.sh --alias-cc): `cc` runs ccr in interactive shells. A shell function is not seen by
# make, node-gyp or pip, so builds still find the C compiler.
if [ "${CCR_ALIAS_CC:-0}" = 1 ]; then cc() { ccr "$@"; }; fi

# Opt-in (install.sh --titles): plain `claude` also names its window after the account it runs on.
if [ "${CCR_CLAUDE_TITLES:-0}" = 1 ]; then
  claude() {
    local lbl rc
    lbl=$(node "$_CCR_DATA/app/ccr-helper.js" label 2>/dev/null)
    if [ -t 1 ] && [ -n "$lbl" ]; then
      printf '\033]0;Claude · %s · %s\007' "$lbl" "${PWD##*/}"
      [ -n "${TMUX:-}" ] && printf '\033k%s\033\\' "$lbl"
    fi
    command claude "$@"; rc=$?; _ccr_untitle; return $rc
  }
fi
