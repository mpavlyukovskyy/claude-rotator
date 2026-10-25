'use strict';
// Poller + local dashboard server. Run: node server.js  (launchd keeps it alive)
const fs = require('fs');
const path = require('path');
const http = require('http');
const L = require('./lib');

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

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!requestAllowed(req)) return send(res, 403, { error: 'forbidden: unexpected Host or Origin' });
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (u.pathname === '/api/state') return send(res, 200, view());
    if (u.pathname === '/api/history') return send(res, 200, history(Number(u.searchParams.get('hours') || 168)));
    if (u.pathname === '/api/poll' && req.method === 'POST') { await pollAll(); return send(res, 200, view()); }
    if (u.pathname === '/healthz') {
      const v = view();
      const stalePoll = v.pollAgeSec == null || v.pollAgeSec > 20 * 60;
      return send(res, stalePoll ? 503 : 200, { ok: !stalePoll, pollAgeSec: v.pollAgeSec, accounts: v.accounts.map(a => ({ id: a.id, ok: a.ok, stale: !!a.stale, error: a.error || null })) });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

server.listen(PORT, HOST, () => log(`claude-usage listening on http://${HOST}:${PORT}`));
const minutes = Number(cfg0.pollMinutes || 5);
pollAll().catch(e => log('poll error', e.message));
setInterval(() => pollAll().catch(e => log('poll error', e.message)), minutes * 60 * 1000);
