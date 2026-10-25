'use strict';
// Poller + local dashboard server. Run: node server.js  (launchd keeps it alive)
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const L = require('./lib');
const P = require('./providers');

fs.mkdirSync(L.LIVE_DIR, { recursive: true });
const STATE_FILE = path.join(L.STATE_DIR, 'state.json');
const HISTORY_FILE = path.join(L.STATE_DIR, 'history.jsonl');
const PUBLIC = path.join(__dirname, 'public');

let state = { generatedAt: null, accounts: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function fetchRemotes() {
  const cfg = L.loadConfig();
  const remotes = Array.isArray(cfg.remotes) ? cfg.remotes : [];
  const out = [];
  for (const r of remotes) {
    const label = r.label || r.url;
    try {
      const resp = await fetch(r.url.replace(/\/$/, '') + '/api/state', { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const v = await resp.json();
      out.push({ label, url: r.url, ok: true, accounts: (v.accounts || []).map(a => ({ ...a, remote: label, id: label + ':' + a.id })) });
    } catch (e) {
      out.push({ label, url: r.url, ok: false, error: e.message, accounts: [] });
    }
  }
  return out;
}

async function pollAll() {
  const cfg = L.loadConfig();
  const prev = Object.fromEntries((state.accounts || []).map(a => [a.id, a]));
  const out = [];
  for (const acct of cfg.accounts) {
    const r = await L.pollAccount(acct);
    if (r.ok) {
      out.push({ ...r, lastGood: r });
      fs.appendFileSync(HISTORY_FILE, JSON.stringify({ t: r.fetchedAt, id: r.id, e: r.email || null, h5: r.fiveHour?.pct, r5: r.fiveHour?.resetsAt, d7: r.sevenDay?.pct, r7: r.sevenDay?.resetsAt, m: Object.fromEntries(Object.entries(r.models || {}).map(([k, m]) => [k, m.pct])) }) + '\n');
    } else {
      // keep last known numbers, flagged stale, but ONLY while the slot still holds the same login: after a
      // re-login the old numbers belong to a different account
      const plg = prev[acct.id]?.lastGood || null;
      const lg = plg && (!r.email || !plg.email || plg.email.toLowerCase() === r.email.toLowerCase()) ? plg : null;
      out.push({ ...r, lastGood: lg, ...(lg ? { fiveHour: lg.fiveHour, sevenDay: lg.sevenDay, models: lg.models, extra: lg.extra, fetchedAt: lg.fetchedAt, stale: true } : {}) });
    }
    log(acct.id, r.ok ? `ok 5h=${r.fiveHour?.pct}% 7d=${r.sevenDay?.pct}%` : `FAIL ${r.error}`);
  }
  const remotes = await fetchRemotes();
  state = { generatedAt: new Date().toISOString(), accounts: out, remotes };
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  trimHistory();
  return state;
}

function trimHistory() {
  try {
    const st = fs.statSync(HISTORY_FILE);
    if (st.size < 4 * 1024 * 1024) return;
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(HISTORY_FILE, lines.slice(-20000).join('\n') + '\n');
  } catch (_) {}
}

// Live records are written by statusline.js from inside running sessions.
function readLive() {
  const live = {};
  try {
    for (const f of fs.readdirSync(L.LIVE_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { live[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(L.LIVE_DIR, f), 'utf8')); } catch (_) {}
    }
  } catch (_) {}
  return live;
}

const rejectedLogged = new Set();
function noteRejected(id, at, reason) {
  const k = id + '|' + reason.split(':')[0];
  if (rejectedLogged.has(k)) return;
  rejectedLogged.add(k); log(`live record REJECTED for ${id} (written ${at}): ${reason}`);
}

function effective(w, now) {
  if (!w || w.pct == null) return null;
  if (w.resetsAt && new Date(w.resetsAt).getTime() <= now) return 0; // window has rolled over since we last looked
  return w.pct;
}

// Drain order: subscription budget is use-it-or-lose-it, so spend the account that is
// about to throw its budget away, and spend Fable while it is still there. Three tiers:
//   0  usable AND Fable left      1  usable, Fable gone      2  maxed out (5h or 7d at 100, or locked)
// Inside a tier, earliest FULL reset first = the latest of the account's weekly windows (7-day + each
// per-model weekly cap), i.e. when the whole account is replenished. Tier 2 sorts by when it comes back.
function resetMs(w) { const t = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN; return Number.isFinite(t) ? t : Infinity; }
function fullResetMs(a) {
  const ts = [resetMs(a.sevenDay), ...Object.values(a.models || {}).map(resetMs)].filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : Infinity;
}
// When a maxed-out account becomes usable again: every window currently at 100 has to roll over.
function unblockMs(a) {
  const ts = [];
  if ((a.eff5 ?? 0) >= 100) ts.push(resetMs(a.fiveHour));
  if ((a.eff7 ?? 0) >= 100) ts.push(resetMs(a.sevenDay));
  return ts.length ? Math.max(...ts) : 0;
}
function edf(x, y) {
  return (x.drainTier - y.drainTier)
    || (x.drainTier === 2 ? unblockMs(x) - unblockMs(y) : 0)
    || (fullResetMs(x) - fullResetMs(y))
    || (resetMs(x.fiveHour) - resetMs(y.fiveHour))
    || ((x.eff5 ?? 0) - (y.eff5 ?? 0));
}

// Fable headroom + drain tier. `models` has one weekly entry per capped model, keyed by lower-cased
// display name ("fable"). No entry at all = never told about a Fable cap, so treat it as unknown-but-open
// (only a cap we have actually SEEN at 100 counts as Fable gone).
function fable(v) {
  const pct = v.effModels ? v.effModels.fable : null;
  v.fablePct = pct == null ? null : pct;
  v.fableLeft = pct == null ? null : Math.max(0, Math.round(100 - pct));
  v.hasFable = pct == null || pct < 100;
  v.usable = v.headroom != null && !v.locked && (v.eff5 ?? 0) < 100 && (v.eff7 ?? 0) < 100;
  // Tier 3 = the login itself is broken (revoked, copied, logged out). Its last-known numbers still show,
  // but it must never be ranked, recommended or picked: those numbers describe a login we cannot use.
  v.drainTier = v.ok === false ? 3 : !v.usable ? 2 : v.hasFable ? 0 : 1;
  const fr = fullResetMs(v), ub = unblockMs(v);
  v.fullResetAt = Number.isFinite(fr) ? new Date(fr).toISOString() : null;
  v.unblockAt = ub ? new Date(ub).toISOString() : null;
  return v;
}

// The dashboard page is long-lived (the desktop app keeps one WKWebView open for days) and its poll loop
// only re-fetches DATA, never the HTML, so a shipped UI change stays invisible until a manual reload.
// Hand the page a build stamp so it can notice that its own source changed on disk and reload itself once.
function uiBuild() {
  try { const st = fs.statSync(path.join(PUBLIC, 'index.html')); return `${Math.round(st.mtimeMs)}-${st.size}`; }
  catch (_) { return 'na'; }
}

function view() {
  const now = Date.now();
  const live = readLive();
  const accounts = (state.accounts || []).map(a => {
    const v = { ...a };
    const lv = live[a.id];
    // Only a live record whose windows match this account's own poll may speak for it (lib.liveBelongsTo).
    const ref = a.ok ? a : a.lastGood && (!a.email || a.lastGood.email === a.email) ? a.lastGood : null;
    const fresh = lv && (!v.fetchedAt || new Date(lv.at) > new Date(v.fetchedAt));
    const belongs = fresh ? L.liveBelongsTo(lv, ref, now) : null;
    if (belongs && !belongs.ok) { v.liveRejected = { at: lv.at, reason: belongs.reason }; noteRejected(a.id, lv.at, belongs.reason); }
    v.activeSession = !!(lv && belongs && belongs.ok && now - new Date(lv.at).getTime() < 3 * 60 * 1000);
    if (belongs && belongs.ok) {
      v.fiveHour = { pct: lv.h5, resetsAt: lv.r5, locked: null };
      v.sevenDay = { pct: lv.d7, resetsAt: lv.r7, locked: null };
      v.fetchedAt = lv.at; v.stale = false; v.source = 'statusline';
      if (!v.ok) { v.ok = true; v.error = null; }
    } else if (a.ok) v.source = 'poll';
    v.eff5 = effective(v.fiveHour, now);
    v.eff7 = effective(v.sevenDay, now);
    v.locked = !!(v.fiveHour?.locked || v.sevenDay?.locked || (v.limits || []).some(l => l.severity === 'blocked'));
    v.effModels = Object.fromEntries(Object.entries(v.models || {}).map(([k, m]) => [k, effective(m, now)]));
    v.effWeekMax = Math.max(v.eff7 ?? 0, ...Object.values(v.effModels).filter(x => x != null));
    // Eligibility uses the GENERAL windows only. A single per-model cap (e.g. Fable at 100%) must not
    // disqualify the account for other models; the gateway skips it per-request for that model.
    v.headroom = v.eff5 == null ? null : Math.min(100 - v.eff5, 100 - (v.eff7 ?? 0));
    return fable(v);
  });
  // The same login (same refresh-token fingerprint) on this machine AND a remote = one rotating chain with two
  // refreshers; the next refresh on either side revokes the other. Say so on the card, loudly, before it dies.
  const remoteFp = new Map();
  for (const r of state.remotes || []) for (const ra of r.accounts || []) if (ra.credFp) remoteFp.set(ra.credFp, ra.id);
  for (const a of accounts) {
    const twin = a.credFp && remoteFp.get(a.credFp);
    if (twin) { a.sharedChain = twin; a.ok = false; a.drainTier = 3; a.error = `This login is COPIED to ${twin}: both machines refresh one token and the next refresh kills the other. Keep one owner.`; }
  }
  // Fold in accounts reported by remote dashboards (each already view-shaped).
  const localEmails = new Set(accounts.map(a => a.email).filter(Boolean));
  for (const r of state.remotes || []) {
    for (const ra of r.accounts || []) {
      if (ra.email && localEmails.has(ra.email)) continue; // same subscription as a local login: one budget, list it once
      const eff5 = ra.eff5, eff7 = ra.eff7;
      // A remote dashboard may run an older build with no Fable/tier fields, so annotate here too.
      accounts.push(fable({ ...ra, effWeekMax: ra.effWeekMax != null ? ra.effWeekMax : (eff7 ?? 0), remoteOk: r.ok }));
    }
  }
  // One login = one card, titled by that login. Two LOCAL dirs can hold the same subscription (a /login into
  // the default dir of an account that also has its own dir): keep the row with live data, drop the other.
  const cfg = L.loadConfig();
  const rank = a => (a.activeSession ? 4 : 0) + (a.ok ? 2 : 0) + (a.remote ? 0 : 1);
  const byEmail = new Map(), deduped = [];
  for (const a of accounts) {
    a.configLabel = a.label;
    a.label = L.labelFor(a.email, cfg, a.label);
    if (!a.email) { deduped.push(a); continue; }
    const prev = byEmail.get(a.email);
    if (!prev) { byEmail.set(a.email, a); deduped.push(a); continue; }
    const better = rank(a) !== rank(prev) ? rank(a) > rank(prev) : String(a.fetchedAt || '') > String(prev.fetchedAt || '');
    if (better) { deduped[deduped.indexOf(prev)] = a; byEmail.set(a.email, a); }
  }
  accounts.length = 0; accounts.push(...deduped);
  // Last-resort logins (an account with "lastResort": true, or an email in cfg.lastResort) rank below every
  // other usable account, above the maxed-out ones, so neither `recommended` nor the picker lands on them first.
  const lr = new Set((cfg.lastResort || []).map(e => e.toLowerCase()));
  const lrIds = new Set(cfg.accounts.filter(a => a.lastResort).map(a => a.id));
  for (const a of accounts) a.lastResort = lrIds.has(a.id) || !!(a.email && lr.has(a.email.toLowerCase()));
  const grp = a => a.drainTier >= 2 ? a.drainTier + 1 : a.lastResort ? 1 : 0; // 0 normal · 1 last resort · 3 maxed · 4 broken
  accounts.sort((x, y) => (grp(x) - grp(y)) || edf(x, y)); // tier (Fable first) -> earliest full reset; maxed-out accounts land at the bottom
  const lastPoll = state.generatedAt ? now - new Date(state.generatedAt).getTime() : null;
  return { generatedAt: state.generatedAt, uiBuild: uiBuild(), now: new Date(now).toISOString(), pollAgeSec: lastPoll == null ? null : Math.round(lastPoll / 1000), recommended: accounts.find(a => a.drainTier < 2)?.id || null, fableLeftIds: accounts.filter(a => a.drainTier === 0).map(a => a.id), strategy: 'fable-left-first, then earliest full reset', accounts };
}

function history(hours) {
  const since = Date.now() - hours * 3600 * 1000;
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(r => r && new Date(r.t).getTime() >= since);
  } catch (_) { return []; }
}

function send(res, code, body, type = 'application/json', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const cfg0 = L.loadConfig();
// The port comes from accounts.json only (install.sh writes it from CLAUDE_USAGE_PORT), so ccr, the
// gateway and this server always agree on it.
const PORT = Number(cfg0.port || 7788);
const HOST = process.env.CLAUDE_USAGE_HOST || cfg0.host || '127.0.0.1';

// Any web page can make the browser send requests to 127.0.0.1, and DNS rebinding can make a page's own
// hostname resolve here. So answer only requests addressed to a loopback name on this port (or a name
// listed in accounts.json "allowedHosts", for a dashboard that remotes read), and refuse a POST that
// another origin started.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EXTRA_HOSTS = new Set((cfg0.allowedHosts || []).map(h => String(h).toLowerCase()));
function hostAllowed(hostname, port) {
  hostname = hostname.toLowerCase();
  if (LOOPBACK.has(hostname)) return port === PORT;
  return EXTRA_HOSTS.has(hostname) || EXTRA_HOSTS.has(`${hostname}:${port}`);
}
function requestAllowed(req) {
  const m = String(req.headers.host || '').match(/^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/);
  if (!m || !hostAllowed(m[1], Number(m[2] || 80))) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (!req.headers.origin) return true; // curl, ccr and other non-browser clients send none
  try { const o = new URL(req.headers.origin); return hostAllowed(o.hostname, Number(o.port || 80)); } catch (_) { return false; }
}

// ---- Setup token -----------------------------------------------------------------------------------------
// A random secret in DATA/secrets/ui-token (install.sh writes it; the server writes one if it is missing).
// The page gets it in a meta tag only when it was loaded through a loopback name on our own port, and every
// state-changing setup route must send it back in x-rotator-ui-token. Another site can make the browser send
// requests here, but it cannot read the page, so it never learns the token.
const UI_TOKEN_FILE = path.join(L.DATA, 'secrets', 'ui-token');
function uiToken() {
  try { const t = fs.readFileSync(UI_TOKEN_FILE, 'utf8').trim(); return /^[A-Za-z0-9_-]{32,}$/.test(t) ? t : ''; } catch (_) { return ''; }
}
function ensureUiToken() {
  if (uiToken()) return;
  fs.mkdirSync(path.dirname(UI_TOKEN_FILE), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(UI_TOKEN_FILE, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); log('setup token -> ' + UI_TOKEN_FILE); }
  catch (e) { if (e.code !== 'EEXIST') log('could not write the setup token: ' + e.message); }
}
// The socket's peer address, unlike the Host header, is not the client's to choose. A dashboard bound off
// loopback must not hand the token to a LAN client that sends Host: 127.0.0.1. The test hook can only
// demote a request to "not local", so setting it never grants anything.
const TEST_REMOTE_HOOK = process.env.CLAUDE_USAGE_TEST_REMOTE_HOOK === '1';
function loopbackPeer(req) {
  if (TEST_REMOTE_HOOK && req.headers['x-test-remote-nonlocal']) return false;
  const a = String((req.socket && req.socket.remoteAddress) || '').toLowerCase();
  return /^127\./.test(a) || a === '::1' || /^::ffff:127\./.test(a);
}
// true when the request comes from this machine and carries the setup token.
// Callers: if (!requireUiToken(req)) return send(res, 403, ...)
function requireUiToken(req) {
  if (!loopbackPeer(req)) return false;
  const want = Buffer.from(uiToken()), got = Buffer.from(String(req.headers['x-rotator-ui-token'] || ''));
  return want.length >= 32 && got.length === want.length && crypto.timingSafeEqual(got, want);
}
const NO_TOKEN = { error: 'setup token missing or wrong, or the request did not come from this machine: reload the dashboard from http://127.0.0.1 on this machine' };
// The token goes only into a page loaded from this machine as 127.0.0.1 / localhost / [::1] on our port,
// never through an allowedHosts name (those exist so another machine can read /api/state).
function loopbackRequest(req) {
  const m = String(req.headers.host || '').match(/^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/);
  return loopbackPeer(req) && !!m && LOOPBACK.has(m[1].toLowerCase()) && Number(m[2] || 80) === PORT;
}
function indexHtml(req) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const t = loopbackRequest(req) ? uiToken() : '';
  return html.replace('<meta name="rotator-ui-token" content="">', `<meta name="rotator-ui-token" content="${t}">`);
}
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const fail = (status, msg) => reject(Object.assign(new Error(msg), { status }));
    // Past the limit, keep reading but drop the bytes, so the 413 still reaches the client.
    req.on('data', c => { size += c.length; if (size > limit) { if (chunks.length) { chunks.length = 0; fail(413, 'request body too large'); } } else chunks.push(c); });
    req.on('end', () => {
      if (size > limit) return fail(413, 'request body too large');
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); v && typeof v === 'object' && !Array.isArray(v) ? resolve(v) : fail(400, 'body must be a JSON object'); }
      catch (_) { fail(400, 'body is not valid JSON'); }
    });
    req.on('error', reject);
  });
}

// ---- Setup view data ----------------------------------------------------------------------------------------
const MAC = process.platform === 'darwin';
const OPEN_CMD = process.env.CLAUDE_USAGE_OPEN_CMD || 'open'; // test hook: a fake `open` that records its argument
const GATEWAY_ENV = path.join(L.DATA, 'secrets', 'gateway.env');
const MCP_LINE = 'claude mcp add --scope user claude-rotator -- ccr mcp';
const tilde = p => String(p || '').replace(L.HOME, '~');
function run(cmd, args, opts = {}) {
  return new Promise(resolve => execFile(cmd, args, { timeout: 15000, encoding: 'utf8', ...opts },
    (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: stdout || '', stderr: stderr || (e && !stdout ? e.message : '') })));
}
let claudeSeen = null;
async function claudeInfo() {
  if (claudeSeen && Date.now() - claudeSeen.at < 60000) return claudeSeen.v;
  const r = await run(process.env.CLAUDE_BIN || 'claude', ['--version'], { timeout: 8000, cwd: L.STATE_DIR });
  const v = r.code === 0 ? { found: true, version: r.stdout.trim().split('\n')[0].replace(/\s*\(Claude Code\)\s*$/, '') } : { found: false, version: null };
  claudeSeen = { at: Date.now(), v };
  return v;
}
function gatewayEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(GATEWAY_ENV, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (_) { return null; }
  return env;
}
async function gatewayInfo() {
  const env = gatewayEnv();
  if (!env || !env.CLAUDE_USAGE_GATEWAY_KEY) return { installed: false, url: null, running: false };
  const url = `http://127.0.0.1:${Number(env.CLAUDE_USAGE_GATEWAY_PORT || 7799)}`;
  let running = false;
  try { running = (await fetch(url + '/healthz', { signal: AbortSignal.timeout(1500) })).ok; } catch (_) {}
  return { installed: true, url, running };
}
// Is the claude-rotator MCP server registered with Claude Code (user scope, or local scope in any project)?
let mcpSeen = { mtime: -1, v: false };
function mcpRegistered() {
  const f = path.join(L.HOME, '.claude.json');
  try {
    const mtime = fs.statSync(f).mtimeMs;
    if (mtime !== mcpSeen.mtime) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const has = o => !!(o && o.mcpServers && o.mcpServers['claude-rotator']);
      mcpSeen = { mtime, v: has(j) || Object.values(j.projects || {}).some(has) };
    }
    return mcpSeen.v;
  } catch (_) { return false; }
}
// providers.config() fills the defaults (an install from before v2 has no "fallback" key in accounts.json).
function providersInfo() {
  let list, fallback;
  try { list = P.list(); fallback = { enabled: !!P.config().enabled }; }
  catch (_) { return { available: false, configured: 0, total: 0, fallback: { enabled: false } }; }
  return { available: true, configured: list.filter(p => p.configured).length, total: list.length, fallback };
}
async function setupView() {
  const cfg = L.loadConfig();
  const polled = new Map((state.accounts || []).map(a => [a.id, a]));
  const accounts = cfg.accounts.map(a => {
    const r = polled.get(a.id);
    const status = !r ? 'pending' : r.needsLogin ? 'login' : r.ok ? 'ok' : 'error';
    return { id: a.id, label: a.label || a.id, configDir: tilde(a.configDir), default: !!a.default, status, email: r ? r.email || null : null,
      error: status === 'error' ? String(r.error || '').slice(0, 200) : null };
  });
  const [claude, gateway] = await Promise.all([claudeInfo(), gatewayInfo()]);
  const lastPoll = state.generatedAt ? Math.round((Date.now() - new Date(state.generatedAt).getTime()) / 1000) : null;
  return {
    platform: process.platform, canOpenTerminal: MAC, claude,
    dashboard: { up: true, url: `http://127.0.0.1:${PORT}`, pollAgeSec: lastPoll },
    accounts, loggedIn: accounts.filter(a => a.status === 'ok').length,
    providers: providersInfo(), gateway,
    mcp: { command: MCP_LINE, registered: mcpRegistered() },
  };
}
// accounts.json has one writer at a time
let accountsQueue = Promise.resolve();
function addAccount(name) {
  const job = accountsQueue.then(async () => {
    const add = await run(process.execPath, [path.join(__dirname, 'ccr-helper.js'), 'add', name]);
    if (add.code !== 0) return { status: 400, body: { error: add.stderr.trim().replace(/^ccr add: /, '') || 'could not add the account' } };
    const dirs = await run(process.execPath, [path.join(__dirname, 'setup-dirs.js'), name]);
    if (dirs.code !== 0) log(`setup-dirs ${name} failed: ${dirs.stderr.trim()}`);
    return { status: 200, body: { ok: true, id: name, dir: tilde(add.stdout.trim()), login: `ccr login ${name}` } };
  });
  accountsQueue = job.catch(() => {});
  return job;
}
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
// macOS: a .command file opens in Terminal and runs the login there. The browser never sees a password.
// The file deletes itself as its last step (uninstall.sh removes any left in DATA/state with the rest).
async function openLogin(id) {
  const f = path.join(L.STATE_DIR, `login-${id}.command`);
  // Terminal runs the file without the user's shell rc files, so hand it the service's PATH, node and data dir.
  const env = { PATH: `${process.env.PATH || ''}:/usr/bin:/bin`, CLAUDE_USAGE_NODE: process.execPath, CLAUDE_USAGE_DATA: L.DATA, CLAUDE_USAGE_CONFIG: L.CONFIG_PATH };
  fs.writeFileSync(f, ['#!/bin/bash', `# Written by the claude-rotator dashboard: log in to the "${id}" account.`,
    ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
    `${shq(path.join(__dirname, 'ccr'))} login ${shq(id)}`,
    'echo; read -n 1 -s -r -p "Done. Press any key to close this window."; echo',
    `rm -f ${shq(f)}`, ''].join('\n'), { mode: 0o700 });
  fs.chmodSync(f, 0o700);
  const r = await run(OPEN_CMD, [f]);
  return r.code === 0 ? { status: 200, body: { ok: true } } : { status: 500, body: { error: 'could not open Terminal: ' + (r.stderr.trim() || 'exit ' + r.code) } };
}

// ---- fallback providers API (providers.js) ----------------------------------------------------------
// GET /api/providers lists providers without keys. Everything that changes state or spends money needs the
// setup token. A key goes in once and never comes back out: responses carry only the masked hint.
// A body that does not parse is the caller's mistake (400), whatever error readJson rejects with.
const jsonBody = req => readJson(req).catch(e => { throw Object.assign(new Error(e.message || 'bad json'), { code: (e.status || e.code) === 413 ? 413 : 400 }); });
async function providersRoute(req, res, u) {
  const m = u.pathname.match(/^\/api\/providers(?:\/([a-z-]+)(\/test)?)?$/);
  const isFallback = u.pathname === '/api/fallback';
  if (!m && !isFallback) return false;
  if (req.method === 'GET' && m && !m[1]) { send(res, 200, { providers: P.list(), fallback: P.config() }); return true; }
  if (req.method !== 'POST' && req.method !== 'DELETE') { send(res, 405, { error: 'method not allowed' }); return true; }
  if (!requireUiToken(req)) { send(res, 403, NO_TOKEN); return true; }
  try {
    if (isFallback && req.method === 'POST') { P.setFallback(await jsonBody(req)); send(res, 200, { ok: true, providers: P.list(), fallback: P.config() }); }
    else if (m && m[1] && m[2] && req.method === 'POST') send(res, 200, await P.test(m[1]));
    else if (m && m[1] && req.method === 'POST') { P.setKey(m[1], (await jsonBody(req)).apiKey); log(`provider key saved for ${m[1]}`); send(res, 200, { ok: true, providers: P.list() }); }
    else if (m && m[1] && req.method === 'DELETE') { P.removeKey(m[1]); log(`provider key removed for ${m[1]}`); send(res, 200, { ok: true, providers: P.list() }); }
    else send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || (typeof e.code === 'number' ? e.code : 500), { error: e.message }); }
  return true;
}
// ---- END fallback providers API ---------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!requestAllowed(req)) return send(res, 403, { error: 'forbidden: unexpected Host or Origin' });
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') return send(res, 200, indexHtml(req), 'text/html; charset=utf-8', { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    if (u.pathname === '/api/state') return send(res, 200, view());
    if (u.pathname === '/api/history') return send(res, 200, history(Number(u.searchParams.get('hours') || 168)));
    if (u.pathname === '/api/poll' && req.method === 'POST') { await pollAll(); return send(res, 200, view()); }
    // --- setup UI routes (ui agent) ---
    if (u.pathname === '/api/setup' && req.method === 'GET') return send(res, 200, await setupView());
    if (u.pathname === '/api/accounts' && req.method === 'POST') {
      if (!requireUiToken(req)) return send(res, 403, NO_TOKEN);
      const { name } = await readJson(req);
      if (typeof name !== 'string' || !name) return send(res, 400, { error: 'name is required' });
      const r = await addAccount(name);
      if (r.status === 200) pollAll().catch(e => log('poll error', e.message));
      return send(res, r.status, r.body);
    }
    const ol = u.pathname.match(/^\/api\/accounts\/([^/]+)\/open-login$/);
    if (ol && req.method === 'POST') {
      if (!requireUiToken(req)) return send(res, 403, NO_TOKEN);
      if (!MAC) return send(res, 400, { error: 'Open login in Terminal is macOS only. Run the ccr login command in a terminal.' });
      let id = ''; try { id = decodeURIComponent(ol[1]); } catch (_) {}
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !L.loadConfig().accounts.some(a => a.id === id)) return send(res, 404, { error: `no account "${id}"` });
      const r = await openLogin(id);
      return send(res, r.status, r.body);
    }
    if (u.pathname === '/api/gateway/key' && req.method === 'GET') {
      if (!requireUiToken(req)) return send(res, 403, NO_TOKEN);
      const env = gatewayEnv();
      if (!env || !env.CLAUDE_USAGE_GATEWAY_KEY) return send(res, 404, { error: 'the gateway is not installed (./install.sh --with-gateway)' });
      return send(res, 200, { key: env.CLAUDE_USAGE_GATEWAY_KEY });
    }
    // --- end setup UI routes ---
    if (u.pathname === '/healthz') {
      const v = view();
      const stalePoll = v.pollAgeSec == null || v.pollAgeSec > 20 * 60;
      return send(res, stalePoll ? 503 : 200, { ok: !stalePoll, pollAgeSec: v.pollAgeSec, accounts: v.accounts.map(a => ({ id: a.id, ok: a.ok, stale: !!a.stale, error: a.error || null })) });
    }
    // --- fallback providers routes (providers agent) ---
    if (await providersRoute(req, res, u)) return;
    // --- end fallback providers routes ---
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
});

ensureUiToken();
server.listen(PORT, HOST, () => log(`claude-usage listening on http://${HOST}:${PORT}`));
const minutes = Number(cfg0.pollMinutes || 5);
pollAll().catch(e => log('poll error', e.message));
setInterval(() => pollAll().catch(e => log('poll error', e.message)), minutes * 60 * 1000);
