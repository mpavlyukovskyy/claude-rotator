'use strict';
// Shared helpers: account config, credential lookup, usage fetch, identity checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const HOME = os.homedir();
const DATA = process.env.CLAUDE_USAGE_DATA || path.join(HOME, '.local/share/claude-usage');
const STATE_DIR = path.join(DATA, 'state');
const LIVE_DIR = path.join(STATE_DIR, 'live');
const CONFIG_PATH = process.env.CLAUDE_USAGE_CONFIG || path.join(DATA, 'accounts.json');
// Override for tests only: points the usage, profile and Messages calls at a fake server.
const API_BASE = (process.env.CLAUDE_USAGE_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '');
// Model for the tiny `claude -p` call that makes Claude Code refresh an idle login, and for the
// 1-token header-usage call. Latest Haiku by default.
const REFRESH_MODEL = process.env.CLAUDE_USAGE_REFRESH_MODEL || 'claude-haiku-5-5';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const e = new Error(`no accounts file at ${CONFIG_PATH} (run install.sh first)`); e.code = 'NOCONFIG'; throw e;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.accounts = (cfg.accounts || []).map(a => ({ ...a, configDir: path.resolve(a.configDir.replace(/^~/, HOME)) }));
  return cfg;
}

// Mirrors Claude Code: default dir -> "Claude Code-credentials";
// custom CLAUDE_CONFIG_DIR -> suffix "-" + first 8 hex of sha256(dir).
// This naming is internal to Claude Code and could change. If it does, the Keychain read misses
// and the status line still feeds live numbers for any account with a session open.
function keychainService(acct) {
  if (acct.default) return 'Claude Code-credentials';
  const h = crypto.createHash('sha256').update(acct.configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${h}`;
}

// Optional long-lived INFERENCE-ONLY tokens from `claude setup-token` (1 year, non-rotating), one per
// account id, in $DATA/secrets/inference-tokens.json (mode 0600):  { "two": "sk-ant-oat01-..." }
// The usage endpoint refuses them (scope), so they are never used to read usage directly; they feed
// the header fallback, `ccr pick --env` and the optional gateway.
function inferenceToken(id) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets', 'inference-tokens.json'), 'utf8'))[id];
    return t ? String(t) : null;
  } catch (_) { return null; }
}

// Login credentials: macOS Keychain first, then <configDir>/.credentials.json (Linux, or the macOS
// fallback when the Keychain refuses a write). Read-only: this app never writes credentials.
function readCredentials(acct) {
  const user = process.env.USER || os.userInfo().username;
  let raw = null, source = null;
  if (process.platform === 'darwin' && !process.env.CLAUDE_USAGE_NO_KEYCHAIN) {
    try {
      raw = execFileSync('security', ['find-generic-password', '-a', user, '-w', '-s', keychainService(acct)],
        { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      source = 'keychain';
    } catch (_) {}
  }
  if (!raw) {
    const p = path.join(acct.configDir, '.credentials.json');
    if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); source = 'file'; }
  }
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw).claudeAiOauth; } catch (_) { return null; }
  if (!o || !o.accessToken) return null;
  return { token: o.accessToken, refreshToken: o.refreshToken || null, expiresAt: o.expiresAt || null, plan: o.subscriptionType || null, tier: o.rateLimitTier || null, source };
}

// Keep an idle login alive with Claude Code's OWN refresh (a tiny `claude -p`), never a hand-rolled
// OAuth call. Claude Code only refreshes a login while a session runs on it, so an unused account's
// access token expires and its usage read fails. Runs only when the token is expired or within 15 min
// of expiry, so it costs about one negligible call per account per token lifetime.
// cwd for the claude -p this app runs: an empty dir of its own, never /tmp.
function emptyCwd() {
  const d = path.join(STATE_DIR, 'cwd');
  try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; } catch (_) { return os.tmpdir(); }
}

function refreshIfStale(acct, creds) {
  if (!creds || creds.source === 'setup-token') return;
  const soon = Date.now() + 15 * 60 * 1000;
  if (creds.expiresAt && creds.expiresAt > soon) return;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.CLAUDECODE; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_USAGE_GATEWAY_KEY;
  if (acct.default) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = acct.configDir;
  try {
    execFileSync(process.env.CLAUDE_BIN || 'claude',
      ['-p', 'ok', '--model', REFRESH_MODEL, '--output-format', 'json', '--no-session-persistence'],
      { encoding: 'utf8', timeout: 60000, input: '', stdio: ['pipe', 'ignore', 'ignore'], env, cwd: emptyCwd() });
  } catch (_) { /* best effort; the poll proceeds with whatever token exists */ }
}

function readIdentity(acct) {
  const p = acct.default ? path.join(HOME, '.claude.json') : path.join(acct.configDir, '.claude.json');
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8')).oauthAccount || {};
    return { email: o.emailAddress || null, org: o.organizationName || null };
  } catch (_) { return { email: null, org: null }; }
}

// Refresh tokens ROTATE: each refresh revokes the previous one. So one login copied to two places (another
// machine, another config dir) is a time bomb: the first side to refresh kills the other (invalid_grant).
// This non-reversible fingerprint lets the dashboard spot two holders of the same login before that happens.
function credFingerprint(rt) {
  return rt ? crypto.createHash('sha256').update(rt).digest('hex').slice(0, 12) : null;
}

// An account's display name is a function of the email it is LOGGED IN as, never of the config slot.
// A `/login` can put any account into any dir, so a hand-typed label goes stale. cfg.nicknames maps
// email -> name; otherwise "local@firstdomainlabel". Falls back to the configured label only when the
// email is unknown.
function labelFor(email, cfg, fallback) {
  if (!email) return fallback || '';
  const nick = (cfg && cfg.nicknames) || {};
  if (nick[email.toLowerCase()]) return nick[email.toLowerCase()];
  const [local, domain = ''] = email.split('@');
  return domain ? `${local}@${domain.split('.')[0]}` : email;
}

// A status-line record carries NO identity. statusline.js can only guess the account from the session's env
// and config dir, and a session keeps the login it started with even after the dir is re-logged as someone
// else. That guess can put one account's numbers on another's card. Reset timestamps are per account, so
// they are the identity check: a live record is accepted for an account ONLY when its windows line up with
// that account's own polled windows (`ref` = its latest good poll) and its used % has not gone backwards
// inside the same window.
// Returns { ok: true } or { ok: false, reason }. No reference or nothing comparable = rejected (unverifiable).
const WINDOW_TOL_MS = 5 * 60 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
function liveBelongsTo(lv, ref, now = Date.now()) {
  if (!lv) return { ok: false, reason: 'no live record' };
  if (!ref) return { ok: false, reason: 'no polled reference to verify against' };
  const checks = [
    ['5-hour', lv.r5, lv.h5, ref.fiveHour, 0],      // a rolled 5-hour window restarts on first use: not predictable
    ['7-day', lv.r7, lv.d7, ref.sevenDay, WEEK_MS], // the weekly window is a fixed schedule: rolls by exactly 7 days
  ];
  let matched = 0;
  for (const [name, lr, lp, rw, period] of checks) {
    const l = lr ? Date.parse(lr) : NaN;
    let r = rw && rw.resetsAt ? Date.parse(rw.resetsAt) : NaN;
    if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
    let rolled = false;
    if (r <= now - WINDOW_TOL_MS) {
      if (!period) continue;
      while (r <= now - WINDOW_TOL_MS) r += period;
      rolled = true;
    }
    if (Math.abs(l - r) > WINDOW_TOL_MS) {
      return { ok: false, reason: `${name} window resets ${new Date(l).toISOString()} but this account's resets ${new Date(r).toISOString()}: another login's numbers` };
    }
    if (!rolled && lp != null && rw.pct != null && Number(lp) < Number(rw.pct) - 1) {
      return { ok: false, reason: `${name} used ${lp}% is below the polled ${rw.pct}% inside the same window` };
    }
    matched++;
  }
  return matched ? { ok: true } : { ok: false, reason: 'no window comparable with the poll' };
}

// Who a token ACTUALLY belongs to. ~/.claude.json only says who last ran /login in that dir; the keychain
// token can belong to someone else for a while (a still-running session refreshes the login it started
// with into the same keychain slot). Cached per token, so it costs one call per refresh.
// Undocumented endpoint: it can change or disappear without notice.
const tokenEmailCache = new Map();
async function fetchTokenEmail(token) {
  const k = crypto.createHash('sha256').update(token).digest('hex');
  if (tokenEmailCache.has(k)) return tokenEmailCache.get(k);
  const r = await fetch(API_BASE + '/api/oauth/profile', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`profile HTTP ${r.status}`);
  const j = await r.json();
  const email = j.account && j.account.email ? String(j.account.email).toLowerCase() : null;
  if (!email) throw new Error('profile has no account email');
  if (tokenEmailCache.size > 50) tokenEmailCache.clear();
  tokenEmailCache.set(k, { email, org: j.organization && j.organization.name || null });
  return tokenEmailCache.get(k);
}

// Undocumented endpoint: it can change or disappear without notice.
async function fetchUsage(token) {
  const r = await fetch(API_BASE + '/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`); }
  return r.json();
}

function win(w) {
  if (!w) return null;
  return { pct: w.utilization == null ? null : Number(w.utilization), resetsAt: w.resets_at || null, locked: w.locked_reason || null };
}

function normalize(u) {
  // Per-model weekly caps. Older shape: seven_day_opus / seven_day_sonnet. Current shape: limits[] entries
  // with kind "weekly_scoped" and scope.model.display_name (e.g. "Fable", "Opus").
  const models = {};
  for (const k of ['seven_day_opus', 'seven_day_sonnet']) if (u[k]) models[k.replace('seven_day_', '')] = { name: k.replace('seven_day_', ''), ...win(u[k]) };
  for (const l of Array.isArray(u.limits) ? u.limits : []) {
    const name = l.scope?.model?.display_name || l.scope?.model?.id;
    if (!name || l.percent == null) continue;
    models[name.toLowerCase()] = { name, pct: Number(l.percent), resetsAt: l.resets_at || null, locked: l.severity === 'blocked' ? l.severity : null, severity: l.severity, active: !!l.is_active };
  }
  return {
    fiveHour: win(u.five_hour),
    sevenDay: win(u.seven_day),
    models,
    extra: u.extra_usage ? { enabled: !!u.extra_usage.is_enabled, pct: u.extra_usage.utilization, capHit: !!u.extra_usage.spend_limit_reached } : null,
    limits: Array.isArray(u.limits) ? u.limits.map(l => ({ kind: l.kind, pct: l.percent, severity: l.severity, resetsAt: l.resets_at, active: l.is_active })) : [],
  };
}

// The numbers come from the token, so the name must too. If the profile call fails the card keeps the
// file's email but says so (identity: 'file'), and the accuracy check treats that as unverified.
async function stampTokenIdentity(base, token) {
  try {
    const t = await fetchTokenEmail(token);
    if (base.email && base.email.toLowerCase() !== t.email) base.fileEmail = base.email;
    base.email = t.email; base.org = t.org || base.org; base.identity = 'token';
  } catch (e) { base.identity = 'file'; base.identityError = e.message; }
}

// Fallback when an account has no usable login but has an inference token: a 1-token Haiku call returns
// the account's unified limits as response headers (5h + 7d utilization, resets, allowed/rejected).
// Per-model caps are not in the headers, so models is left EMPTY (unknown), never filled from stale data.
// This sends a raw Messages call with a subscription token; see the README risk notes.
async function fetchHeaderUsage(token) {
  const r = await fetch(API_BASE + '/v1/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: REFRESH_MODEL, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
    signal: AbortSignal.timeout(30000),
  });
  const h = (k) => r.headers.get('anthropic-ratelimit-unified-' + k);
  if (h('5h-utilization') == null && h('7d-utilization') == null) {
    const t = await r.text().catch(() => '');
    throw new Error(`no usage headers (HTTP ${r.status}) ${t.slice(0, 120)}`);
  }
  const w = (k) => ({
    pct: h(k + '-utilization') == null ? null : Math.round(Number(h(k + '-utilization')) * 1000) / 10,
    resetsAt: h(k + '-reset') ? new Date(Number(h(k + '-reset')) * 1000).toISOString() : null,
    locked: h(k + '-status') === 'rejected' ? 'rate_limited' : null,
  });
  return { fiveHour: w('5h'), sevenDay: w('7d'), models: {}, extra: null, limits: [], status: h('status') };
}

async function headerUsage(acct, base, at) {
  const tok = inferenceToken(acct.id);
  if (!tok) return null;
  try {
    const u = await fetchHeaderUsage(tok);
    return { ...base, ok: true, fetchedAt: at, source: 'headers', modelsUnknown: true, needsLogin: false, ...u };
  } catch (e) {
    return { ...base, ok: false, error: 'usage headers: ' + e.message, source: 'headers' };
  }
}

async function pollAccount(acct) {
  const at = new Date().toISOString();
  const id = readIdentity(acct);
  let creds = readCredentials(acct);
  const base = { id: acct.id, label: acct.label, configDir: acct.configDir, default: !!acct.default, email: id.email, org: id.org, checkedAt: at };
  if (!creds) {
    const viaHeaders = await headerUsage(acct, base, at);
    if (viaHeaders) return viaHeaders;
    return { ...base, ok: false, error: 'not logged in (no credentials found)', needsLogin: true };
  }
  // Refresh an expired or near-expiry login through Claude Code's own logic, then re-read it.
  refreshIfStale(acct, creds);
  creds = readCredentials(acct) || creds;
  base.plan = creds.plan; base.tier = creds.tier; base.tokenExpiresAt = creds.expiresAt; base.credSource = creds.source;
  base.credFp = credFingerprint(creds.refreshToken);
  try {
    const u = await fetchUsage(creds.token);
    await stampTokenIdentity(base, creds.token);
    return { ...base, ok: true, fetchedAt: at, source: 'oauth', ...normalize(u) };
  } catch (e) {
    const expired = creds.expiresAt && Date.now() > creds.expiresAt;
    const viaHeaders = await headerUsage(acct, base, at);
    if (viaHeaders) return { ...viaHeaders, loginError: e.message };
    return { ...base, ok: false, error: e.message, tokenExpired: !!expired };
  }
}

// Isolation flags for a `claude -p` run on someone else's prompt (the gateway's callers, the MCP server's
// rotator_ask), so the prompt can never reach this user's MCP servers, hooks, plugins, CLAUDE.md or
// permission rules (the account dirs share settings.json with ~/.claude by symlink):
//   --strict-mcp-config  with no --mcp-config: no MCP servers at all
//   --restricted         ignores user/project/local settings files, so permissions.allow and hooks there
//                        are not read; drops code-running tools even if --tools were to name them
//   --safe-mode          disables CLAUDE.md, skills, plugins, hooks and MCP; auth works normally
// Each is used when this claude build lists it in --help. Returns null when --strict-mcp-config is missing,
// and the caller refuses to run. Older builds without --restricted get --setting-sources "" instead.
function isolationFlags(claude = process.env.CLAUDE_BIN || 'claude') {
  // Read --help through a file: claude can exit before a pipe to node drains, cutting the text at 8 KB.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-help-'));
  const file = path.join(dir, 'help.txt');
  let help = '';
  try {
    const fd = fs.openSync(file, 'w');
    try { spawnSync(claude, ['--help'], { stdio: ['ignore', fd, fd], timeout: 20000 }); } finally { fs.closeSync(fd); }
    help = fs.readFileSync(file, 'utf8');
  } catch (_) {} finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const has = f => new RegExp('(^|\\s)' + f + '(\\s|,|$)', 'm').test(help);
  if (!has('--strict-mcp-config')) return null;
  const flags = ['--strict-mcp-config'];
  if (has('--restricted')) flags.push('--restricted');
  else if (has('--setting-sources')) flags.push('--setting-sources', '');
  if (has('--safe-mode')) flags.push('--safe-mode');
  return flags;
}

module.exports = {
  HOME, DATA, STATE_DIR, LIVE_DIR, CONFIG_PATH, API_BASE, REFRESH_MODEL,
  loadConfig, keychainService, inferenceToken, readCredentials, refreshIfStale, readIdentity, credFingerprint,
  labelFor, liveBelongsTo, fetchTokenEmail, fetchUsage, normalize, stampTokenIdentity,
  fetchHeaderUsage, headerUsage, pollAccount, isolationFlags,
};
