'use strict';
/*
 * Optional gateway (installed only with `install.sh --with-gateway`). Lets a caller that cannot run
 * `ccr` itself (a container, a script that speaks the Messages API) use the account pool.
 *
 *   POST /v1/messages  Non-streaming Messages request. Served by `claude -p` on the account with the
 *                      most headroom. The request is flattened to text: tool_use is not supported on
 *                      this path (422, unless every account is exhausted and a fallback provider serves
 *                      it). With CLAUDE_USAGE_DIRECT_HAIKU=1, Haiku requests are instead
 *                      forwarded verbatim to the Messages API with the account's OAuth token. That
 *                      direct route is OFF by default; see the README risk notes before turning it on.
 *   GET  /v1/lease     Returns the account the picker would use right now plus that account's token,
 *                      so a caller can run `claude` itself. The token goes to the caller in the body;
 *                      the log line names caller and account, never the token.
 *   GET  /healthz      Liveness and the current bench list. No auth.
 *
 * Fallback (providers.js): when every account is benched or capped (the 503 below), POST /v1/messages is
 * served by the paid providers in accounts.json "fallback" instead, unless it is off there or the request
 * sends x-rotator-no-fallback: 1. A model named "fireworks:<slug>", "openrouter:<slug>" or
 * "anthropic-api:<slug>" skips the accounts and goes straight to that provider.
 *
 * Auth: every route except /healthz needs the x-gateway-key header. The gateway refuses to start
 * without a key of 32+ bytes. It binds 127.0.0.1 unless CLAUDE_USAGE_GATEWAY_HOST says otherwise.
 * Config: $CLAUDE_USAGE_DATA/secrets/gateway.env (KEY=VALUE lines), read at start. Variables already
 * set in the process environment win over the file.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const L = require('./lib');
const P = require('./providers');

const ENV_FILE = process.env.CLAUDE_USAGE_GATEWAY_ENV || path.join(L.DATA, 'secrets', 'gateway.env');
function loadEnvFile(p) {
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(ENV_FILE);

function log(...a) { console.log(new Date().toISOString(), ...a); }

let cfgPort = 7788;
try { cfgPort = L.loadConfig().port || 7788; } catch (_) {}
const PORT = Number(process.env.CLAUDE_USAGE_GATEWAY_PORT || 7799);
const HOST = process.env.CLAUDE_USAGE_GATEWAY_HOST || '127.0.0.1';
const KEY = process.env.CLAUDE_USAGE_GATEWAY_KEY || '';
if (Buffer.byteLength(KEY) < 32) {
  log(`refusing to start: CLAUDE_USAGE_GATEWAY_KEY must be set to 32 or more bytes (in ${ENV_FILE} or the environment)`);
  process.exit(78); // EX_CONFIG
}
const KEY_BUF = Buffer.from(KEY);
function keyOk(req) {
  const got = Buffer.from(String(req.headers['x-gateway-key'] || ''));
  // timingSafeEqual needs equal lengths; compare against a same-length buffer so the length check
  // does not short-circuit before a constant-time compare runs.
  const ok = crypto.timingSafeEqual(got.length === KEY_BUF.length ? got : Buffer.alloc(KEY_BUF.length), KEY_BUF);
  return ok && got.length === KEY_BUF.length;
}

const DASH = process.env.CLAUDE_USAGE_DASH || `http://127.0.0.1:${cfgPort}`;
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const CLI_TIMEOUT_MS = Number(process.env.CLAUDE_USAGE_CLI_TIMEOUT_MS || 600000);
const CLI_BENCH_MS = 10 * 60 * 1000; // a real usage-limit error, not an RPM blip
// An empty dir of our own (not /tmp, where other users' files and a stray CLAUDE.md can sit).
const CLI_CWD = process.env.CLAUDE_USAGE_CLI_CWD || path.join(L.STATE_DIR, 'cwd');
fs.mkdirSync(CLI_CWD, { recursive: true, mode: 0o700 });
// Raw Messages calls with a subscription OAuth token only ever succeeded for Haiku in practice; other
// models get a bare 429 with no rate-limit headers. Off unless explicitly enabled.
const DIRECT_HAIKU = process.env.CLAUDE_USAGE_DIRECT_HAIKU === '1';
const DIRECT_OK_RE = /^claude-haiku/i;
// Optional: serve Sonnet requests as Opus on the claude -p path. Off by default; =1 turns it on.
// A request can opt out with the header x-gateway-no-upgrade: 1.
const UPGRADE_SONNET_TO_OPUS = process.env.CLAUDE_USAGE_UPGRADE_SONNET_TO_OPUS === '1';
const OPUS_MODEL = process.env.CLAUDE_USAGE_OPUS_MODEL || 'claude-opus-5-5';
function servedModel(model, noUpgrade) { return !noUpgrade && UPGRADE_SONNET_TO_OPUS && /^claude-sonnet/i.test(String(model || '')) ? OPUS_MODEL : model; }
const LIMIT_RE = /rate.?limit|usage limit|limit reached|hit your limit|quota|\b429\b|out of extra usage|locked/i;
// A dead or missing login on one account: bench that account and try the next one (then the providers),
// the same as a usage limit, instead of failing the whole request.
const LOGIN_RE = /not logged in|please run \/login|invalid api key|oauth token has expired|token (has been )?revoked|invalid_grant|authentication_error|\b401\b/i;
const LOGIN_BENCH_MS = 5 * 60 * 1000;
const ANTHROPIC = process.env.CLAUDE_USAGE_ANTHROPIC_URL || L.API_BASE + '/v1/messages';
const BETA = process.env.CLAUDE_USAGE_OAUTH_BETA || 'oauth-2025-04-20';
const CALL_TIMEOUT_MS = Number(process.env.CLAUDE_USAGE_GATEWAY_TIMEOUT_MS || 180000);
const RATE_COOLDOWN_MS = Number(process.env.CLAUDE_USAGE_RATE_COOLDOWN_MS || 25000); // transient RPM 429s recover in seconds

// key -> until-epoch-ms. Two kinds of key:
//   "<id>"         the whole account: a real usage limit on the claude -p path (CLI_BENCH_MS).
//   "<id>|<model>" one model on one account: a 429 on the direct path. Anthropic answers a model the
//                  subscription will not serve raw with that same bare 429 on EVERY account, so benching
//                  the whole account would let one request for such a model take every account out and
//                  503 the healthy traffic behind it.
const benched = new Map();
function benchKey(id, model) { return `${id}|${String(model || '').toLowerCase()}`; }
function isBenched(id, model, now) { return (benched.get(id) || 0) > now || (benched.get(benchKey(id, model)) || 0) > now; }

// Pick accounts by headroom from the dashboard, best first, skipping benched/exhausted/unhealthy.
// Earliest-reset-first: subscription budget is use-it-or-lose-it, so spend the account whose weekly
// window resets soonest, then the soonest 5-hour reset, then most headroom. Missing reset = last.
function resetMs(w) { const t = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN; return Number.isFinite(t) ? t : Infinity; }
// Accounts flagged lastResort in accounts.json are used ONLY when every other account is exhausted or
// benched. They sort after everything else regardless of reset.
function lastResortIds() { try { return new Set((L.loadConfig().accounts || []).filter(a => a.lastResort).map(a => a.id)); } catch (_) { return new Set(); } }
function edf(x, y) {
  const LR = edf._lr || (edf._lr = lastResortIds());
  const lx = LR.has(x.id) ? 1 : 0, ly = LR.has(y.id) ? 1 : 0;
  if (lx !== ly) return lx - ly;
  return (resetMs(x.sevenDay) - resetMs(y.sevenDay)) || (resetMs(x.fiveHour) - resetMs(y.fiveHour)) || ((x.eff5 ?? 0) - (y.eff5 ?? 0));
}

async function pickOrder(model) {
  const now = Date.now();
  edf._lr = lastResortIds();
  let accts = [];
  try {
    const r = await fetch(DASH + '/api/state', { signal: AbortSignal.timeout(6000) });
    const v = await r.json();
    // An account whose OAuth login died (ok:false) stays eligible when it has a long-lived inference
    // token; its usage is then unknown, so stale headroom numbers are dropped and 429s bench it.
    accts = (v.accounts || []).filter(a => !a.remote && a.configDir && (a.ok !== false || L.inferenceToken(a.id)))
      .map(a => (a.ok === false ? { ...a, eff5: null, eff7: null, effModels: {}, locked: null } : a));
  } catch (_) {}
  if (!accts.length) {
    // fallback: the raw config, no headroom info
    try { accts = L.loadConfig().accounts.map(a => ({ id: a.id, configDir: a.configDir, default: a.default, eff5: 0, eff7: 0 })); } catch (_) {}
  }
  return accts
    .filter(a => !isBenched(a.id, model, now))
    .filter(a => (a.eff5 == null || a.eff5 < 100) && (a.eff7 == null || a.eff7 < 100) && !a.locked)
    // Per-model weekly cap: skip this account only when the cap for the REQUESTED model is exhausted.
    .filter(a => { const caps = a.effModels || {}; const m = String(model || '').toLowerCase(); const k = Object.keys(caps).find(k => m.includes(k)); return !(k && caps[k] != null && caps[k] >= 100); })
    .sort(edf);
}

function tokenFor(acct) {
  const a = { id: acct.id, configDir: acct.configDir, default: acct.default, label: acct.id };
  let creds = L.readCredentials(a);
  if (creds) { try { L.refreshIfStale(a, creds); const f = L.readCredentials(a); if (f) creds = f; } catch (_) {} }
  // A wiped or expired login (empty token, or expiry passed) falls back to the long-lived inference token.
  const live = creds && creds.token && (!creds.expiresAt || creds.expiresAt > Date.now());
  return live ? creds.token : (L.inferenceToken(acct.id) || (creds ? creds.token : null));
}

async function proxyOnce(acct, body) {
  const token = tokenFor(acct);
  if (!token) return { skip: 'no token' };
  const r = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await r.text();
  return { status: r.status, text };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function handle(body) {
  let lastErr = null;
  // Up to a few passes: rotate accounts on 429 (each has its own burst budget); if a whole
  // pass is rate-limited, back off briefly and retry. RPM limits recover in seconds.
  for (let pass = 0; pass < 4; pass++) {
    const order = await pickOrder(body.model);
    if (!order.length) { if (pass < 3) { await sleep(1500 * (pass + 1)); continue; } const e = new Error('no account with headroom'); e.code = 503; throw e; }
    for (const acct of order) {
      let res;
      try { res = await proxyOnce(acct, body); }
      catch (e) { lastErr = e.message; continue; }
      if (res.skip) { lastErr = res.skip; continue; }
      if (res.status === 429) { benched.set(benchKey(acct.id, body.model), Date.now() + RATE_COOLDOWN_MS); lastErr = '429 on ' + acct.id; continue; }
      if (res.status === 401) {
        // token likely expired despite refresh; force one more refresh then retry same account
        tokenFor(acct);
        try { const res2 = await proxyOnce(acct, body); if (res2.status && res2.status !== 401) return { ...res2, account: acct.id }; } catch (_) {}
        lastErr = '401 on ' + acct.id; continue;
      }
      return { ...res, account: acct.id };
    }
    // whole pass exhausted (all 429/skip): brief backoff, then retry
    await sleep(1200 * (pass + 1));
  }
  const e = new Error('all accounts rate-limited after retries: ' + (lastErr || 'unknown')); e.code = 503; throw e;
}

// --- claude -p executor ---------------------------------------------------
// The prompt goes over STDIN, never as an argv element: a large prompt as an argument fails with
// `spawn E2BIG`, and stdin has no such ceiling. `claude -p` with no positional prompt reads stdin.
function runClaude(args, env, stdinText) {
  return new Promise((res, rej) => {
    const child = spawn(CLAUDE, args, { env, cwd: CLI_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(Object.assign(new Error(`timed out after ${CLI_TIMEOUT_MS}ms`), { killed: true, stdout: out, stderr: err }));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); rej(Object.assign(e, { stdout: out, stderr: err })); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) rej(Object.assign(new Error(`claude exited ${code}`), { stdout: out, stderr: err, code }));
      else res({ stdout: out, stderr: err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText);
  });
}

// Flatten an Anthropic Messages request into one claude -p invocation. Text blocks only:
// `claude -p` returns prose, never a tool_use block.
function flatten(body) {
  const system = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : '';
  const parts = [];
  for (const m of body.messages || []) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('\n') : '';
    parts.push(`${(m.role || 'user').toUpperCase()}: ${text}`);
  }
  return { system, prompt: parts.join('\n\n') };
}

// A caller may enable Claude Code's OWN web tools for one request via the header
// `x-gateway-tools: WebSearch,WebFetch`. Only those two names are honoured; anything else is dropped.
const GATEWAY_TOOL_ALLOWLIST = new Set(['WebSearch', 'WebFetch']);
function parseGatewayTools(hdr) {
  return String(hdr || '').split(',').map(s => s.trim()).filter(s => GATEWAY_TOOL_ALLOWLIST.has(s));
}
// Isolation flags for every `claude -p` the gateway runs: see L.isolationFlags. --strict-mcp-config is
// required, so without it the gateway refuses to start.
const ISOLATION = L.isolationFlags(CLAUDE);
if (!ISOLATION) {
  log(`refusing to start: ${CLAUDE} --help does not list --strict-mcp-config, so gateway callers could reach your MCP servers. Update Claude Code.`);
  process.exit(78);
}

async function cliOnce(acct, model, system, prompt, tools) {
  const env = { ...process.env };
  if (acct.default) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = acct.configDir;
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.CLAUDECODE; delete env.CLAUDE_USAGE_GATEWAY_KEY;
  // Prefer the account's 1-year inference token: it never rotates, so a refresh cannot wipe it and it
  // keeps working after the OAuth login expires.
  const inf = L.inferenceToken(acct.id);
  if (inf) env.CLAUDE_CODE_OAUTH_TOKEN = inf; else delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // `claude -p` is an AGENT with a shell. A caller's prompt must never be able to make it touch this
  // machine: no tools at all, no session written to disk, and a cwd with nothing in it so no CLAUDE.md
  // or project context loads. NOT `--bare`: bare mode does not read CLAUDE_CODE_OAUTH_TOKEN or the
  // account's login, so every call fails "Not logged in".
  const toolList = Array.isArray(tools) && tools.length ? tools.join(',') : '';
  const args = ['-p', '--output-format', 'json', '--model', model, '--tools', toolList, '--no-session-persistence', ...ISOLATION];
  if (toolList) args.push('--allowedTools', toolList);
  if (system) args.push('--system-prompt', system);
  try {
    const { stdout } = await runClaude(args, env, prompt);
    let parsed; try { parsed = JSON.parse(stdout); } catch { parsed = { result: stdout.trim(), is_error: false }; }
    const text = String(parsed.result ?? parsed.text ?? '');
    if (parsed.is_error && LIMIT_RE.test(text)) { benched.set(acct.id, Date.now() + CLI_BENCH_MS); return { retry: '429-cli on ' + acct.id }; }
    if (parsed.is_error && LOGIN_RE.test(text)) { benched.set(acct.id, Date.now() + LOGIN_BENCH_MS); log(`login error on ${acct.id}: ${text.slice(0, 120)}`); return { retry: 'login error on ' + acct.id }; }
    if (parsed.is_error) throw Object.assign(new Error('claude -p error on ' + acct.id + ': ' + text.slice(0, 300)), { final: true });
    const u = parsed.usage || {};
    return {
      account: acct.id,
      text: JSON.stringify({
        id: parsed.session_id ? 'msg_gw_' + parsed.session_id : 'msg_gw_' + Date.now().toString(36),
        type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
                 cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
                 cache_read_input_tokens: u.cache_read_input_tokens || 0 },
        _gateway: { account: acct.id, path: 'cli', served_model: model, duration_api_ms: parsed.duration_api_ms || null },
      }),
      status: 200,
    };
  } catch (e) {
    if (e.final) throw e;
    // A non-zero exit usually still carries the real reason in stdout as the
    // JSON `result` ("Not logged in", "does not support this model", ...).
    let fromStdout = '';
    try { const p = JSON.parse(String(e.stdout || '')); fromStdout = String(p.result || ''); } catch (_) {}
    const detail = fromStdout || (e.stderr && String(e.stderr)) || e.message || '';
    if (LIMIT_RE.test(detail)) { benched.set(acct.id, Date.now() + CLI_BENCH_MS); return { retry: '429-cli on ' + acct.id }; }
    if (LOGIN_RE.test(detail)) { benched.set(acct.id, Date.now() + LOGIN_BENCH_MS); log(`login error on ${acct.id}: ${detail.slice(0, 120)}`); return { retry: 'login error on ' + acct.id }; }
    if (e.killed || /ETIMEDOUT|timed out/i.test(detail)) throw new Error(`claude -p timed out after ${CLI_TIMEOUT_MS}ms on ${acct.id}`);
    throw new Error(`claude -p failed on ${acct.id}: ${detail.slice(0, 300)}`);
  }
}

async function handleCli(body, tools, noUpgrade) {
  const { system, prompt } = flatten(body);
  const model = body.model;
  let lastErr = null;
  for (let pass = 0; pass < 2; pass++) {
    const order = await pickOrder(body.model);
    if (!order.length) break;
    for (const acct of order) {
      const r = await cliOnce(acct, servedModel(model, noUpgrade), system, prompt, tools);
      if (r.retry) { lastErr = r.retry; continue; }
      return r;
    }
  }
  const e = new Error('all accounts exhausted for claude -p' + (lastErr ? ': ' + lastErr : '')); e.code = 503; throw e;
}

// --- token lease ------------------------------------------------------------
// GET /v1/lease?caller=<name>[&model=<id>] hands a pooled caller (contrib/claude-pooled) the account the
// picker would use RIGHT NOW plus that account's token. Same pickOrder() as /v1/messages. Prefers the
// account's 1-year inference token; falls back to the live login token, which expires within hours.
// The token is returned in the body only; the log line names caller and account, never the token.
async function lease(u) {
  const caller = String(u.searchParams.get('caller') || 'unknown').replace(/[^\w.@-]/g, '').slice(0, 64) || 'unknown';
  const model = u.searchParams.get('model') || OPUS_MODEL;
  const order = await pickOrder(model);
  for (const acct of order) {
    const inf = L.inferenceToken(acct.id);
    const token = inf || tokenFor(acct);
    if (!token) continue;
    log(`lease caller=${caller} acct=${acct.id} model=${model} candidates=${order.length} source=${inf ? 'inference-token' : 'login'}`);
    return {
      account: acct.id, token, source: inf ? 'inference-token' : 'login', model,
      // When this account's 5-hour window resets; a caller holding the lease longer should re-lease.
      expires_hint: (acct.fiveHour && acct.fiveHour.resetsAt) || null,
      five_hour_pct: acct.eff5 ?? null, seven_day_pct: acct.eff7 ?? null,
    };
  }
  const e = new Error('no account with headroom'); e.code = 503; throw e;
}

// --- fallback providers ---------------------------------------------------------------------
// Logs provider + model per call, never a key (providers.js scrubs keys out of upstream error text).
// toolUse: a tool_use request the cli path cannot serve. If no provider serves it either, it gets the cli
// path's 422 (with the providers' reasons) instead of a 503, except when a provider rejected its key.
async function viaProvider(res, body, why, t0, prior, toolUse) {
  try {
    const out = await P.complete(body, { log });
    res.setHeader('x-gateway-account', '');
    res.setHeader('x-gateway-path', why);
    res.setHeader('x-gateway-provider', out.provider);
    log(`ok model=${body.model} provider=${out.provider} served=${out.model} path=${why} status=200 ms=${Date.now() - t0}`);
    send(res, 200, out);
  } catch (e) {
    const code = e.code === 'auth' ? 502 : toolUse ? 422 : [400, 422, 503].includes(e.code) ? e.code : 502;
    const type = e.code === 'auth' ? 'authentication_error' : code === 503 ? 'overloaded_error' : code === 502 ? 'api_error' : 'invalid_request_error';
    const message = (toolUse && e.code !== 'auth' ? `tool_use is not served by this gateway for ${body.model} (${prior}); ` : prior ? `${prior}; ` : '') + e.message;
    log(`FAIL model=${body.model} path=${why} code=${code}: ${message}`);
    send(res, code, { error: { type, message } });
  }
}

function send(res, code, obj, raw) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(raw != null ? raw : JSON.stringify(obj));
}
const DENY = { error: { type: 'authentication_error', message: 'bad gateway key' } };

// Same DNS-rebinding guard as the dashboard: answer only requests addressed to a loopback name on this
// port, or to a name listed in CLAUDE_USAGE_GATEWAY_ALLOWED_HOSTS (comma-separated, for a gateway bound
// to another address). A browser request from any other origin is refused before the key is checked.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EXTRA_HOSTS = new Set(String(process.env.CLAUDE_USAGE_GATEWAY_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
function hostAllowed(hostname, port) {
  hostname = hostname.toLowerCase();
  if (LOOPBACK.has(hostname)) return port === PORT;
  return EXTRA_HOSTS.has(hostname) || EXTRA_HOSTS.has(`${hostname}:${port}`);
}
function requestAllowed(req) {
  const m = String(req.headers.host || '').match(/^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/);
  if (!m || !hostAllowed(m[1], Number(m[2] || 80))) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (!req.headers.origin) return true;
  try { const o = new URL(req.headers.origin); return hostAllowed(o.hostname, Number(o.port || 80)); } catch (_) { return false; }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!requestAllowed(req)) return send(res, 403, { error: { type: 'permission_error', message: 'unexpected Host or Origin' } });
  if (u.pathname.endsWith('/healthz')) return send(res, 200, { ok: true, benched: [...benched].filter(([, t]) => t > Date.now()).map(([key]) => key) });
  if (req.method === 'GET' && u.pathname.endsWith('/lease')) {
    if (!keyOk(req)) return send(res, 401, DENY);
    return lease(u).then(out => send(res, 200, out)).catch(e => {
      const code = e.code === 503 ? 503 : 502;
      log(`FAIL lease code=${code}: ${e.message}`);
      send(res, code, { error: { type: code === 503 ? 'overloaded_error' : 'api_error', message: e.message } });
    });
  }
  if (req.method !== 'POST' || !u.pathname.endsWith('/messages')) return send(res, 404, { error: 'not found' });
  if (!keyOk(req)) return send(res, 401, DENY);
  let raw = '';
  req.on('data', d => { raw += d; if (raw.length > 32 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { error: { type: 'invalid_request_error', message: 'bad json' } }); }
    if (body.stream) return send(res, 400, { error: { type: 'invalid_request_error', message: 'streaming not supported by gateway' } });
    if (P.prefixOf(body.model)) return viaProvider(res, body, 'provider', Date.now());
    try {
      const viaCli = !(DIRECT_HAIKU && DIRECT_OK_RE.test(String(body.model || '')));
      // `claude -p` cannot return a tool_use block, so a tool-using request on the cli path would burn
      // a long run for prose the caller then rejects. Fail fast with 422 (NOT 503, which a caller's
      // circuit breaker would read as "gateway down") so the caller can escalate to the API. When every
      // account is out of headroom and fallback is on, the providers get it first: only the Anthropic API
      // key can serve tools, and if nothing serves it the answer is still the 422.
      if (viaCli && ((Array.isArray(body.tools) && body.tools.length) || body.tool_choice)) {
        if (req.headers['x-rotator-no-fallback'] !== '1' && P.config().enabled && !(await pickOrder(body.model)).length) {
          log(`tool_use with every account exhausted for model=${body.model}; trying fallback providers`);
          return viaProvider(res, body, 'fallback', Date.now(), 'every account exhausted', true);
        }
        log(`REJECT model=${body.model} tool_use on the cli path -> 422`);
        return send(res, 422, { error: { type: 'invalid_request_error', message: `tool_use is not served by this gateway for ${body.model}; use the API` } });
      }
      const t0 = Date.now();
      const gwTools = viaCli ? parseGatewayTools(req.headers['x-gateway-tools']) : [];
      if (gwTools.length) log(`tools=${gwTools.join(',')} model=${body.model}`);
      const noUpgrade = req.headers['x-gateway-no-upgrade'] === '1';
      const out = viaCli ? await handleCli(body, gwTools, noUpgrade) : await handle(body);
      res.setHeader('x-gateway-account', out.account || '');
      res.setHeader('x-gateway-path', viaCli ? 'cli' : 'direct');
      log(`ok model=${body.model}${viaCli && servedModel(body.model, noUpgrade) !== body.model ? ' served=' + servedModel(body.model, noUpgrade) : ''} acct=${out.account} path=${viaCli ? 'cli' : 'direct'} status=${out.status} bytes=${out.text.length} ms=${Date.now() - t0}`);
      send(res, out.status, null, out.text);
    } catch (e) {
      // Every account benched or capped: hand the request to the paid providers, unless turned off.
      if (e.code === 503 && req.headers['x-rotator-no-fallback'] !== '1' && P.config().enabled) {
        log(`accounts exhausted for model=${body.model} (${e.message}); trying fallback providers`);
        return viaProvider(res, body, 'fallback', Date.now(), e.message);
      }
      const code = e.code === 503 ? 503 : 502;
      log(`FAIL model=${body && body.model} code=${code}: ${e.message}`);
      send(res, code, { error: { type: code === 503 ? 'overloaded_error' : 'api_error', message: e.message } });
    }
  });
});
server.listen(PORT, HOST, () => log(`claude-rotator gateway on http://${HOST}:${PORT} (auth on; direct Haiku route ${DIRECT_HAIKU ? 'ON' : 'off'}; Sonnet->Opus upgrade ${UPGRADE_SONNET_TO_OPUS ? 'on' : 'off'}; claude -p isolation: ${ISOLATION.map(f => f || '""').join(' ')})`));
