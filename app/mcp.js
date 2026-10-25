'use strict';
/*
 * stdio MCP server for claude-rotator, started by `ccr mcp`. Zero dependencies: newline-delimited
 * JSON-RPC 2.0 on stdin/stdout. Register it once:  claude mcp add --scope user claude-rotator -- ccr mcp
 *
 * Tools:
 *   rotator_status     every account's 5-hour, 7-day and per-model usage, and which account to use next
 *   rotator_ask        run one prompt on the best account (the local gateway when it runs, else `ccr run -p`)
 *   rotator_providers  the fallback API providers from app/providers.js, read-only
 *
 * Protocol: dual-era, per the MCP spec. A request whose params._meta names a protocol version is served
 * statelessly under that version (2026-07-28: server/discover, resultType on every result). An
 * `initialize` request selects the handshake-based revisions (2025-11-25 and earlier). Claude Code 2.1.x
 * probes with server/discover first and falls back to initialize when a server does not answer it.
 *
 * stdout carries MCP messages only. Logs, and anything a required module prints, go to stderr. No tool
 * result ever carries a token or key: results are built from allow-listed fields, then every known
 * secret value from DATA/secrets and anything shaped like a token is redacted.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Before anything else loads: console.log from any module must not corrupt the JSON-RPC stream.
for (const k of ['log', 'info', 'debug']) console[k] = (...a) => console.error(...a);
const L = require('./lib');

const APP = __dirname;
const SERVER_INFO = { name: 'claude-rotator', title: 'claude-rotator', version: '2.0.0' };
const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const DEFAULT_MODEL = process.env.CLAUDE_ROTATOR_MCP_MODEL || 'claude-sonnet-5-5';
const ASK_TIMEOUT_MS = Number(process.env.CLAUDE_ROTATOR_MCP_TIMEOUT_MS || 600000);
const MAX_LINE = 8 * 1024 * 1024;
const INSTRUCTIONS = 'claude-rotator spreads Claude Code work over several Claude subscriptions on this machine. '
  + 'Call rotator_status to see each account\'s usage left and which one is next; rotator_ask to run one prompt '
  + 'on that account (it uses subscription quota); rotator_providers to see which API fallbacks are set up.';

function log(...a) { process.stderr.write(`${new Date().toISOString()} mcp: ${a.join(' ')}\n`); }
// AbortSignal.any is Node 20+; this works on 18 too. Aborts on the caller's signal or after ms.
function within(signal, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  t.unref();
  if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true });
  ac.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ac.signal;
}

// --- secrets: never in a result -------------------------------------------------------------------------
const SECRETS = path.join(L.DATA, 'secrets');
const GATEWAY_ENV = process.env.CLAUDE_USAGE_GATEWAY_ENV || path.join(SECRETS, 'gateway.env');

function readEnvFile(p) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// Every secret value this install holds, re-read per result so a key added later is covered too.
function knownSecrets() {
  const vals = [];
  const add = v => { if (typeof v === 'string' && v.length >= 8) vals.push(v); };
  const json = f => { try { return JSON.parse(fs.readFileSync(path.join(SECRETS, f), 'utf8')); } catch (_) { return null; } };
  for (const [k, v] of Object.entries({ ...readEnvFile(GATEWAY_ENV), ...process.env })) if (/KEY|TOKEN|SECRET/.test(k)) add(v);
  for (const v of Object.values(json('inference-tokens.json') || {})) add(v);
  for (const p of Object.values(json('providers.json') || {})) add(p && p.apiKey);
  try { add(fs.readFileSync(path.join(SECRETS, 'ui-token'), 'utf8').trim()); } catch (_) {}
  return vals.sort((a, b) => b.length - a.length);
}
const TOKEN_RES = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /sk-or-[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bfw_[A-Za-z0-9]{12,}/g, /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, /\b[a-f0-9]{48,}\b/gi];
function redact(s, secrets) {
  let out = String(s);
  for (const v of secrets) out = out.split(v).join('[redacted]');
  for (const re of TOKEN_RES) out = out.replace(re, '[redacted]');
  return out;
}

// --- rotator_status -------------------------------------------------------------------------------------
function dashPort() {
  try { return JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8')).port || 7788; } catch (_) { return 7788; }
}

// The dashboard's view; when it is down, the same one-shot poll `ccr ls` falls back to.
async function readState(signal) {
  try {
    const r = await fetch(`http://127.0.0.1:${dashPort()}/api/state`, { signal: within(signal, 4000) });
    if (r.ok) return { source: 'dashboard', view: await r.json() };
  } catch (_) { if (signal.aborted) throw new Error('cancelled'); }
  const { stdout } = await run(process.execPath, [path.join(APP, 'poll-once.js')], { signal, timeoutMs: 90000 });
  return { source: 'poll-once', view: JSON.parse(stdout) };
}

// Same filter and order as ccr-helper.js candidates(), so "use next" agrees with `ccr ls` and `ccr run`.
function useNext(v) {
  return (v.accounts || []).find(a => !a.remote && a.configDir && a.ok !== false && (a.drainTier ?? 0) < 2
    && a.headroom != null && !a.locked && a.eff5 < 100 && (a.eff7 ?? 0) < 100) || null;
}

const left = p => p == null ? null : Math.max(0, Math.round(100 - p));
function windowOf(w, eff) { return { usedPct: eff == null ? null : Math.round(eff), leftPct: left(eff), resetsAt: w?.resetsAt || null }; }

async function rotatorStatus(_args, signal) {
  const { source, view } = await readState(signal);
  const next = useNext(view);
  const accounts = (view.accounts || []).map(a => ({
    id: String(a.id), label: a.label || a.id, email: a.email || null,
    useNext: !!(next && a.id === next.id),
    remote: !!a.remote, loggedIn: !a.needsLogin, ok: a.ok !== false, locked: !!a.locked,
    lastResort: !!a.lastResort, activeSession: !!a.activeSession, stale: !!a.stale,
    fiveHour: windowOf(a.fiveHour, a.eff5),
    sevenDay: windowOf(a.sevenDay, a.eff7),
    modelCaps: Object.entries(a.models || {}).map(([k, m]) => ({ model: m.name || k, ...windowOf(m, a.effModels?.[k]) })),
    headroomPct: a.headroom == null ? null : Math.round(a.headroom),
    error: a.ok === false && a.error ? String(a.error).slice(0, 160) : null,
  }));
  const data = { source, pollAgeSec: view.pollAgeSec ?? null, useNext: next ? next.id : null, accounts };
  const pct = w => w.leftPct == null ? '-' : `${w.leftPct}% left` + (w.resetsAt ? ` (resets ${w.resetsAt})` : '');
  const lines = [`use next: ${data.useNext || 'none (no account has headroom)'}`,
    `source: ${source === 'dashboard' ? `dashboard, polled ${data.pollAgeSec ?? '?'}s ago` : 'one-shot poll (the dashboard is not running)'}`];
  for (const a of accounts) {
    const notes = [a.useNext && 'USE NEXT', !a.loggedIn && 'NOT LOGGED IN', a.locked && 'LOCKED', a.lastResort && 'last resort',
      a.activeSession && 'active', a.stale && 'stale', a.remote && 'remote', a.error && `error: ${a.error}`].filter(Boolean);
    lines.push(`- ${a.id}${a.label !== a.id ? ` (${a.label})` : ''}${a.email ? ` <${a.email}>` : ''}: 5h ${pct(a.fiveHour)}; 7d ${pct(a.sevenDay)}`
      + a.modelCaps.map(m => `; ${m.model} ${pct(m)}`).join('') + (notes.length ? ` [${notes.join(', ')}]` : ''));
  }
  return { text: lines.join('\n'), data };
}

// --- rotator_ask ----------------------------------------------------------------------------------------
function gatewayConfig() {
  const env = readEnvFile(GATEWAY_ENV);
  const key = process.env.CLAUDE_USAGE_GATEWAY_KEY || env.CLAUDE_USAGE_GATEWAY_KEY || '';
  if (Buffer.byteLength(key) < 32) return null;
  const port = Number(process.env.CLAUDE_USAGE_GATEWAY_PORT || env.CLAUDE_USAGE_GATEWAY_PORT || 7799);
  return { key, url: `http://127.0.0.1:${port}` };
}

async function gatewayUp(gw, signal) {
  try { return (await fetch(gw.url + '/healthz', { signal: within(signal, 2000) })).ok; } catch (_) { return false; }
}

const textOf = msg => (Array.isArray(msg.content) ? msg.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');

async function askGateway(gw, { prompt, model, system }, signal) {
  const body = { model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] };
  if (system) body.system = system;
  const r = await fetch(gw.url + '/v1/messages', {
    method: 'POST', body: JSON.stringify(body), signal: within(signal, ASK_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'x-gateway-key': gw.key },
  });
  let msg; try { msg = await r.json(); } catch (_) { msg = {}; }
  if (!r.ok) {
    const e = new Error(`gateway HTTP ${r.status}: ${msg.error?.message || msg.error || 'no detail'}`); e.tool = true; throw e;
  }
  // Contract 1: a provider fallback answer carries a top-level "provider"; an account answer names the account.
  const account = r.headers.get('x-gateway-account') || msg._gateway?.account || null;
  const servedBy = msg.provider ? { kind: 'provider', name: String(msg.provider) } : { kind: 'account', name: account };
  return { text: textOf(msg), servedBy, model: msg.model || model, via: 'gateway', stopReason: msg.stop_reason || null, usage: msg.usage || null };
}

// Same isolation the gateway gives its `claude -p` runs: no tools, no MCP servers (so no way back into this
// server), no settings files, hooks, CLAUDE.md or plugins, no session on disk, an empty cwd.
let isolation = null;
function isolationFlags() {
  if (!isolation) isolation = L.isolationFlags(process.env.CLAUDE_BIN || 'claude');
  return isolation;
}

function emptyCwd() {
  const d = path.join(L.STATE_DIR, 'cwd');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

async function askCcrRun({ prompt, model, system }, signal) {
  const iso = isolationFlags();
  if (!iso) { const e = new Error('this claude build has no --strict-mcp-config; update Claude Code'); e.tool = true; throw e; }
  const args = [path.join(APP, 'ccr'), 'run', '-p', '--output-format', 'json', '--model', model, '--tools', '',
    '--no-session-persistence', ...iso];
  if (system) args.push('--system-prompt', system);
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USAGE_GATEWAY_KEY',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  // The prompt goes in on stdin, so it never shows in `ps`.
  const r = await run('bash', args, { input: prompt, env, cwd: emptyCwd(), signal, timeoutMs: ASK_TIMEOUT_MS, okCodes: null });
  const accts = [...r.stderr.matchAll(/^ccr run: ([^\s]+)$/gm)].map(m => m[1]);
  let out = null; try { out = JSON.parse(r.stdout); } catch (_) {}
  if (r.code !== 0 || !out || out.is_error) {
    const why = (out && out.result) || r.stderr.split('\n').filter(l => l && !/^ccr run: [^\s]+$/.test(l)).slice(-3).join(' ') || `exit ${r.code}`;
    const e = new Error(`ccr run failed${accts.length ? ' on ' + accts.join(', then ') : ''}: ${String(why).slice(0, 400)}`); e.tool = true; throw e;
  }
  const models = Object.keys(out.modelUsage || {});
  return { text: String(out.result ?? ''), servedBy: { kind: 'account', name: accts[accts.length - 1] || null },
    model: models[0] || model, via: 'ccr run', stopReason: out.stop_reason || null, usage: out.usage || null };
}

async function rotatorAsk(args, signal) {
  const req = { prompt: args.prompt, model: args.model || DEFAULT_MODEL, system: args.system || '' };
  const gw = gatewayConfig();
  let out = null;
  if (gw && await gatewayUp(gw, signal)) {
    try { out = await askGateway(gw, req, signal); } catch (e) {
      // Only a gateway that went away gets a second try on `ccr run`; a timeout or an answer does not.
      if (e.tool || signal.aborted || !/ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET/.test(String(e.cause?.code || e.cause?.message))) {
        e.tool = true; e.message = `gateway: ${e.message}`; throw e;
      }
      log(`gateway went away (${e.cause.code || e.cause.message}), trying ccr run`);
    }
  }
  if (!out) out = await askCcrRun(req, signal);
  const who = out.servedBy.kind === 'provider' ? `provider ${out.servedBy.name}` : `account ${out.servedBy.name || 'unknown'}`;
  return { text: `${out.text}\n\n[served by ${who}, model ${out.model}, via ${out.via}]`, data: out };
}

// --- rotator_providers ----------------------------------------------------------------------------------
// app/providers.js (Contract 1) is optional: required lazily, so this server works without it.
async function rotatorProviders() {
  try { require.resolve('./providers'); } catch (_) {
    return { text: 'providers not installed (this claude-rotator has no app/providers.js)', data: { installed: false, fallback: null, providers: [] } };
  }
  const P = require('./providers'); // a broken providers.js is an error, not "not installed"
  const list = await P.list();
  const fb = typeof P.config === 'function' ? P.config() : null; // config() fills the defaults
  // Allow-listed fields only. keyHint is left out on purpose: no part of a key goes into a transcript.
  const providers = (Array.isArray(list) ? list : []).map(p => ({
    name: String(p.name), label: p.label || p.name, configured: !!p.configured, enabled: p.enabled !== false, model: p.model || null }));
  const fallback = fb ? { enabled: !!fb.enabled, order: Array.isArray(fb.order) ? fb.order.map(String) : [] } : null;
  const lines = [`fallback: ${fallback ? (fallback.enabled ? 'on' : 'off') + (fallback.order.length ? `, order ${fallback.order.join(' > ')}` : '') : 'not set'}`];
  for (const p of providers) lines.push(`- ${p.name}${p.label !== p.name ? ` (${p.label})` : ''}: ${p.configured ? 'key set' : 'no key'}, ${p.enabled ? 'enabled' : 'disabled'}, model ${p.model || '-'}`);
  if (!providers.length) lines.push('no providers listed');
  return { text: lines.join('\n'), data: { installed: true, fallback, providers } };
}

// --- tool table -----------------------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'rotator_status', title: 'Rotator: account usage',
    description: 'Show every Claude subscription account claude-rotator manages: 5-hour and 7-day usage left, per-model weekly caps, '
      + 'when each window resets, login problems, and which account is "use next". Reads the local dashboard, or polls once if it is down.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: rotatorStatus,
  },
  {
    name: 'rotator_ask', title: 'Rotator: run a prompt',
    description: 'Run one prompt headless on the account with the most headroom and return the answer, plus which account or fallback '
      + 'provider served it. Uses the local claude-rotator gateway when it runs (which can fall back to API providers), else `ccr run -p`. '
      + 'The run has no tools and no access to this machine. It spends subscription quota.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 400000, description: 'The user message to send.' },
        model: { type: 'string', pattern: '^[A-Za-z0-9._:/@-]{1,160}$', description: `Model id. Default ${DEFAULT_MODEL}. Gateway only: a fireworks:, openrouter: or anthropic-api: prefix goes straight to that provider.` },
        system: { type: 'string', maxLength: 100000, description: 'Optional system prompt.' },
      },
      required: ['prompt'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: rotatorAsk,
  },
  {
    name: 'rotator_providers', title: 'Rotator: fallback providers',
    description: 'List the API providers claude-rotator can fall back to when every subscription is out of headroom: whether each has a key, '
      + 'whether it is enabled, the model it uses, and the fallback order. Read-only; never shows a key.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: rotatorProviders,
  },
];
const publicTool = ({ run: _r, ...t }) => t;

// Checks arguments against the tool's inputSchema (the subset these schemas use). Returns a reason or null.
function badArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const k of Object.keys(args)) if (!schema.properties[k]) return `unknown argument "${k}"`;
  for (const k of schema.required || []) if (args[k] === undefined) return `missing required argument "${k}"`;
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = args[k];
    if (v === undefined) continue;
    if (typeof v !== p.type) return `"${k}" must be a ${p.type}`;
    if (p.minLength != null && v.trim().length < p.minLength) return `"${k}" must not be empty`;
    if (p.maxLength != null && v.length > p.maxLength) return `"${k}" is longer than ${p.maxLength} characters`;
    if (p.pattern && !new RegExp(p.pattern).test(v)) return `"${k}" has characters a model id cannot have`;
  }
  return null;
}

// --- child processes ------------------------------------------------------------------------------------
function run(cmd, args, { input = '', env = process.env, cwd, signal, timeoutMs, okCodes = [0] }) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', done = false;
    const kill = () => { try { process.kill(-ch.pid, 'SIGTERM'); } catch (_) { try { ch.kill('SIGTERM'); } catch (_) {} } };
    const timer = setTimeout(() => { kill(); finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    const onAbort = () => { kill(); finish(new Error('cancelled')); };
    signal.addEventListener('abort', onAbort, { once: true });
    children.add(kill);
    function finish(err, code) {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); children.delete(kill);
      if (err) { err.tool = true; return reject(err); }
      if (okCodes && !okCodes.includes(code)) {
        const e = new Error(`${path.basename(args[0] || cmd)} exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`); e.tool = true; return reject(e);
      }
      resolve({ code, stdout, stderr });
    }
    ch.stdout.on('data', d => { stdout += d; });
    ch.stderr.on('data', d => { stderr += d; });
    ch.on('error', e => finish(e));
    ch.on('close', code => finish(null, code));
    ch.stdin.on('error', () => {});
    ch.stdin.end(input);
  });
}
const children = new Set();

// --- JSON-RPC -------------------------------------------------------------------------------------------
const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, NO_METHOD: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, VERSION: -32022 };
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result, modern) { write({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result } : result }); }
function fail(id, code, message, data) { write({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }); }

const inflight = new Map(); // request id -> AbortController, for notifications/cancelled
let legacyVersion = null;   // set by initialize

async function callTool(id, params, modern) {
  const tool = TOOLS.find(t => t.name === params.name);
  if (!tool) return fail(id, ERR.INVALID_PARAMS, `Unknown tool: ${String(params.name).slice(0, 80)}`);
  const args = params.arguments === undefined ? {} : params.arguments;
  const why = badArgs(tool.inputSchema, args);
  if (why) return fail(id, ERR.INVALID_PARAMS, `Invalid arguments for ${tool.name}: ${why}`);
  const ac = new AbortController();
  inflight.set(id, ac);
  const t0 = Date.now();
  let out, isError = false;
  try { out = await tool.run(args, ac.signal); } catch (e) {
    isError = true; out = { text: `${tool.name} failed: ${e.message}`, data: null };
    if (!e.tool) log(`${tool.name} error: ${e.stack || e.message}`);
  }
  inflight.delete(id);
  if (ac.signal.aborted) return; // cancelled: the spec says send nothing more for this request
  log(`${tool.name} ${isError ? 'error' : 'ok'} ms=${Date.now() - t0}`);
  const secrets = knownSecrets();
  const result = { content: [{ type: 'text', text: redact(out.text, secrets) }], isError };
  if (out.data) result.structuredContent = JSON.parse(redact(JSON.stringify(out.data), secrets));
  reply(id, result, modern);
}

function handle(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, ERR.INVALID_REQUEST, 'Invalid Request: expected one JSON-RPC object (batches are not part of MCP)');
  const { id, method } = msg;
  const isNote = !('id' in msg);
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string' || (!isNote && (id === null || !['string', 'number'].includes(typeof id)))) {
    if (!isNote || typeof method !== 'string') return fail(isNote ? null : (['string', 'number'].includes(typeof id) ? id : null), ERR.INVALID_REQUEST, 'Invalid Request');
    return;
  }
  const params = msg.params === undefined ? {} : msg.params;
  if (isNote) {
    if (method === 'notifications/cancelled' && params && inflight.has(params.requestId)) inflight.get(params.requestId).abort();
    return; // notifications/initialized and every other notification need no answer
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return fail(id, ERR.INVALID_PARAMS, 'params must be an object');
  const ver = params._meta && params._meta[META_VERSION];
  const modern = ver !== undefined;
  if (modern && !MODERN.includes(ver)) return fail(id, ERR.VERSION, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested: ver });

  switch (method) {
    case 'server/discover':
      return reply(id, { supportedVersions: [...MODERN, ...LEGACY], capabilities: { tools: { listChanged: false } },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, instructions: INSTRUCTIONS }, true);
    case 'initialize': {
      const want = params.protocolVersion;
      legacyVersion = LEGACY.includes(want) ? want : LEGACY[0];
      log(`initialize: client ${params.clientInfo?.name || '?'} ${params.clientInfo?.version || ''} asked ${want}, using ${legacyVersion}`);
      return reply(id, { protocolVersion: legacyVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, false);
    }
    case 'ping': return reply(id, {}, modern);
    case 'tools/list': return reply(id, { tools: TOOLS.map(publicTool) }, modern);
    case 'tools/call':
      if (typeof params.name !== 'string') return fail(id, ERR.INVALID_PARAMS, 'tools/call needs a string "name"');
      return callTool(id, params, modern).catch(e => { log(`internal: ${e.stack || e.message}`); fail(id, ERR.INTERNAL, 'Internal error'); });
    default:
      return fail(id, ERR.NO_METHOD, `Method not found: ${method.slice(0, 80)}`);
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) { buf = ''; return fail(null, ERR.PARSE, 'Parse error: message too large'); }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { fail(null, ERR.PARSE, 'Parse error'); continue; }
      try { handle(msg); } catch (e) { log(`internal: ${e.stack || e.message}`); if (msg && msg.id != null) fail(msg.id, ERR.INTERNAL, 'Internal error'); }
    }
  });
  // stdin closed = the client is done: stop any running ask and exit.
  process.stdin.on('end', () => { for (const k of children) k(); process.exit(0); });
  process.stdout.on('error', () => { for (const k of children) k(); process.exit(0); });
  log(`claude-rotator MCP server ${SERVER_INFO.version} ready (data ${L.DATA})`);
}

if (require.main === module) main();
module.exports = { TOOLS, badArgs, redact, useNext };
