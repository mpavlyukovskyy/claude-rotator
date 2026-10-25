'use strict';
// Test-only stand-in for app/providers.js and its dashboard routes (Contract 1), so the setup UI can be tested
// before the real module is merged. ui.test.sh and ui-browser.js copy app/ to a temp dir, drop this file in as
// providers.js, and add one line after "// --- end setup UI routes ---" in server.js that calls fakeRoutes().
// Keys live in DATA/secrets/providers.json like the real thing. test() never calls the network: a key that
// starts with "good" passes, anything else fails.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const FILE = path.join(L.DATA, 'secrets', 'providers.json');
const META = {
  fireworks: { label: 'Fireworks', model: 'accounts/fireworks/models/kimi-k3' },
  openrouter: { label: 'OpenRouter', model: 'moonshotai/kimi-k3' },
  anthropic: { label: 'Anthropic API', model: 'claude-sonnet-5-5' },
};
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } };
const write = j => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(j, null, 2), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); };
// Same defaults as the real config(): fallback on, Fireworks, OpenRouter, then the Anthropic API.
const fallback = () => ({ enabled: true, order: Object.keys(META), models: {}, ...(L.loadConfig().fallback || {}) });

function list() {
  const keys = read(), fb = fallback();
  return Object.entries(META).map(([name, m]) => {
    const k = keys[name] && keys[name].apiKey;
    return { name, label: m.label, configured: !!k, keyHint: k ? '…' + k.slice(-4) : null, model: fb.models[name] || m.model, enabled: !!k };
  });
}
function setKey(name, apiKey) { const j = read(); j[name] = { apiKey }; write(j); }
function removeKey(name) { const j = read(); delete j[name]; write(j); }
async function test(name) {
  const k = (read()[name] || {}).apiKey;
  if (!k) return { ok: false, ms: 0, model: META[name].model, error: 'no key saved' };
  return k.startsWith('good') ? { ok: true, ms: 42, model: META[name].model } : { ok: false, ms: 40, model: META[name].model, error: 'HTTP 401: invalid API key' };
}

// Returns [status, body] for a provider route, or null for any other path.
async function fakeRoutes(req, u, { requireUiToken, readJson, NO_TOKEN }) {
  if (u.pathname === '/api/providers' && req.method === 'GET') return [200, { providers: list(), fallback: fallback() }];
  const m = u.pathname.match(/^\/api\/providers\/([a-z]+)(\/test)?$/);
  if (m) {
    if (!requireUiToken(req)) return [403, NO_TOKEN];
    if (!META[m[1]]) return [404, { error: `unknown provider "${m[1]}"` }];
    if (m[2] && req.method === 'POST') return [200, await test(m[1])];
    if (req.method === 'DELETE') { removeKey(m[1]); return [200, { ok: true }]; }
    if (req.method === 'POST') {
      const { apiKey } = await readJson(req);
      if (typeof apiKey !== 'string' || apiKey.trim().length < 8) return [400, { error: 'that does not look like an API key' }];
      setKey(m[1], apiKey.trim()); return [200, { ok: true }];
    }
    return null;
  }
  if (u.pathname === '/api/fallback' && req.method === 'POST') {
    if (!requireUiToken(req)) return [403, NO_TOKEN];
    const b = await readJson(req);
    const raw = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
    raw.fallback = { ...fallback(), ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}), ...(Array.isArray(b.order) ? { order: b.order } : {}) };
    fs.writeFileSync(L.CONFIG_PATH + '.tmp', JSON.stringify(raw, null, 2)); fs.renameSync(L.CONFIG_PATH + '.tmp', L.CONFIG_PATH);
    return [200, { ok: true, fallback: raw.fallback }];
  }
  return null;
}

module.exports = { list, config: fallback, setKey, removeKey, test, fakeRoutes };
