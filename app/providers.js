'use strict';
/*
 * Fallback providers: paid API keys the rotator uses when every subscription account is capped.
 *
 *   fireworks   OpenAI-style chat completions, latest Kimi, reasoning off (reasoning_effort: none)
 *   openrouter  OpenAI-style chat completions, latest Kimi, reasoning off, Moonshot's own hosting ignored
 *   anthropic   the Messages API with an API key (the sanctioned path), tried last
 *
 * Keys live in $CLAUDE_USAGE_DATA/secrets/providers.json (0600): { "fireworks": { "apiKey": "..." }, ... }.
 * Settings without secrets live in accounts.json under "fallback" (order, per-provider model, on/off).
 * A provider with no key is skipped. A 429, 5xx, timeout or network error moves on to the next provider;
 * a 401/403 stops the chain, because the next call would bill a different account for a config mistake.
 * Every call is billed by the provider. Nothing here ever returns, logs or throws a key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const KEYS_FILE = path.join(L.DATA, 'secrets', 'providers.json');
const TIMEOUT_MS = Number(process.env.CLAUDE_USAGE_PROVIDER_TIMEOUT_MS || 120000);

const PROVIDERS = {
  fireworks: {
    label: 'Fireworks', shape: 'openai', prefix: 'fireworks:',
    url: process.env.CLAUDE_USAGE_FIREWORKS_URL || 'https://api.fireworks.ai/inference/v1/chat/completions',
    model: 'accounts/fireworks/models/kimi-k3',
    // Fireworks rejects OpenRouter's `reasoning` field outright; this is its spelling of "no thinking".
    extra: () => ({ reasoning_effort: 'none' }),
  },
  openrouter: {
    label: 'OpenRouter', shape: 'openai', prefix: 'openrouter:',
    url: process.env.CLAUDE_USAGE_OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions',
    model: 'moonshotai/kimi-k3',
    extra: () => ({ reasoning: { enabled: false }, provider: { ignore: ['Moonshot AI'] } }),
    headers: { 'X-Title': 'claude-rotator' },
  },
  anthropic: {
    label: 'Anthropic API', shape: 'anthropic', prefix: 'anthropic-api:',
    url: process.env.CLAUDE_USAGE_ANTHROPIC_API_URL || L.API_BASE + '/v1/messages',
    model: 'claude-sonnet-5-5',
  },
};
const NAMES = Object.keys(PROVIDERS);
const DEFAULTS = { enabled: true, order: [...NAMES], models: Object.fromEntries(NAMES.map(n => [n, PROVIDERS[n].model])) };

// --- settings and keys -------------------------------------------------------------------------
function config() {
  let fb = {};
  try { fb = L.loadConfig().fallback || {}; } catch (_) {}
  const order = Array.isArray(fb.order) ? fb.order.filter(n => PROVIDERS[n]) : DEFAULTS.order;
  return { enabled: fb.enabled !== false, order: [...new Set(order)], models: { ...DEFAULTS.models, ...(fb.models || {}) } };
}

function readKeys() {
  try { const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; }
}
function keyFor(name) { const k = readKeys()[name]; return k && typeof k.apiKey === 'string' && k.apiKey ? k.apiKey : null; }

// Atomic, 0600 from the first byte: the temp file is created with that mode, then renamed over the old one.
function writeJson600(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch (_) {}
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, JSON.stringify(obj, null, 2) + '\n'); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function checkName(name) {
  if (!PROVIDERS[name]) throw Object.assign(new Error(`unknown provider "${name}" (known: ${NAMES.join(', ')})`), { code: 400 });
}

function setKey(name, apiKey) {
  checkName(name);
  const k = String(apiKey == null ? '' : apiKey).trim();
  if (k.length < 8 || k.length > 512 || /\s/.test(k)) throw Object.assign(new Error('apiKey must be 8 to 512 characters with no spaces'), { code: 400 });
  const keys = readKeys();
  keys[name] = { apiKey: k };
  writeJson600(KEYS_FILE, keys);
}

function removeKey(name) {
  checkName(name);
  const keys = readKeys();
  delete keys[name];
  writeJson600(KEYS_FILE, keys);
}

function list() {
  const cfg = config(), keys = readKeys();
  return NAMES.map(name => {
    const k = keys[name] && keys[name].apiKey;
    return {
      name, label: PROVIDERS[name].label, configured: !!k,
      keyHint: k ? '…' + String(k).slice(-4) : null,
      model: cfg.models[name], enabled: cfg.enabled && cfg.order.includes(name),
    };
  });
}

// POST /api/fallback body: { enabled?, order?, models? }. Written into accounts.json, the rest of the file kept.
const MODEL_RE = /^[\w.\/:@-]{1,200}$/;
function setFallback(patch) {
  patch = patch || {};
  const cur = config(), next = { ...cur, models: { ...cur.models } };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false'), { code: 400 });
    next.enabled = patch.enabled;
  }
  if (patch.order !== undefined) {
    if (!Array.isArray(patch.order) || patch.order.some(n => !PROVIDERS[n]) || new Set(patch.order).size !== patch.order.length)
      throw Object.assign(new Error(`order must list distinct providers from: ${NAMES.join(', ')}`), { code: 400 });
    next.order = patch.order;
  }
  if (patch.models !== undefined) {
    if (!patch.models || typeof patch.models !== 'object') throw Object.assign(new Error('models must be an object'), { code: 400 });
    for (const [n, m] of Object.entries(patch.models)) {
      checkName(n);
      if (typeof m !== 'string' || !MODEL_RE.test(m)) throw Object.assign(new Error(`model for ${n} is not a valid slug`), { code: 400 });
      next.models[n] = m;
    }
  }
  const raw = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  raw.fallback = next;
  const tmp = L.CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, L.CONFIG_PATH);
  return next;
}

// --- translation -------------------------------------------------------------------------------
// Anthropic Messages -> OpenAI chat completions. Text only: a request with tools, images or documents
// cannot be translated faithfully, so the OpenAI-style providers decline it (the Anthropic one takes it).
function blocksText(content, where) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (typeof b === 'string') out.push(b);
    else if (b && b.type === 'text') out.push(String(b.text || ''));
    else if (b && (b.type === 'thinking' || b.type === 'redacted_thinking')) continue; // history from a Claude reply
    else throw Object.assign(new Error(`${b && b.type} content in ${where} is not translated for OpenAI-style providers`), { unsupported: true });
  }
  return out.join('\n');
}

function toOpenAI(body, name, model) {
  if ((Array.isArray(body.tools) && body.tools.length) || body.tool_choice)
    throw Object.assign(new Error('tool_use is not translated for OpenAI-style providers'), { unsupported: true });
  const messages = [];
  const system = blocksText(body.system, 'system');
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages || []) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocksText(m.content, m.role + ' message') });
  const out = { model, messages, max_tokens: body.max_tokens || 1024, stream: false };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences.slice(0, 4);
  return { ...out, ...PROVIDERS[name].extra() };
}

// Kimi answers with reasoning off, but a host can still put thinking inline; it never reaches the caller.
function stripReasoning(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/^\s*<think>[\s\S]*$/, '')
    .replace(/◁think▷[\s\S]*?◁\/think▷\s*/g, '');
}

const FINISH = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'tool_use', function_call: 'tool_use' };
function fromOpenAI(j, name, model) {
  const ch = (j.choices || [])[0] || {};
  const msg = ch.message || {};
  const raw = Array.isArray(msg.content) ? msg.content.map(p => (p && p.text) || '').join('') : msg.content;
  const text = stripReasoning(raw);
  const u = j.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    id: 'msg_' + name + '_' + crypto.randomBytes(8).toString('hex'),
    type: 'message', role: 'assistant', model: j.model || model,
    content: [{ type: 'text', text }],
    stop_reason: FINISH[ch.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached), output_tokens: u.completion_tokens || 0,
             cache_creation_input_tokens: 0, cache_read_input_tokens: cached },
    provider: name,
  };
}

// The Claude 5 family refuses a non-default temperature, top_p or top_k, so those are dropped there.
function toAnthropic(body, model) {
  const out = { ...body, model, stream: false };
  if (/^claude-[a-z]+-5/.test(model)) { delete out.temperature; delete out.top_p; delete out.top_k; }
  return out;
}
function fromAnthropic(j, name) {
  return { ...j, content: (j.content || []).filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking'), provider: name };
}

// --- calls -------------------------------------------------------------------------------------
// An upstream error body can echo part of the key ("Incorrect API key provided: sk-ab...yz").
function scrub(text, key) {
  let t = String(text || '');
  if (key) t = t.split(key).join('[key]');
  return t.replace(/\b(sk-[\w-]{4,}|fw_[\w-]{4,}|sk_[\w-]{4,})[\w*.-]*/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]').slice(0, 300);
}

function modelFor(name, body, cfg, forced) {
  if (forced) return forced;
  if (name === 'anthropic' && /^claude-/.test(String(body.model || ''))) return body.model; // same model, metered
  return cfg.models[name];
}

// One call to one provider. Returns { res } on success or { fail: { kind, status?, message } } where kind is
// 'next' (try the next provider), 'auth' (stop the chain), 'skip' (no key or request not translatable).
async function callOne(name, body, model) {
  const p = PROVIDERS[name];
  const key = keyFor(name);
  if (!key) return { fail: { kind: 'skip', message: 'no API key' } };
  let payload;
  try { payload = p.shape === 'openai' ? toOpenAI(body, name, model) : toAnthropic(body, model); }
  catch (e) { if (e.unsupported) return { fail: { kind: 'skip', message: e.message } }; throw e; }
  const headers = p.shape === 'openai'
    ? { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(p.headers || {}) }
    : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  let r, text;
  try {
    r = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await r.text();
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return { fail: { kind: 'next', message: timedOut ? `timed out after ${TIMEOUT_MS}ms` : scrub(e.cause && e.cause.code || e.message, key) } };
  }
  if (r.status === 401 || r.status === 403)
    return { fail: { kind: 'auth', status: r.status, message: `${p.label} rejected the API key (HTTP ${r.status}): ${scrub(text, key)}` } };
  if (r.status < 200 || r.status >= 300) return { fail: { kind: 'next', status: r.status, message: `HTTP ${r.status}: ${scrub(text, key)}` } };
  let j;
  try { j = JSON.parse(text); } catch (_) { return { fail: { kind: 'next', status: r.status, message: 'reply is not JSON' } }; }
  if (j.error) return { fail: { kind: 'next', status: r.status, message: scrub(JSON.stringify(j.error), key) } };
  const res = p.shape === 'openai' ? fromOpenAI(j, name, model) : fromAnthropic(j, name);
  if (res.stop_reason === 'end_turn' && !res.content.some(b => b.type !== 'text' || b.text)) return { fail: { kind: 'next', message: 'empty reply' } };
  return { res };
}

// "fireworks:<slug>", "openrouter:<slug>" or "anthropic-api:<slug>" names one provider (empty slug = its configured model).
function prefixOf(model) {
  const m = String(model || '');
  for (const name of NAMES) if (m.startsWith(PROVIDERS[name].prefix)) return { name, model: m.slice(PROVIDERS[name].prefix.length) || null };
  return null;
}

// Takes an Anthropic Messages request, returns an Anthropic Messages response with `model` = the provider's
// model and a top-level `provider`. opts.log(line) gets one line per failed attempt (provider, model, reason).
// Throws on total failure: e.code 503 when every provider was skipped or transiently failed, e.code 'auth'
// when a provider refused its key, e.code 400 for a prefixed model whose provider has no key, 422 when the
// prefixed provider cannot take the request (tools on an OpenAI-style provider). e.attempts lists each try.
async function complete(request, opts = {}) {
  const log = opts.log || (() => {});
  const cfg = config();
  const pfx = prefixOf(request.model);
  const chain = pfx ? [pfx.name] : cfg.order;
  const attempts = [];
  for (const name of chain) {
    const model = modelFor(name, request, cfg, pfx && pfx.model);
    const t0 = Date.now();
    const { res, fail } = await callOne(name, request, model);
    if (res) return res;
    attempts.push({ provider: name, model, ...fail });
    if (fail.kind !== 'skip') log(`fallback provider=${name} model=${model} ${fail.status ? 'status=' + fail.status + ' ' : ''}ms=${Date.now() - t0} -> ${fail.kind === 'auth' ? 'stop' : 'next'}: ${fail.message}`);
    if (fail.kind === 'auth') {
      const e = new Error(fail.message); e.code = 'auth'; e.provider = name; e.attempts = attempts; throw e;
    }
    if (pfx && fail.kind === 'skip') {
      const e = new Error(fail.message === 'no API key' ? `${PROVIDERS[name].label} has no API key; add one in the dashboard Setup view` : fail.message);
      e.code = fail.message === 'no API key' ? 400 : 422; e.provider = name; e.attempts = attempts; throw e;
    }
  }
  const tried = attempts.filter(a => a.kind !== 'skip');
  const e = new Error(tried.length
    ? 'every fallback provider failed: ' + attempts.map(a => `${a.provider} ${a.message}`).join('; ')
    : 'no fallback provider has an API key (add one in the dashboard Setup view)');
  e.code = 503; e.attempts = attempts; e.noProviders = !tried.length; throw e;
}

// One tiny real call, billed. { ok, ms, model, error? }; model = what the provider says served it.
async function test(name) {
  checkName(name);
  const cfg = config(), model = cfg.models[name], t0 = Date.now();
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] };
  try {
    const { res, fail } = await callOne(name, body, model);
    if (res) return { ok: true, ms: Date.now() - t0, model: res.model, reply: String((res.content[0] || {}).text || '').slice(0, 40) };
    return { ok: false, ms: Date.now() - t0, model, error: fail.message };
  } catch (e) { return { ok: false, ms: Date.now() - t0, model, error: scrub(e.message, keyFor(name)) }; }
}

module.exports = { NAMES, PROVIDERS, DEFAULTS, KEYS_FILE, config, list, setKey, removeKey, setFallback, test, complete, prefixOf, toOpenAI, fromOpenAI, stripReasoning };
