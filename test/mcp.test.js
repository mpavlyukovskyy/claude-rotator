'use strict';
// Drives app/mcp.js over stdio: the legacy handshake (initialize) and the stateless 2026-07-28 path
// (server/discover, per-request _meta), tools/list, each tool against a fake dashboard, a fake gateway and
// a fake claude, the poll-once fallback, cancellation, JSON-RPC errors for bad input, and that no token or
// key ever reaches stdout. Runs on a temp copy of app/ in a temp HOME; never calls Anthropic.
// Ports 18410-18413. Run: node test/mcp.test.js [app-dir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRC_APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const ROOT = process.env.MCP_TEST_TMP || os.tmpdir();
const T = fs.mkdtempSync(path.join(ROOT, 'ccr-mcp-test-'));
const DASH = 18410, GW = 18411, API = 18412, DEAD = 18413;
let fails = 0, passes = 0;
const check = (name, cond, extra) => { if (cond) { passes++; console.log('PASS ' + name); } else { fails++; console.log('FAIL ' + name + (extra ? ': ' + extra : '')); } };

// Secrets planted everywhere a careless result could pick them up.
const GW_KEY = 'a1'.repeat(32);
const LOGIN_TOKEN = 'sk-ant-oat01-LOGINTOKENxyzxyzxyzxyzxyzxyz';
const INF_TOKEN = 'sk-ant-oat01-INFERENCEtokenabcabcabcabcabc';
const PROVIDER_KEY = 'fw_PROVIDERKEY1234567890abcdef';
const UI_TOKEN = 'b2'.repeat(32);
const REFRESH = 'sk-ant-ort01-REFRESHtokenqqqqqqqqqqqqqqqq';
const SECRETS = [GW_KEY, LOGIN_TOKEN, INF_TOKEN, PROVIDER_KEY, UI_TOKEN, REFRESH];

// --- layout --------------------------------------------------------------------------------------------
const DATA = path.join(T, 'data');
const APP = path.join(DATA, 'app');
fs.mkdirSync(path.join(DATA, 'secrets'), { recursive: true, mode: 0o700 });
fs.cpSync(SRC_APP, APP, { recursive: true });
fs.rmSync(path.join(APP, 'providers.js'), { force: true }); // first runs: providers not installed
fs.mkdirSync(path.join(T, 'home', '.claude'), { recursive: true });
fs.mkdirSync(path.join(T, 'home', '.claude-accounts', 'two'), { recursive: true });
const HOME = path.join(T, 'home');
const writeCfg = port => fs.writeFileSync(path.join(DATA, 'accounts.json'), JSON.stringify({ port, accounts: [
  { id: 'main', label: 'main', configDir: '~/.claude', default: true },
  { id: 'two', label: 'two', configDir: '~/.claude-accounts/two' }] }));
writeCfg(DASH);
fs.writeFileSync(path.join(DATA, 'secrets', 'inference-tokens.json'), JSON.stringify({ two: INF_TOKEN }));
fs.writeFileSync(path.join(DATA, 'secrets', 'providers.json'), JSON.stringify({ fireworks: { apiKey: PROVIDER_KEY } }));
fs.writeFileSync(path.join(DATA, 'secrets', 'ui-token'), UI_TOKEN + '\n');
const GENV = path.join(DATA, 'secrets', 'gateway.env');
const gatewayOn = () => fs.writeFileSync(GENV, `CLAUDE_USAGE_GATEWAY_KEY=${GW_KEY}\nCLAUDE_USAGE_GATEWAY_PORT=${GW}\n`);
const gatewayOff = () => fs.rmSync(GENV, { force: true });

// Fake claude: --help lists the isolation flags; a -p run records its args, env and stdin, then answers
// with the token it was handed (a leak the server must redact).
const BIN = path.join(T, 'bin');
fs.mkdirSync(BIN);
// --help is over 16 KB with the isolation flags at the end, written by node and cut off by process.exit, as
// the real claude does. Read through a pipe, the text stops early (pipes are asynchronous in node on macOS)
// and --strict-mcp-config is never seen; read through a file, all of it arrives.
fs.writeFileSync(path.join(BIN, 'help.js'), `let s = 'Usage: claude [options] [command] [prompt]\\n';
for (let i = 0; s.length < 20000; i++) s += '  --filler-option-' + i + '  ' + 'x'.repeat(60) + '\\n';
process.stdout.write(s + '  --strict-mcp-config  x\\n  --restricted  x\\n  --safe-mode  x\\n');
process.exit(0);
`);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh
case "$1" in --help) exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(T, 'bin', 'help.js'))};; esac
input=$(cat)
{ printf 'ARGS:'; for a in "$@"; do printf '[%s]' "$a"; done; echo; echo "DIR:\${CLAUDE_CONFIG_DIR:-default}"; echo "STDIN:$input"; echo "CLAUDECODE:\${CLAUDECODE:-unset}"; } > "${T}/claude-call.txt"
printf '{"type":"result","is_error":false,"result":"cli says hi, token %s","modelUsage":{"claude-sonnet-5-5":{}}}\\n' "$CLAUDE_CODE_OAUTH_TOKEN"
`);
fs.chmodSync(path.join(BIN, 'claude'), 0o755);

// --- fake servers --------------------------------------------------------------------------------------
const future = new Date(Date.now() + 3 * 3600e3).toISOString();
const state = { generatedAt: new Date().toISOString(), pollAgeSec: 12, recommended: 'two', accounts: [
  // main is maxed out: never "use next". Its error carries a token and its record carries a fingerprint.
  { id: 'main', label: 'main', email: 'main@example.invalid', configDir: path.join(HOME, '.claude'), default: true, ok: true, drainTier: 2,
    eff5: 100, eff7: 40, headroom: 0, fiveHour: { pct: 100, resetsAt: future }, sevenDay: { pct: 40, resetsAt: future },
    models: { fable: { name: 'Fable', pct: 90, resetsAt: future } }, effModels: { fable: 90 },
    credFp: 'fp-should-not-show', token: LOGIN_TOKEN, refreshToken: REFRESH },
  { id: 'two', label: 'Two', email: 'two@example.invalid', configDir: path.join(HOME, '.claude-accounts', 'two'), ok: true, drainTier: 0,
    eff5: 20, eff7: 30, headroom: 70, fiveHour: { pct: 20, resetsAt: future }, sevenDay: { pct: 30, resetsAt: future }, models: {}, effModels: {} },
  { id: 'gone', label: 'gone', configDir: path.join(HOME, 'x'), ok: false, needsLogin: true, error: `HTTP 401 Bearer ${LOGIN_TOKEN}` }] };
const dash = http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(state)); }).listen(DASH, '127.0.0.1');

let gwSeen = [], gwMode = 'account';
const gw = http.createServer((q, s) => {
  if (q.url.endsWith('/healthz')) return s.end('{"ok":true}');
  let raw = ''; q.on('data', d => { raw += d; });
  q.on('end', () => {
    const body = JSON.parse(raw || '{}');
    gwSeen.push({ key: q.headers['x-gateway-key'], body });
    if (q.headers['x-gateway-key'] !== GW_KEY) { s.writeHead(401); return s.end('{"error":{"message":"bad gateway key"}}'); }
    if (gwMode === 'slow') return; // never answers: the cancel test
    if (gwMode === 'down') { s.writeHead(503); return s.end('{"error":{"type":"overloaded_error","message":"no account with headroom"}}'); }
    const provider = String(body.model).startsWith('fireworks:');
    if (!provider) s.setHeader('x-gateway-account', 'two');
    s.setHeader('content-type', 'application/json');
    s.end(JSON.stringify({ type: 'message', role: 'assistant', model: provider ? 'accounts/fireworks/models/kimi-k3' : body.model,
      ...(provider ? { provider: 'fireworks' } : { _gateway: { account: 'two', path: 'cli' } }),
      content: [{ type: 'text', text: `gateway says hi; the key is ${GW_KEY}` }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 5 } }));
  });
}).listen(GW, '127.0.0.1');

// Fake Anthropic for the poll-once fallback (usage + profile), on API.
const api = http.createServer((q, s) => {
  s.setHeader('content-type', 'application/json');
  if (q.url.startsWith('/api/oauth/usage')) return s.end(JSON.stringify({ five_hour: { utilization: 15, resets_at: future }, seven_day: { utilization: 25, resets_at: future } }));
  if (q.url.startsWith('/api/oauth/profile')) return s.end(JSON.stringify({ account: { email: 'main@example.invalid' } }));
  s.writeHead(404); s.end('{}');
}).listen(API, '127.0.0.1');
// poll-once reads main's login from <configDir>/.credentials.json (Keychain skipped).
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: LOGIN_TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 86400e3 } }));

// --- client --------------------------------------------------------------------------------------------
const allStdout = [];
function server() {
  const env = { PATH: `${BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME, USER: process.env.USER || 'u',
    CLAUDE_USAGE_DATA: DATA, CLAUDE_USAGE_CONFIG: path.join(DATA, 'accounts.json'), CLAUDE_USAGE_NO_KEYCHAIN: '1',
    CLAUDE_USAGE_API_BASE: `http://127.0.0.1:${API}`, CLAUDE_BIN: path.join(BIN, 'claude'), CLAUDECODE: '1', TMPDIR: T };
  const ch = spawn(process.execPath, [path.join(APP, 'mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(), lines = [];
  let buf = '', stderr = '';
  ch.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      allStdout.push(line); lines.push(line);
      let m; try { m = JSON.parse(line); } catch (_) { m = { notJson: line }; }
      const w = waiting.get(m.id === undefined ? '__none' : m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  ch.stderr.on('data', d => { stderr += d; });
  let n = 100;
  return {
    ch, lines, stderr: () => stderr,
    send(obj) { ch.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); },
    req(method, params, id = ++n) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiting.delete(id); reject(new Error(`no reply to ${method} (${id})`)); }, 20000);
        waiting.set(id, m => { clearTimeout(t); resolve(m); });
        this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    // A reply addressed to id null (parse error, invalid request).
    raw(text) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no reply to raw line')), 10000);
        waiting.set(null, m => { clearTimeout(t); resolve(m); });
        this.send(text);
      });
    },
    close() { ch.stdin.end(); return new Promise(r => ch.on('exit', code => r(code))); },
  };
}
const meta = (v = '2026-07-28') => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = r => (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '';

(async () => {
  try {
    // ---- legacy handshake ----
    let s = server();
    let r = await s.req('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.310' } });
    check('initialize answers 2025-11-25', r.result && r.result.protocolVersion === '2025-11-25', JSON.stringify(r));
    check('initialize names the server and the tools capability', r.result && r.result.serverInfo.name === 'claude-rotator' && r.result.capabilities.tools);
    check('legacy results carry no resultType', r.result && r.result.resultType === undefined);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    r = await s.req('ping');
    check('ping after notifications/initialized returns {} (the notification got no reply)', r.result && Object.keys(r.result).length === 0 && s.lines.length === 2, s.lines.join(' | '));
    r = await s.req('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old' } });
    check('initialize with an unknown version gets our latest legacy version', r.result && r.result.protocolVersion === '2025-11-25');
    r = await s.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old' } });
    check('initialize with 2025-06-18 keeps 2025-06-18', r.result && r.result.protocolVersion === '2025-06-18');

    // ---- tools/list ----
    r = await s.req('tools/list', {});
    const tools = (r.result && r.result.tools) || [];
    check('tools/list has the three tools in order', tools.map(t => t.name).join(',') === 'rotator_status,rotator_ask,rotator_providers', JSON.stringify(tools.map(t => t.name)));
    check('every tool has a description and an object inputSchema', tools.every(t => t.description.length > 40 && t.inputSchema.type === 'object'));
    check('rotator_ask requires prompt and refuses extra arguments', (() => { const a = tools.find(t => t.name === 'rotator_ask'); return a && a.inputSchema.required.join() === 'prompt' && a.inputSchema.additionalProperties === false; })());
    check('tool definitions carry no run function', tools.every(t => t.run === undefined));

    // ---- rotator_status (dashboard) ----
    r = await s.req('tools/call', { name: 'rotator_status', arguments: {} });
    const st = r.result && r.result.structuredContent;
    check('rotator_status: use next is two (main is maxed out)', st && st.useNext === 'two', text(r));
    check('rotator_status: source is the dashboard', st && st.source === 'dashboard');
    check('rotator_status: text says use next and shows 5h/7d left', /use next: two/.test(text(r)) && /two \(Two\) <two@example.invalid>: 5h 80% left/.test(text(r)), text(r));
    check('rotator_status: per-model cap shown', /Fable 10% left/.test(text(r)));
    check('rotator_status: not-logged-in account flagged', /gone: .*NOT LOGGED IN/.test(text(r)));
    check('rotator_status: no fingerprint, configDir or token fields', !/fp-should-not-show|configDir|credFp|accessToken/.test(JSON.stringify(r)));
    check('rotator_status: token inside an error string is redacted', /\[redacted\]/.test(JSON.stringify(st)) && !JSON.stringify(r).includes(LOGIN_TOKEN));

    // ---- rotator_providers, not installed ----
    r = await s.req('tools/call', { name: 'rotator_providers' });
    check('rotator_providers without app/providers.js says not installed', r.result && !r.result.isError && /providers not installed/.test(text(r)) && r.result.structuredContent.installed === false, JSON.stringify(r));

    // ---- bad input -> JSON-RPC errors ----
    const code = x => x.error && x.error.code;
    check('invalid JSON -> -32700, id null', (await s.raw('{nope')).error.code === -32700);
    check('batch array -> -32600', code(await s.raw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')) === -32600);
    check('missing jsonrpc -> -32600', code(await s.raw('{"id":null,"method":"ping"}')) === -32600);
    check('unknown method -> -32601', code(await s.req('tools/explode', {})) === -32601);
    check('unknown tool -> -32602', code(await s.req('tools/call', { name: 'rm_rf' })) === -32602);
    check('tools/call without a name -> -32602', code(await s.req('tools/call', {})) === -32602);
    check('params as an array -> -32602', code(await s.req('tools/call', [])) === -32602);
    check('rotator_ask without prompt -> -32602', code(await s.req('tools/call', { name: 'rotator_ask', arguments: {} })) === -32602);
    check('rotator_ask with an empty prompt -> -32602', code(await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: '   ' } })) === -32602);
    check('rotator_ask with a number prompt -> -32602', code(await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 5 } })) === -32602);
    check('rotator_ask with an unknown argument -> -32602', code(await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 'x', tools: ['Bash'] } })) === -32602);
    check('rotator_ask with a model id holding a space -> -32602', code(await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 'x', model: 'claude; rm -rf /' } })) === -32602);
    check('rotator_status with arguments -> -32602', code(await s.req('tools/call', { name: 'rotator_status', arguments: { x: 1 } })) === -32602);
    check('arguments as a string -> -32602', code(await s.req('tools/call', { name: 'rotator_status', arguments: 'x' })) === -32602);
    r = await s.req('ping');
    check('server still answers after bad input', r.result && !r.error);
    check('stdin closed -> server exits 0', (await s.close()) === 0);

    // ---- modern (2026-07-28) ----
    s = server();
    r = await s.req('server/discover', meta());
    check('server/discover lists 2026-07-28 and 2025-11-25', r.result && r.result.supportedVersions.includes('2026-07-28') && r.result.supportedVersions.includes('2025-11-25'), JSON.stringify(r));
    check('server/discover: resultType complete, tools capability, serverInfo in _meta', r.result && r.result.resultType === 'complete' && r.result.capabilities.tools && r.result._meta['io.modelcontextprotocol/serverInfo'].name === 'claude-rotator');
    r = await s.req('tools/list', meta());
    check('modern tools/list without initialize: resultType complete + 3 tools', r.result && r.result.resultType === 'complete' && r.result.tools.length === 3);
    r = await s.req('tools/list', meta('2099-01-01'));
    check('unsupported version -> -32022 with supported + requested', r.error && r.error.code === -32022 && r.error.data.supported.includes('2026-07-28') && r.error.data.requested === '2099-01-01', JSON.stringify(r));
    r = await s.req('ping', meta());
    check('modern ping', r.result && r.result.resultType === 'complete');

    // ---- rotator_ask via the gateway ----
    gatewayOn();
    r = await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 'say hi', system: 'be brief' }, ...meta() });
    let a = r.result && r.result.structuredContent;
    check('rotator_ask via gateway: answer + account two', a && a.via === 'gateway' && a.servedBy.kind === 'account' && a.servedBy.name === 'two' && /gateway says hi/.test(a.text), JSON.stringify(r));
    check('rotator_ask via gateway: sent the gateway key, default model, system, prompt', gwSeen.length === 1 && gwSeen[0].key === GW_KEY && gwSeen[0].body.model === 'claude-sonnet-5-5' && gwSeen[0].body.system === 'be brief' && gwSeen[0].body.messages[0].content === 'say hi', JSON.stringify(gwSeen));
    check('rotator_ask via gateway: the key echoed in the answer is redacted', !JSON.stringify(r).includes(GW_KEY) && /\[redacted\]/.test(text(r)));
    check('rotator_ask result is modern (resultType) and not an error', r.result.resultType === 'complete' && r.result.isError === false);
    r = await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 'hi', model: 'fireworks:accounts/fireworks/models/kimi-k3' } });
    a = r.result && r.result.structuredContent;
    check('rotator_ask: a provider answer names the provider', a && a.servedBy.kind === 'provider' && a.servedBy.name === 'fireworks' && /served by provider fireworks/.test(text(r)), JSON.stringify(r));
    gwMode = 'down';
    r = await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 'hi' } });
    check('rotator_ask: gateway 503 -> isError result naming the reason', r.result && r.result.isError === true && /503.*no account with headroom/.test(text(r)), JSON.stringify(r));

    // ---- cancellation ----
    gwMode = 'slow';
    const before = s.lines.length;
    s.send({ jsonrpc: '2.0', id: 'slow-1', method: 'tools/call', params: { name: 'rotator_ask', arguments: { prompt: 'wait' } } });
    await sleep(800);
    s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow-1', reason: 'test' } });
    await sleep(500);
    r = await s.req('ping');
    check('cancelled call sends nothing more; the server keeps serving', r.result && s.lines.slice(before).every(l => !l.includes('slow-1')), s.lines.slice(before).join(' | '));
    gwMode = 'account';

    // ---- rotator_ask via ccr run (no gateway) ----
    gatewayOff();
    r = await s.req('tools/call', { name: 'rotator_ask', arguments: { prompt: 'from stdin please', model: 'claude-haiku-5-5', system: 'sys' } });
    a = r.result && r.result.structuredContent;
    const call = fs.existsSync(path.join(T, 'claude-call.txt')) ? fs.readFileSync(path.join(T, 'claude-call.txt'), 'utf8') : '';
    check('rotator_ask via ccr run: answer, account two', a && a.via === 'ccr run' && a.servedBy.name === 'two' && /cli says hi/.test(a.text), JSON.stringify(r) + ' ' + s.stderr().slice(-400));
    check('ccr run got the prompt on stdin, not in argv', /STDIN:from stdin please/.test(call) && !/ARGS:.*from stdin/.test(call), call);
    check('ccr run is isolated: no tools, no MCP, restricted, safe mode, no session', ['[-p]', '[--tools][]', '[--strict-mcp-config]', '[--restricted]', '[--safe-mode]', '[--no-session-persistence]', '[--model][claude-haiku-5-5]', '[--system-prompt][sys]'].every(f => call.includes(f)), call);
    check('ccr run used account two\'s dir and dropped CLAUDECODE', call.includes(`DIR:${path.join(HOME, '.claude-accounts', 'two')}`) && call.includes('CLAUDECODE:unset'), call);
    check('ccr run: the inference token claude echoed is redacted', !JSON.stringify(r).includes(INF_TOKEN) && /\[redacted\]/.test(a.text));
    await s.close();

    // ---- rotator_status fallback: dashboard down -> poll-once ----
    writeCfg(DEAD);
    s = server();
    r = await s.req('tools/call', { name: 'rotator_status', arguments: {}, ...meta() });
    const st2 = r.result && r.result.structuredContent;
    check('rotator_status falls back to poll-once when the dashboard is down', st2 && st2.source === 'poll-once' && /one-shot poll/.test(text(r)), JSON.stringify(r) + s.stderr().slice(-400));
    check('poll-once fallback reads main at 85% 5h left', st2 && st2.accounts.find(x => x.id === 'main').fiveHour.leftPct === 85, JSON.stringify(st2));
    check('poll-once fallback leaks no login or refresh token', !JSON.stringify(r).includes(LOGIN_TOKEN) && !JSON.stringify(r).includes(REFRESH));
    await s.close();
    writeCfg(DASH);

    // ---- rotator_providers with a providers.js (Contract 1 shape) ----
    fs.writeFileSync(path.join(APP, 'providers.js'), `'use strict';
console.log('providers.js loaded'); // noise that must not reach stdout
module.exports = { list: () => [
  { name: 'fireworks', label: 'Fireworks', configured: true, keyHint: '…cdef', model: 'accounts/fireworks/models/kimi-k3', enabled: true, apiKey: ${JSON.stringify(PROVIDER_KEY)} },
  { name: 'openrouter', label: 'OpenRouter', configured: false, keyHint: null, model: 'moonshotai/kimi-k3', enabled: true },
  { name: 'anthropic', label: 'Anthropic API', configured: false, keyHint: null, model: 'claude-sonnet-5-5', enabled: false }],
  // Same defaults as the real config(): on, Fireworks > OpenRouter > Anthropic, for a config with no "fallback" key.
  config: () => ({ enabled: true, order: ['fireworks', 'openrouter', 'anthropic'], models: {}, ...(require('./lib').loadConfig().fallback || {}) }) };
`);
    s = server();
    r = await s.req('tools/call', { name: 'rotator_providers', arguments: {} });
    check('rotator_providers reads the fallback from config(): no "fallback" key reads as on, default order', /fallback: on, order fireworks > openrouter > anthropic/.test(text(r)), text(r));
    await s.close();
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'accounts.json'), 'utf8'));
    cfg.fallback = { enabled: false, order: ['openrouter', 'fireworks', 'anthropic'] };
    fs.writeFileSync(path.join(DATA, 'accounts.json'), JSON.stringify(cfg));
    s = server();
    r = await s.req('tools/call', { name: 'rotator_providers', arguments: {} });
    check('rotator_providers shows a saved fallback setting', /fallback: off, order openrouter > fireworks > anthropic/.test(text(r)), text(r));
    await s.close();
    cfg.fallback = { enabled: true, order: ['fireworks', 'openrouter', 'anthropic'], models: {} };
    fs.writeFileSync(path.join(DATA, 'accounts.json'), JSON.stringify(cfg));
    s = server();
    r = await s.req('tools/call', { name: 'rotator_providers', arguments: {} });
    const pv = r.result && r.result.structuredContent;
    check('rotator_providers lists the providers and the fallback order', pv && pv.installed && pv.providers.length === 3 && pv.fallback.order.join() === 'fireworks,openrouter,anthropic' && /fallback: on, order fireworks > openrouter > anthropic/.test(text(r)), JSON.stringify(r));
    check('rotator_providers shows key set / no key, never the key or its hint', /fireworks \(Fireworks\): key set/.test(text(r)) && !JSON.stringify(r).includes(PROVIDER_KEY) && !JSON.stringify(r).includes('cdef'));
    check('a module that prints on load does not corrupt stdout', s.lines.every(l => { try { return JSON.parse(l).jsonrpc === '2.0'; } catch (_) { return false; } }) && /providers.js loaded/.test(s.stderr()));
    await s.close();

    // ---- whole-run checks ----
    check('every stdout line of every run is one JSON-RPC message', allStdout.every(l => { try { return JSON.parse(l).jsonrpc === '2.0'; } catch (_) { return false; } }));
    const leaked = SECRETS.filter(x => allStdout.some(l => l.includes(x)));
    check('no planted token or key appears anywhere on stdout', leaked.length === 0, leaked.map(x => x.slice(0, 12) + '...').join(', '));
  } catch (e) {
    fails++; console.log('FAIL test runner: ' + (e.stack || e.message));
  } finally {
    dash.close(); gw.close(); api.close();
    if (process.env.KEEP) console.log('kept ' + T); else fs.rmSync(T, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails ? 1 : 0);
  }
})();
