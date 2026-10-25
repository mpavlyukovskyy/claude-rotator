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
ccr ui                # setup page in your browser: logins, fallback keys, gateway, MCP
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
| `ccr ui` | Open the dashboard's Setup page (see [Setup UI](#setup-ui)) |
| `ccr add <name>` | Add an account slot and log in to it (`--no-login` to skip the login) |
| `ccr login <name>` | Log in to an existing slot: a slot added from the Setup page, or one you logged out of |
| `ccr pick [--not a,b] [--env]` | Print the best account. `--env` prints `export` lines for `eval` |
| `ccr run <claude args>` | Run `claude` headless on the best account. On a usage-limit error it retries once on the next account |
| `ccr mcp` | MCP server on stdio, for Claude Code or another MCP client. See [MCP server](#mcp-server) |

Extra arguments go to `claude`, so `ccr two --resume` works too. Account names must start with a letter and cannot be a `ccr` command (`ls`, `run`, `web`, `add`, `pick`, `help`, `ui`, `login`, `mcp`).

## Setup UI

`ccr ui` opens the dashboard's Setup page. It walks through the whole setup on one page:

- A checklist: whether it finds Claude Code (and which version), whether the dashboard runs, how many subscriptions have a login, the fallback providers, the gateway, and the MCP server.
- **Subscriptions.** Every slot with its login state. "Add account" takes a name (same rules as `ccr add`), creates the slot and shows `ccr login <name>` with a copy button. On macOS, "Open login in Terminal" opens a Terminal window that runs that command. The login itself is Claude Code's own browser sign-in. You never type a password or token into the dashboard.
- **Fallback providers** (optional). For Fireworks, OpenRouter and the Anthropic API: a field to paste a key, Save, Test (one small request), Remove, the last four characters of the saved key, and the model in use. A switch turns the fallback on or off, and arrows set the order. Your subscriptions always come first.
- **Gateway and MCP.** Whether you installed the gateway and whether it answers, its URL, a "Copy gateway key" button, and the `claude mcp add --scope user claude-rotator -- ccr mcp` line to copy.

Every change on the page needs the setup token, a random secret that `install.sh` writes to `~/.local/share/claude-usage/secrets/ui-token` (mode 0600). The dashboard puts it into the page only when you open it as `127.0.0.1`, `localhost` or `[::1]` on its own port, and every route that changes something (adding an account, opening a login, saving, testing or removing a key, the fallback settings) refuses a request without it. Those routes, and the token in the page, also need the connection itself to come from this machine (a loopback address), so a dashboard you bind to another address never hands the token to a client on your network that claims `Host: 127.0.0.1`. The gateway key route needs it too, and the page fetches the key only when you click the button. Other sites can make your browser send requests to the dashboard but cannot read the page, so they never see the token. A page opened through an `allowedHosts` name gets no token and shows the setup read-only. To change the token, delete the file and run `./install.sh` again.

## How it works

**Accounts are config dirs.** Claude Code keeps one login per config directory (`CLAUDE_CONFIG_DIR`, see the [authentication docs](https://code.claude.com/docs/en/authentication)). `main` is `~/.claude`. Each added account is `~/.claude-accounts/<name>`. `install.sh` and `ccr add` symlink these entries from `~/.claude` into every account dir: `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `hooks`, `plugins`, `projects`, `keybindings.json`, `rules`. Your settings, skills and session history therefore follow you across accounts, and `ccr --resume` finds a session started on any account.

**The poller** runs every 5 minutes as a launchd agent (macOS) or a systemd user service (Linux). For each account it reads the login (Keychain first, then `<dir>/.credentials.json`), asks Anthropic for that login's usage, and asks which email the token belongs to, so a card never shows one login's numbers under another login's name. It never writes credentials. If a login's access token has expired or will expire soon, the poller runs a 1-token `claude -p` with Haiku in that account's dir, so Claude Code refreshes the login itself.

**The status line** shows the current session's account and usage. Claude Code passes the status line live `rate_limits` numbers, and the status line forwards them to the dashboard. The dashboard accepts a live record for an account only when its reset times match that account's own poll.

If `~/.claude/settings.json` already has a status line, `install.sh` leaves it alone and prints a warning. Without ours the dashboard still works, from polling alone. To keep yours and add ours, run `./install.sh --chain-statusline`: it saves your command to `~/.local/share/claude-usage/statusline.prev` and points `statusLine` at `app/statusline-chain.js`, which feeds the same input to both and prints your line, then ours. If your command takes more than 5 seconds, the line shows `[prev statusline timed out]` in its place. `uninstall.sh` puts your command back.

**node-run.** The services and the status line start node through `app/node-run`, which looks for node each time it runs (`CLAUDE_USAGE_NODE`, then `PATH`, then Homebrew, Volta, asdf, fnm and nvm, newest first) and skips any node older than 18. A Node upgrade or an nvm switch does not break them.

**Which account is next.** A window's unused usage disappears when the window resets, so the order spends the account whose budget is about to reset first. Accounts that still have headroom on a per-model weekly cap (Fable) come before accounts that do not. Maxed-out accounts and broken logins go last. Accounts with `"lastResort": true` come after every other usable account.

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

- `nicknames` maps a login email to the name its card shows. Without one, a card shows `local@domain`.
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

## Fallback providers (optional)

With the [gateway](#gateway-optional) installed, a request does not have to fail when every subscription account has hit its limit, sits on the bench or has a dead login. The gateway then serves `POST /v1/messages` through API keys you add, in this order:

1. Your subscription accounts, as before.
2. Fireworks, then OpenRouter, both on the latest Kimi (`kimi-k3`) with reasoning turned off. Requests to OpenRouter ask it to skip Moonshot's own hosting.
3. An Anthropic API key, last. It serves the Claude model the request named, or `claude-sonnet-5-5`.

The gateway skips a provider with no key, so nothing changes until you add one, and a provider that cannot take the request (see **Limits**). These failures move on to the next provider: any HTTP status other than 401 and 403 (400, 429 and every 5xx included), a timeout, a network error, a reply that is not JSON or carries an `error`, and an empty reply. A rejected key (401 or 403) stops the chain: the gateway returns a 502 `authentication_error` that names the provider, so a config mistake never bills the next provider. When every provider fails or gets skipped, the gateway returns 503.

**Adding keys.** Use the Setup view in the dashboard. It calls these routes, which need the setup token from `~/.local/share/claude-usage/secrets/ui-token` in the `x-rotator-ui-token` header:

| Route | Does |
|---|---|
| `GET /api/providers` | Lists each provider, whether it has a key, the last four characters of the key, its model, and the fallback settings. No token needed |
| `POST /api/providers/<name>` with `{"apiKey": "..."}` | Saves a key. `<name>` is `fireworks`, `openrouter` or `anthropic` |
| `DELETE /api/providers/<name>` | Removes a key |
| `POST /api/providers/<name>/test` | Makes one call of about 20 tokens and returns `{ok, ms, model}` |
| `POST /api/fallback` with `{enabled?, order?, models?}` | Turns fallback off or on, changes the order, or sets the model per provider |

The keys live in `secrets/providers.json`, mode 0600. No route, log line or error message returns a key. A key typed into a `curl` command ends up in your shell history; the Setup view avoids that. The settings without secrets are in `accounts.json` under `"fallback"`.

**Per request.** The header `x-rotator-no-fallback: 1` keeps the 503 (or, for a request with tools, the 422) for that request. A model named `fireworks:<model>`, `openrouter:<model>` or `anthropic-api:<model>` skips the accounts and goes straight to that provider, with no fallback to the others; nothing after the colon means the configured model. The reply has a top-level `"provider"` field and an `x-gateway-provider` header. The gateway log names the provider and model of every call.

**Limits.** Fireworks and OpenRouter get text only: the system prompt, the turns, text blocks, `max_tokens`, `temperature`, `top_p` and `stop_sequences`. They skip a request with tools, images or documents, so only the Anthropic key can serve one. A request with tools reaches the providers only when every account is out of headroom; if the Anthropic key does not serve it, the gateway returns its usual 422 for tools (a 502 if Anthropic rejected the key). The gateway does not stream, here or anywhere else. Each provider call times out after `CLAUDE_USAGE_PROVIDER_TIMEOUT_MS` (default 120000).

**Terms and cost.** An API key is the way Anthropic's terms allow automated access (see "Risks and terms"), and Fireworks and OpenRouter keys are ordinary paid accounts. The provider bills every fallback call at its per-token price, and this tool sets no spending cap. Set a limit on each key with the provider where it offers one.

## Gateway (optional)

`./install.sh --with-gateway` adds a small HTTP service on 127.0.0.1:7799 for callers that cannot run `ccr`, such as a container or a script that speaks the Messages API. On the same machine, `ccr run` does the same job without it.

- `GET /v1/lease?caller=<name>` returns the account the picker would use now and that account's token. `contrib/claude-pooled` is a client: it leases a token and runs `claude` with it.
- `POST /v1/messages` takes a non-streaming Messages request and serves it with `claude -p` on the best account. Text only: a request with tools gets a 422, because `claude -p` cannot return tool calls. An account whose login fails ("Not logged in") sits out for 5 minutes and the next account takes the request. When every account is out of headroom, the gateway can serve the request through the [fallback providers](#fallback-providers-optional) instead, a request with tools included.
- Every route except `/healthz` needs the `x-gateway-key` header. `install.sh` generates a 32-byte key into `~/.local/share/claude-usage/secrets/gateway.env` (mode 0600). The gateway refuses to start without a key of at least 32 bytes.
- Like the dashboard, it answers only requests addressed to a loopback name on its own port, and refuses browser requests from other origins. If you bind it elsewhere, list the names callers use in `CLAUDE_USAGE_GATEWAY_ALLOWED_HOSTS` (comma-separated) in `gateway.env`.
- Every `claude -p` it runs gets `--tools ""` (no tools), `--no-session-persistence`, `--strict-mcp-config` (no MCP servers), `--restricted` (`claude` reads none of your user, project and local settings files, so their `permissions.allow` rules and hooks do not apply) and `--safe-mode` (no CLAUDE.md, skills, plugins or hooks). The gateway refuses to start if your `claude` does not support `--strict-mcp-config`. A caller can enable `WebSearch` and `WebFetch` for one request with the header `x-gateway-tools: WebSearch,WebFetch`. The header accepts no other tool.
- The watchdog runs every 30 minutes. By default it makes no model call: it checks `/healthz` and sends the key with a malformed request, expecting the gateway's own 400. A run where no account has a login or a setup-token also counts as a failure. With `WATCHDOG_DEEP=1` in `gateway.env` it makes one real call through the gateway instead. It logs a failure after two misses in a row. Set `ALERT_WEBHOOK` in `gateway.env` to also POST `{"text": "..."}` to a Slack or Discord webhook.
- Off by default: `CLAUDE_USAGE_DIRECT_HAIKU=1` forwards Haiku requests straight to the Messages API with the account's OAuth token, and `CLAUDE_USAGE_UPGRADE_SONNET_TO_OPUS=1` serves Sonnet requests as Opus (`claude-opus-5-5`). Read the risk notes before turning either on.

## MCP server

`ccr mcp` is a stdio MCP server, so a Claude Code session (or any MCP client) can check usage and hand a prompt to another account. Add it once:

```bash
claude mcp add --scope user claude-rotator -- ccr mcp    # every project
claude mcp add claude-rotator -- ccr mcp                 # this project only
claude mcp list                                          # claude-rotator: ccr mcp - Connected
```

If Claude Code does not find `ccr` on its PATH, give the full path: `claude mcp add --scope user claude-rotator -- ~/.local/bin/ccr mcp`.

| Tool | Arguments | What it returns |
|---|---|---|
| `rotator_status` | none | Every account's 5-hour and 7-day usage left, per-model weekly caps, reset times, login problems, and which account is "use next" (the same one `ccr ls` points to). It reads the dashboard, or polls once when the dashboard is not running |
| `rotator_ask` | `prompt` (required), `model`, `system` | Runs the prompt on the best account and returns the answer, plus which account or fallback provider served it. The default model is `claude-sonnet-5-5` (`CLAUDE_ROTATOR_MCP_MODEL` changes it) |
| `rotator_providers` | none | The fallback API providers: key set or not, enabled or not, model, and the fallback order. Read-only. Without `app/providers.js` it says "providers not installed" |

`rotator_ask` uses the gateway if you installed it and it answers `/healthz`, so a request can fall back to an API provider when every account is out of headroom. Without the gateway it runs `ccr run -p`, which uses subscription accounts only. Either way the run gets no tools, no MCP servers, none of your settings files, hooks or CLAUDE.md, and no saved session, and the prompt goes in on stdin. It spends quota on the account that serves it. A run stops after 10 minutes (`CLAUDE_ROTATOR_MCP_TIMEOUT_MS`).

Example, from inside a Claude Code session that has the server:

```
> Which rotator account should I use next, and ask it for a one-line summary of RFC 9110.
  claude-rotator - rotator_status (MCP)
    use next: two
    - two <two@example.invalid>: 5h 77% left (resets 2026-10-25T14:00:00Z); 7d 69% left; Fable 88% left [USE NEXT]
  claude-rotator - rotator_ask (MCP)(prompt: "Summarize RFC 9110 in one line.")
    RFC 9110 defines the semantics of HTTP ...
    [served by account two, model claude-sonnet-5-5, via gateway]
```

No tool result carries a token or key. The server builds each result from a fixed list of fields, then replaces every secret value under `secrets/`, and anything that looks like a token, with `[redacted]`. Logs go to stderr; stdout carries MCP messages only. The server speaks MCP 2026-07-28 (`server/discover`, the version in each request's `_meta`) and the `initialize` handshake of 2025-11-25 and earlier, for older clients.

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

- In the default install, every model request goes through the unmodified `claude` binary. The poller also uses each login's token to call two endpoints, `/api/oauth/usage` and `/api/oauth/profile`. Anthropic does not document them, and they can change or disappear without notice. If they break, the status line still feeds live numbers for any account with a session open.
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
- You cannot pull a leased token back. To end it, revoke that account's tokens.
- The token sits in the leasing process's environment. A prompt-injected agent with a shell can read it with `env`. Lease only to processes you trust. The gateway log names the caller and the account, never the token.

**Logins and machines.**

- Never copy `.credentials.json` to a second machine. Each machine's refresh logs the other out (`invalid_grant`). Give each machine its own `/login`, or use a setup-token there.
- On macOS, finding each account's Keychain item relies on Claude Code's internal naming (`Claude Code-credentials-<hash of the dir>`). If Claude Code changes it, the poller stops seeing that login, though the status line keeps working.

## Upgrade

```bash
git pull && ./install.sh [the same flags as before]
```

`install.sh` copies every installed file again (the gateway too, if you installed it), updates its own status line, and restarts the services. It keeps `accounts.json`, your logins and the gateway key.

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
bash test/ui.test.sh          # setup token, setup routes, account names, ccr ui and ccr login
bash test/providers.test.sh   # fallback providers against fake Fireworks, OpenRouter and Anthropic servers
node test/mcp.test.js         # MCP server over stdio: handshake, tools, errors, no secret in any result
bash test/install.test.sh     # full install, add, status line, gateway, upgrade and uninstall in a temp HOME
```

The regression tests use fake servers (and a fake `claude` where a test needs one) on ports 17900 to 17940, 18300 to 18302, 18401 to 18406 and 18410 to 18413, and never call Anthropic or any other provider. `test/ui-browser.sh <work dir>` runs the Setup page in a real Chromium (it needs Playwright on `NODE_PATH`): it adds a slot, saves, tests and removes a provider key, turns the fallback on, clicks every copy button, checks for console errors and saves screenshots at desktop and phone width. `install.test.sh` installs into a temporary HOME with launchd label `test.rotator` (systemd suffix `-test`), dashboard port 17788 and gateway port 17799. It skips the Keychain and points the poller at a dead local port, so it never reads your real logins. On Linux your systemd user manager does not read units from the temporary HOME, so the test detects that, installs with `CLAUDE_USAGE_SYSTEMD_LINK=1` (`systemctl --user link`), and removes the links when it finishes.

## Layout

```
install.sh  uninstall.sh  accounts.example.json
app/        lib.js server.js statusline.js statusline-chain.js poll-once.js setup-dirs.js ccr ccr-helper.js
            shell.sh node-run accuracy-check.js gateway.js watchdog.js providers.js mcp.js public/index.html
contrib/    claude-pooled (gateway lease client), desktop/ (native macOS window: ./build.sh)
test/       regression and install tests
```

`app/accuracy-check.js` is an optional check that compares what the dashboard shows with the raw polls. Run it by hand or from cron.

## License

MIT. See [LICENSE](LICENSE).
