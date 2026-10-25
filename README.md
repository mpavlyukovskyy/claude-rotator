# claude-rotator

Use several Claude subscriptions from one machine with Claude Code. `ccr` starts `claude` on the account with the most usage left, and a local dashboard shows each account's 5-hour and 7-day usage, when it resets, and which account to use next.

It runs on macOS and Linux, needs no npm packages, and stores everything on your machine.

Read [Risks and terms](#risks-and-terms) before you rely on it.

## Requirements

- macOS or Linux
- Node 18 or later (`node -v`)
- Claude Code, with `claude` on your PATH ([install guide](https://code.claude.com/docs/en/setup))
- `curl`
- Optional: Xcode Command Line Tools, only for the desktop window in `contrib/desktop`

## Quickstart

```bash
git clone https://github.com/mpavlyukovskyy/claude-rotator && cd claude-rotator
./install.sh          # dashboard service, ccr, status line
exec "$SHELL" -l      # or open a new terminal
ccr ls                # your current login shows up as "main"
ccr add two           # makes ~/.claude-accounts/two and opens the login for it
ccr add three
ccr ls                # every account, its headroom, and "<- use next"
ccr                   # interactive session on the best account
ccr run -p "summarize README.md"   # headless, on the best account
```

The dashboard is at http://127.0.0.1:7788/ (`ccr web` opens it).

Your existing `~/.claude` login is the `main` account. `ccr add <name>` creates a new slot; log in to it with a different subscription. If the login window does not open, run `ccr <name>` and type `/login`.

On macOS, Claude Code keeps each login in the Keychain. The dashboard reads it with the `security` tool. The first read of each account may show a Keychain prompt; choose "Always Allow" so the background poller can read it without asking again.

## Commands

| Command | What it does |
|---|---|
| `ccr` | Start `claude` on the account to use next |
| `ccr --resume`, `ccr -c`, ... | Same, and pass the flags to `claude`. A first argument starting with `-` never names an account |
| `ccr <name>` or `ccr <N>` | Start `claude` on that account (by id, or by position in `accounts.json`) |
| `ccr ls` | Table of accounts: 5-hour and 7-day headroom, per-model caps, notes |
| `ccr web` | Open the dashboard |
| `ccr add <name>` | Add an account slot and log in to it (`--no-login` to skip the login) |
| `ccr pick [--not a,b] [--env]` | Print the best account. `--env` prints `export` lines for `eval` |
| `ccr run <claude args>` | Run `claude` headless on the best account. On a usage-limit error it retries once on the next account |

Extra arguments go to `claude`, so `ccr two --resume` works too. Account names must start with a letter and cannot be a `ccr` command (`ls`, `run`, `web`, `add`, `pick`, `help`).

## How it works

**Accounts are config dirs.** Claude Code keeps one login per config directory (`CLAUDE_CONFIG_DIR`, see the [authentication docs](https://code.claude.com/docs/en/authentication)). `main` is `~/.claude`. Each added account is `~/.claude-accounts/<name>`. `install.sh` and `ccr add` symlink these entries from `~/.claude` into every account dir: `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `hooks`, `plugins`, `projects`, `keybindings.json`, `rules`. Your settings, skills and session history therefore follow you across accounts, and `ccr --resume` finds a session started on any account.

**The poller** runs every 5 minutes as a launchd agent (macOS) or a systemd user service (Linux). For each account it reads the login (Keychain first, then `<dir>/.credentials.json`), asks Anthropic for that login's usage, and asks which email the token belongs to, so a card never shows one login's numbers under another login's name. It never writes credentials. If a login's access token is expired or close to it, the poller runs a 1-token `claude -p` with Haiku in that account's dir, so Claude Code refreshes the login itself.

**The status line** shows the current session's account and usage. Claude Code passes the status line live `rate_limits` numbers, and the status line forwards them to the dashboard. The dashboard accepts a live record for an account only when its reset times match that account's own poll.

If `~/.claude/settings.json` already has a status line, `install.sh` leaves it alone and prints a warning. Without ours the dashboard still works, from polling alone. To keep yours and add ours, run `./install.sh --chain-statusline`: it saves your command to `~/.local/share/claude-usage/statusline.prev` and points `statusLine` at `app/statusline-chain.js`, which feeds the same input to both and prints your line, then ours. If your command takes more than 5 seconds, the line shows `[prev statusline timed out]` in its place. `uninstall.sh` puts your command back.

**node-run.** The services and the status line start node through `app/node-run`, which looks for node each time it runs (`CLAUDE_USAGE_NODE`, then `PATH`, then Homebrew, Volta, asdf, fnm and nvm, newest first) and skips any node older than 18. A Node upgrade or an nvm switch does not break them.

**Which account is next.** Usage left in a window is lost when the window resets, so the order spends the account whose budget is about to reset first. Accounts that still have headroom on a per-model weekly cap (Fable) come before accounts that do not. Maxed-out accounts and broken logins go last. Accounts flagged `"lastResort": true` come after every other usable account.

**Copied logins.** Refresh tokens rotate: each refresh revokes the previous token. If the same login sits on two machines, the first one to refresh logs the other out. If you list another machine's dashboard under `remotes`, the dashboard compares token fingerprints (a one-way hash) and flags a login held on both.

## Configuration

The app, config, state and secrets live in `~/.local/share/claude-usage` (set `CLAUDE_USAGE_DATA` to move them). The config is `accounts.json` there:

```json
{
  "port": 7788,
  "pollMinutes": 5,
  "accounts": [
    { "id": "main", "label": "Main", "configDir": "~/.claude", "default": true },
    { "id": "two", "label": "two", "configDir": "~/.claude-accounts/two" },
    { "id": "spare", "label": "spare", "configDir": "~/.claude-accounts/spare", "lastResort": true }
  ],
  "nicknames": { "you@example.invalid": "personal" },
  "remotes": [ { "label": "other-machine", "url": "http://other-machine:7788" } ]
}
```

- `nicknames` maps a login email to the name shown on its card. Without one, a card is named `local@domain`.
- `remotes` adds another machine's dashboard to this one, read-only.
- `port` sets the dashboard port for every part of the app. `install.sh` writes it from `CLAUDE_USAGE_PORT`; nothing reads a plain `PORT` variable.
- The dashboard has no auth and binds 127.0.0.1. `"host"` changes the bind address. It answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]` on its own port, so a web page cannot reach it through DNS rebinding, and it refuses a POST started by any other origin. A dashboard that another machine reads as a remote must list the name that machine uses in `"allowedHosts": ["my-mac.local"]`.

**Headless tokens (optional).** `claude setup-token` prints a one-year token that only makes model requests ([docs](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)). It does not rotate, so using it never logs out a login held elsewhere. Put one per account in `~/.local/share/claude-usage/secrets/inference-tokens.json`, mode 0600:

```json
{ "main": "sk-ant-oat01-...", "two": "sk-ant-oat01-..." }
```

`ccr run` and `ccr pick --env` then hand that account's token to `claude` as `CLAUDE_CODE_OAUTH_TOKEN`. When an account's login is missing or broken, the poller uses the token to read usage from response headers instead (see the risk notes).

**Install options.**

| Option | Effect |
|---|---|
| `--no-service` | Install files only; start `~/.local/share/claude-usage/app/node-run ~/.local/share/claude-usage/app/server.js` yourself |
| `--with-gateway` | Also install the gateway and its watchdog (below). Once installed, it stays installed across upgrades |
| `--alias-cc` / `--no-alias-cc` | Turn on or off a `cc` shell function that runs `ccr`. Off by default because `cc` is the C compiler |
| `--titles` / `--no-titles` | Turn on or off the terminal title that plain `claude` sets to its account |
| `--chain-statusline` | Run your existing status line and ours together (see "The status line" above) |

`install.sh` stops before writing anything if `~/.claude/settings.json` or `accounts.json` is not plain JSON (Claude Code does not accept comments there either).

Environment for `install.sh`: `CLAUDE_USAGE_PORT` (dashboard port, written to `accounts.json`, default 7788), `CLAUDE_USAGE_LABEL` (launchd label, default `local.claude-usage`), `CLAUDE_USAGE_UNIT_SUFFIX` (appended to systemd unit names), `CLAUDE_USAGE_GATEWAY_PORT` (default 7799), `CLAUDE_USAGE_NODE`, `CLAUDE_USAGE_SYSTEMD_LINK=1` (below).

On Linux the units go in `${XDG_CONFIG_HOME:-~/.config}/systemd/user`, and every service logs to `~/.local/share/claude-usage/state/<name>.log` and `<name>.err.log`, the same files as on macOS. If `systemctl --user` fails, `install.sh` prints its error and stops. A gateway that exits with status 78 (no key, or a `claude` without `--strict-mcp-config`) is not restarted. When your systemd user manager does not read that unit dir (a `HOME` or `XDG_CONFIG_HOME` different from the manager's), set `CLAUDE_USAGE_SYSTEMD_LINK=1` and `install.sh` registers the units with `systemctl --user link`. `uninstall.sh` removes those links.

## Gateway (optional)

`./install.sh --with-gateway` adds a small HTTP service on 127.0.0.1:7799 for callers that cannot run `ccr`, such as a container or a script that speaks the Messages API. On the same machine, `ccr run` does the same job without it.

- `GET /v1/lease?caller=<name>` returns the account the picker would use now and that account's token. `contrib/claude-pooled` is a client: it leases a token and runs `claude` with it.
- `POST /v1/messages` takes a non-streaming Messages request and serves it with `claude -p` on the best account. Text only: requests with tools get a 422.
- Every route except `/healthz` needs the `x-gateway-key` header. `install.sh` generates a 32-byte key into `~/.local/share/claude-usage/secrets/gateway.env` (mode 0600). The gateway refuses to start without a key of at least 32 bytes.
- Like the dashboard, it answers only requests addressed to a loopback name on its own port, and refuses browser requests from other origins. If you bind it elsewhere, list the names callers use in `CLAUDE_USAGE_GATEWAY_ALLOWED_HOSTS` (comma-separated) in `gateway.env`.
- Every `claude -p` it runs gets `--tools ""` (no tools), `--no-session-persistence`, `--strict-mcp-config` (no MCP servers), `--restricted` (your user, project and local settings files are not read, so their `permissions.allow` rules and hooks do not apply) and `--safe-mode` (no CLAUDE.md, skills, plugins or hooks). The gateway refuses to start if your `claude` does not support `--strict-mcp-config`. A caller can enable `WebSearch` and `WebFetch` for one request with the header `x-gateway-tools: WebSearch,WebFetch`; no other tool can be named.
- The watchdog runs every 30 minutes. By default it makes no model call: it checks `/healthz` and sends the key with a malformed request, expecting the gateway's own 400. A run where no account has a login or a setup-token also counts as a failure. With `WATCHDOG_DEEP=1` in `gateway.env` it makes one real call through the gateway instead. It logs a failure after two misses in a row. Set `ALERT_WEBHOOK` in `gateway.env` to also POST `{"text": "..."}` to a Slack or Discord webhook.
- Off by default: `CLAUDE_USAGE_DIRECT_HAIKU=1` forwards Haiku requests straight to the Messages API with the account's OAuth token, and `CLAUDE_USAGE_UPGRADE_SONNET_TO_OPUS=1` serves Sonnet requests as Opus (`claude-opus-5-5`). Read the risk notes before turning either on.

## Risks and terms

The terms quoted below are current as of 25 October 2026. Read the current terms yourself.

**What Anthropic's terms say.**

- The Claude Code docs, under [Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), say: "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." The same section says Anthropic does not permit third-party developers "to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- The same section says: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". This tool does that in two places: `inference-tokens.json` stores subscription tokens, and the optional gateway intermediates them (`/v1/lease` hands them to other processes, `POST /v1/messages` serves requests on them).
- It ends: "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- The same page says: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Free, Pro and Max) say: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else" and "You also may not make your Account available to anyone else." Add only logins for subscriptions you own.
- The Consumer Terms (effective 8 October 2025) list as prohibited: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." The Claude Code docs separately document `claude -p` and `claude setup-token` for scripts and CI.
- No term quoted here bars owning several subscriptions. [TechCrunch reported](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/) that Anthropic tied the weekly limits it added in July 2025 to subscribers running Claude Code continuously in the background, and to account sharing and reselling. Anthropic could read rotating accounts to get past per-account limits the same way.
- Running every subscription from one machine ties them together: Anthropic can see the same device and network behind all of them. If it acts against one, expect the others to be in view too.

**What this tool does with your tokens.**

- In the default install, every model request goes through the unmodified `claude` binary. The poller also uses each login's token to call two endpoints, `/api/oauth/usage` and `/api/oauth/profile`. They are undocumented and can change or disappear without notice. If they break, the status line still feeds live numbers for any account with a session open.
- Model calls this tool makes on its own, in the background:
  - Login refresh: one 1-token `claude -p` with Haiku, only when an idle login is within 15 minutes of expiry.
  - Header fallback: one raw 1-token Haiku Messages call per poll for each account that has a setup-token in `inference-tokens.json` and no working login. That is 288 calls a day per such account at the 5-minute interval, sent with subscription credentials outside the `claude` binary.
  - Gateway watchdog: none by default. With `WATCHDOG_DEEP=1`, one ~10-token call every 30 minutes (48 a day), plus login refreshes.
  - The usage and profile reads above are not model calls.
- `POST /v1/messages` serves anyone who holds the gateway key from your subscriptions, on every model, through `claude -p`. That is not limited to the direct Haiku route.
- The gateway's direct Haiku route (off by default) forwards raw Messages calls with a subscription OAuth token. This is the use that conflicts most clearly with the terms above. In testing, Anthropic answered requests for every non-Haiku model on this route with a bare 429.

**Leased tokens.**

- `/v1/lease` returns a token that does not rotate and is valid for a year (a setup-token), or a live login token.
- Anyone who can reach the gateway port and has the key gets that token. The gateway binds 127.0.0.1 by default; if you bind it to another address, anything on that network that has the key can lease.
- A leased token cannot be pulled back. Ending it means revoking that account's tokens.
- The token sits in the leasing process's environment. A prompt-injected agent with a shell can read it with `env`. Lease only to processes you trust. The gateway log names the caller and the account, never the token.

**Logins and machines.**

- Never copy `.credentials.json` to a second machine. Each machine's refresh logs the other out (`invalid_grant`). Give each machine its own `/login`, or use a setup-token there.
- On macOS, finding each account's Keychain item relies on Claude Code's internal naming (`Claude Code-credentials-<hash of the dir>`). If Claude Code changes it, the poller stops seeing that login, though the status line keeps working.

## Upgrade

```bash
git pull && ./install.sh [the same flags as before]
```

`install.sh` copies every installed file again (the gateway too, if it is installed), updates its own status line, and restarts the services. It keeps `accounts.json`, your logins and the gateway key.

## Uninstall

```bash
./uninstall.sh
```

Run it with the same `CLAUDE_USAGE_LABEL`, `CLAUDE_USAGE_UNIT_SUFFIX` and `CLAUDE_USAGE_DATA` you installed with; otherwise it looks for the default names and leaves your services running.

It stops and removes the services, the `ccr` link, the shell line, the status line (only if it still points at this app; a chained one gets your old command back) and `~/.local/share/claude-usage`, including `accounts.json` and any tokens in `secrets/`. It asks before deleting `~/.claude-accounts`. It never touches `~/.claude` or your main login. If you keep `~/.claude-accounts`, a later `./install.sh` adds those accounts back: every run appends any dir there that `accounts.json` lacks, keeps the existing entries and their order, and prints each dir it skips with the reason.

To also remove the extra logins, first run `ccr <name>` and type `/logout` in each extra account. Deleting a directory alone leaves that account's macOS Keychain item behind.

## Tests

```bash
node test/live-identity.test.js
bash test/statusline.test.sh
bash test/shared-chain.test.sh
bash test/gateway-bench.test.sh
bash test/host-guard.test.sh
bash test/ccr.test.sh
bash test/node-run.test.sh
bash test/watchdog.test.sh
bash test/install.test.sh     # full install, add, status line, gateway, upgrade and uninstall in a temp HOME
```

The regression tests use fake servers (and a fake `claude` where one is needed) on ports 17900 to 17940 and never call Anthropic. `install.test.sh` installs into a temporary HOME with launchd label `test.rotator` (systemd suffix `-test`), dashboard port 17788 and gateway port 17799. It skips the Keychain and points the poller at a dead local port, so it never reads your real logins. On Linux your systemd user manager does not read units from the temporary HOME, so the test detects that, installs with `CLAUDE_USAGE_SYSTEMD_LINK=1` (`systemctl --user link`), and removes the links when it finishes.

## Layout

```
install.sh  uninstall.sh  accounts.example.json
app/        lib.js server.js statusline.js statusline-chain.js poll-once.js setup-dirs.js ccr ccr-helper.js
            shell.sh node-run accuracy-check.js gateway.js watchdog.js public/index.html
contrib/    claude-pooled (gateway lease client), desktop/ (native macOS window: ./build.sh)
test/       regression and install tests
```

`app/accuracy-check.js` is an optional check that compares what the dashboard shows with the raw polls. Run it by hand or from cron.

## License

MIT. See [LICENSE](LICENSE).
