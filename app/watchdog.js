'use strict';
/*
 * Liveness check for the optional gateway (installed with `install.sh --with-gateway`, runs every
 * 30 minutes). By default it makes NO model call: it checks GET /healthz, then sends the key with a
 * deliberately malformed POST /v1/messages and expects the gateway's own 400 "bad json" answer, which
 * proves the process is up, the key matches and routing works. It also counts accounts with credentials.
 * With WATCHDOG_DEEP=1 it instead refreshes near-expiry logins and makes one real ~10-token call through
 * the gateway (one model call per run). Alerts only on a SUSTAINED failure (2 consecutive strikes, so a
 * transient blip does not alert). Recovery sends one "recovered" note.
 *
 * Alerts always go to stdout (the service log). If ALERT_WEBHOOK is set, the alert is also POSTed there
 * as JSON {"text": "..."}, which Slack and Discord incoming webhooks accept.
 * Env: CLAUDE_USAGE_GATEWAY_KEY and CLAUDE_USAGE_GATEWAY_PORT (read from the gateway env file when unset),
 *      ALERT_WEBHOOK (optional), WATCHDOG_DEEP=1 (optional), CLAUDE_USAGE_WATCHDOG_MODEL (deep mode only,
 *      default: the latest Haiku).
 * State: $CLAUDE_USAGE_DATA/state/watchdog.json (strike count + last status).
 */
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const ENV_FILE = process.env.CLAUDE_USAGE_GATEWAY_ENV || path.join(L.DATA, 'secrets', 'gateway.env');
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (_) {}

const GW = process.env.CLAUDE_USAGE_GATEWAY_LOCAL || `http://127.0.0.1:${process.env.CLAUDE_USAGE_GATEWAY_PORT || 7799}`;
const KEY = process.env.CLAUDE_USAGE_GATEWAY_KEY || '';
const WEBHOOK = process.env.ALERT_WEBHOOK || '';
const MODEL = process.env.CLAUDE_USAGE_WATCHDOG_MODEL || L.REFRESH_MODEL;
const STATE = path.join(L.STATE_DIR, 'watchdog.json');
const STRIKES_TO_ALERT = 2;

function log(...a) { console.log(new Date().toISOString(), ...a); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { strikes: 0, alerted: false }; } }
function saveState(s) { fs.mkdirSync(L.STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); }

async function alert(text) {
  log('ALERT', text);
  if (!WEBHOOK) return;
  try {
    const r = await fetch(WEBHOOK, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) log('alert webhook HTTP', r.status);
  } catch (e) { log('alert webhook failed', e.message); }
}

const DEEP = process.env.WATCHDOG_DEEP === '1';

async function shallowCheck() {
  const h = await fetch(`${GW}/healthz`, { signal: AbortSignal.timeout(10000) });
  if (h.status !== 200) return `healthz HTTP ${h.status}`;
  const r = await fetch(`${GW}/v1/messages`, {
    method: 'POST', headers: { 'x-gateway-key': KEY, 'content-type': 'application/json' },
    body: '{', signal: AbortSignal.timeout(10000),
  });
  if (r.status === 401) return 'gateway rejects the key in gateway.env (HTTP 401)';
  if (r.status !== 400) return `unexpected HTTP ${r.status} to a malformed request`;
  return '';
}

async function deepCheck(cfg) {
  for (const acct of cfg.accounts) {
    const creds = L.readCredentials(acct);
    if (creds) { try { L.refreshIfStale(acct, creds); } catch (_) {} }
  }
  const r = await fetch(`${GW}/v1/messages`, {
    method: 'POST',
    headers: { 'x-gateway-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 200 && Array.isArray(body.content)) return '';
  return `HTTP ${r.status} ${(body.error && body.error.message) || ''}`.slice(0, 160);
}

async function main() {
  const cfg = L.loadConfig();
  let withCreds = 0;
  for (const acct of cfg.accounts) {
    if (L.readCredentials(acct) || L.inferenceToken(acct.id)) withCreds++;
    else log(`account ${acct.id}: NO CREDENTIALS`);
  }
  let detail = '';
  try { detail = DEEP ? await deepCheck(cfg) : await shallowCheck(); }
  catch (e) { detail = 'gateway unreachable: ' + e.message.slice(0, 120); }
  // A gateway that answers but has no account to serve from is down for every caller.
  if (!detail && withCreds === 0) detail = `no account has credentials (0/${cfg.accounts.length}): log in with ccr <id>, or add a setup-token`;
  const ok = !detail;

  const st = loadState();
  if (ok) {
    log(`OK (${DEEP ? 'deep' : 'http'} check): gateway live, ${withCreds}/${cfg.accounts.length} accounts have credentials`);
    if (st.alerted) await alert(`claude-rotator gateway RECOVERED: live again (${withCreds}/${cfg.accounts.length} accounts). [watchdog]`);
    saveState({ strikes: 0, alerted: false, lastOk: new Date().toISOString() });
  } else {
    const strikes = (st.strikes || 0) + 1;
    log(`FAIL (strike ${strikes}/${STRIKES_TO_ALERT}): ${detail}`);
    if (strikes >= STRIKES_TO_ALERT && !st.alerted) {
      await alert(`claude-rotator gateway DOWN (${strikes} consecutive checks): ${detail}. [watchdog]`);
      saveState({ strikes, alerted: true, lastFail: new Date().toISOString(), detail });
    } else {
      saveState({ strikes, alerted: st.alerted, lastFail: new Date().toISOString(), detail });
    }
  }
}
main().catch(e => { log('watchdog error', e.message); process.exit(0); });
